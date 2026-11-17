"""Checks what the app's own flow in CI did (src/host/drive.ts), on the
runner, with its ffprobe and ffmpeg: every step of the flow and of the dark
tour reached, the key gate both ways (Start without a key is the steps to
get one, a key Anthropic turns down marks the step that fixes it, one it
takes opens Start, and in the tour a key accepted before keeps the gate open
while Anthropic is down), the editor's preview with a picture whether it was
opened from the chat or from Start's card, a new version from the command,
the crew at the export, and each export itself, a vertical H.264 video with
AAC sound the length of the talking less what was cut, speech in it, and a
picture that is not black. Also how the page looked and moved: dark or
light, reduced motion, and what the web view had of view transitions.

    python3 ci/check-drive.py OUT_DIR FOOTAGE_DIR

OUT_DIR is what ci/android-drive.sh or ci/ios-drive.sh pulled from the app.
Prints what it found and exits non-zero when something is wrong.
"""
import json
import os
import re
import subprocess
import sys

OUT = sys.argv[1]
FOOTAGE = sys.argv[2]
FLOW = ["key", "key-refused", "start", "composer", "transcribing", "v1", "command", "editor", "exporting",
        "thread-exporting", "export-in-chat", "crew", "brand", "licences"]
TOUR = ["thread-down", "start", "editor", "exporting", "thread-exporting", "thread", "crew", "brand"]

problems = []


def problem(text):
    problems.append(text)
    print(f"::error::{text}")


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def ffmpeg_lines(path, *filters):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path, *filters, "-f", "null", "-"],
                       capture_output=True, text=True)
    return r.stderr


def read_report(name):
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def steps_of(label, report, expected):
    looks = report.get("looks") or {}
    viewport = report.get("viewport") or {}
    print(f"== {label}: took {report.get('seconds')} s at {viewport.get('width')}x{viewport.get('height')}"
          f" ({viewport.get('pixelRatio')}x)")
    print(f"  dark {looks.get('dark')}, reduced motion {looks.get('reducedMotion')}, travel {looks.get('travel')!r},"
          f" view transitions {looks.get('viewTransitions')} (types {looks.get('viewTransitionTypes')})")
    print(f"  {looks.get('userAgent')}")
    for s in report.get("steps", []):
        print(f"  step {s['n']} {s['name']} at {s['atSec']} s{'' if s.get('acknowledged') else ' (no screenshot taken)'}")
        if s.get("screen"):
            print(f"      on screen: {s['screen']}")
    for p in report.get("progress", []):
        print(f"  {p['atSec']:>7} s  {p['stage']}")
    for key in ("crewTranscribing", "crewAtWork"):
        crew = report.get(key)
        if crew:
            print(f"  {key}: {crew.get('rows')}; moving {crew.get('moving')}")
    for t in report.get("transitions", []):
        print(f"  view transition at {t['atSec']} s, {t['form']}: {t.get('threw') or t.get('finished') or 'running'}")
    print(f"  the editor's preview had a picture: {report.get('previewReady')}")
    for deck in report.get("previewDecks", []):
        print(f"    a picture in the frame: {deck}")
    for r in report.get("anthropic", []):
        print(f"  anthropic: {r.get('kind')} {r.get('said')!r} -> {r.get('status')}{' ' + r['route'] if r.get('route') else ''}")
    # A phone's plugins log each call they turn down (a file or a key that is not there yet), so
    # those are many: the rest are shown first, the drive's own notes among them.
    errors = report.get("errors", [])
    turned_down = [e for e in errors if "does not exist" in e or "given key" in e]
    rest = [e for e in errors if e not in turned_down]
    print(f"  console errors: {len(errors)}, {len(turned_down)} of them a plugin turning down a read")
    for e in (rest + turned_down)[:12]:
        print(f"    {e}")
    if not report.get("ok"):
        problem(f"{label} stopped: {report.get('failed')}")
        for r in report.get("replies", []):
            print(f"  reply: {r}")
    reached = [s["name"] for s in report.get("steps", [])]
    missing = [s for s in expected if s not in reached]
    if missing:
        problem(f"{label}: steps not reached: {', '.join(missing)}")
    if report.get("ok") and not (report.get("crewAtWork") or {}).get("rows"):
        problem(f"{label}: no one of the crew was at the export")
    if report.get("ok") and report.get("previewReady") is not True:
        problem(f"{label}: the editor's preview showed no picture")


def check_export(path, plan):
    name = os.path.basename(path)
    facts = probe(path)
    v = next((s for s in facts["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in facts["streams"] if s["codec_type"] == "audio"), None)
    length = float(facts["format"]["duration"])
    print(f"{name}: {length:.2f} s, {int(facts['format'].get('bit_rate', 0)) // 1000} kb/s")
    if v:
        print(f"  video: {v['codec_name']} {v.get('profile')} {v['width']}x{v['height']} {v.get('pix_fmt')} {v.get('r_frame_rate')}")
    if a:
        print(f"  audio: {a['codec_name']} {a.get('sample_rate')} Hz, {a.get('channels')} channels")
    if not v or v["codec_name"] != "h264":
        problem(f"{name}: the video is {v and v['codec_name']}, not H.264")
    elif (v["width"], v["height"]) != (1080, 1920):
        problem(f"{name} is {v['width']}x{v['height']}, not 1080x1920 after {plan['command']}")
    if v and v.get("pix_fmt") != "yuv420p":
        problem(f"{name}: the pixels are {v.get('pix_fmt')}, not yuv420p")
    if not a or a["codec_name"] != "aac":
        problem(f"{name}: the sound is {a and a['codec_name']}, not AAC")
    talking = float(plan.get("talkingSec", 30))
    if not 5 <= length <= talking + 1:
        problem(f"{name} runs {length:.2f} s; the talking is {talking} s")
    if a:
        loud = ffmpeg_lines(path, "-map", "0:a:0", "-af", "volumedetect")
        mean = re.search(r"mean_volume: (-?[\d.]+) dB", loud)
        print(f"  mean volume: {mean and mean[1]} dB")
        if not mean or float(mean[1]) < -40:
            problem(f"{name} has no speech in it")
    black = ffmpeg_lines(path, "-map", "0:v:0", "-vf", "blackdetect=d=0.5:pix_th=0.05")
    dark = sum(float(m) for m in re.findall(r"black_duration:([\d.]+)", black))
    print(f"  black: {dark:.2f} s")
    if dark > length / 2:
        problem(f"{name} is black for {dark:.2f} s of {length:.2f} s")


with open(os.path.join(FOOTAGE, "drive.json")) as f:
    plan = json.load(f)
flow = read_report("drive-report.json")
if flow is None:
    sys.exit("::error::no drive-report.json came back from the app")
print(f"platform: {flow.get('platform')}, ffmpeg {flow.get('ffmpeg')}, whisper {flow.get('whisper')}")
print(f"v1 after {flow.get('secondsToV1')} s; export in {flow.get('secondsToExport')} s")
steps_of("the flow, light", flow, FLOW)
for r in flow.get("repliesAfterFootage", []):
    print(f"  after the footage: {r}")
print(f"  versions: {flow.get('versionsAfterCommand') or flow.get('versionsAfterFootage')}")
print(f"  {plan['command']}: {flow.get('replyToCommand')}")
print(f"  toast: {flow.get('toast')}")
licences = flow.get("licences") or {}
print(f"  licences: {', '.join(licences.get('listed', [])) or 'none'}")
print(f"  source offer: {licences.get('sourceOffer')}")
setup = flow.get("keySetup") or {}
refused = flow.get("keyRefused") or {}
print(f"  without a key, Start's steps: {setup.get('steps')}")
print(f"    pages: {setup.get('pages')}")
print(f"    cost: {setup.get('cost')}")
print(f"  a key turned down: {refused.get('said')!r}, the step marked: {refused.get('marked')!r}")
print(f"    {refused.get('kept')}")
print(f"  a key taken: {flow.get('keyAccepted')!r}")
asked = flow.get("anthropic", [])
checks = [r["status"] for r in asked if r.get("kind") == "key check"]
if flow.get("ok"):
    if len(setup.get("steps") or []) < 3 or not setup.get("cost"):
        problem("without a key, Start did not show the steps to get one and what it costs")
    if checks[:2] != [401, 200]:
        problem(f"the key checks went {checks}, not a key turned down and then one taken")
    if not refused.get("marked"):
        problem("a key turned down marked no step to fix it")
    if not any(r.get("kind") == "triage" for r in asked) or not any(r.get("kind") == "plan" for r in asked):
        problem("the words sent with the footage did not go to Claude, to read and then to plan")
before = flow.get("versionsAfterFootage") or []
after = flow.get("versionsAfterCommand") or []
if flow.get("ok") and len(after) <= len(before):
    problem(f"{plan['command']} made no new version")

tour = read_report("tour-report.json")
if tour is None:
    problem("no tour-report.json came back: the dark tour did not run")
else:
    steps_of("the tour, dark", tour, TOUR)
    if not (tour.get("looks") or {}).get("dark"):
        problem("the web view did not report the system's dark: the tour set the page dark itself")
    down = tour.get("whileDown") or {}
    print(f"  while Anthropic was down: {down}")
    tour_asked = tour.get("anthropic", [])
    if tour.get("ok"):
        if any(r.get("kind") == "key check" for r in tour_asked):
            problem("the tour checked the key again at launch, though Anthropic had accepted it")
        if not any(r.get("status") == 529 for r in tour_asked):
            problem("nothing in the tour met Anthropic down")
        if not (down.get("gateOpen") and down.get("startOpen")):
            problem("with Anthropic down, the gate closed on a key it had accepted")
        if not re.search(r"overloaded|having trouble", str(down.get("reply"))):
            problem(f"with Anthropic down, the answer was {down.get('reply')!r}")

exports_dir = os.path.join(OUT, "Exports")
listed = sorted(os.listdir(exports_dir)) if os.path.isdir(exports_dir) else []
videos = [n for n in listed if n.endswith(".mp4")]
print(f"exports: {listed or 'none'}")
if not videos:
    problem("no export came back")
for video in videos:
    check_export(os.path.join(exports_dir, video), plan)

shots = sorted(os.listdir(os.path.join(OUT, "screens"))) if os.path.isdir(os.path.join(OUT, "screens")) else []
print(f"screenshots: {', '.join(shots) or 'none'}")
if not shots:
    problem("no screenshots were taken")
for name in shots:
    # A screenshot of one flat colour is a blank screen: the page did not draw.
    path = os.path.join(OUT, "screens", name)
    facts = probe(path)["streams"][0]
    stats = ffmpeg_lines(path, "-vf", "signalstats,metadata=print")
    low = re.search(r"YMIN=(\d+)", stats)
    high = re.search(r"YMAX=(\d+)", stats)
    mean = re.search(r"YAVG=([\d.]+)", stats)
    spread = int(high[1]) - int(low[1]) if low and high else None
    print(f"  {name}: {facts['width']}x{facts['height']}, brightness {low and low[1]} to {high and high[1]},"
          f" mean {mean and mean[1]}")
    if spread is not None and spread < 16:
        problem(f"{name} is one flat colour: the screen was blank")

sys.exit(1 if problems else 0)
