"""Checks what the app's own flow in CI did (src/host/drive.ts), on the
runner, with its ffprobe and ffmpeg: every step reached, a new version from
the command, and the export itself, a vertical H.264 video with AAC sound
the length of the talking less what was cut, speech in it, and a picture
that is not black.

    python3 ci/check-drive.py OUT_DIR FOOTAGE_DIR

OUT_DIR is what ci/android-drive.sh or ci/ios-drive.sh pulled from the app.
Prints what it found and exits non-zero on the first thing that is wrong.
"""
import json
import os
import re
import subprocess
import sys

OUT = sys.argv[1]
FOOTAGE = sys.argv[2]
STEPS = ["start", "composer", "transcribing", "v1", "command", "editor", "exporting", "exported", "export-in-chat"]

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


with open(os.path.join(FOOTAGE, "drive.json")) as f:
    plan = json.load(f)
report_path = os.path.join(OUT, "drive-report.json")
if not os.path.exists(report_path):
    sys.exit("::error::no drive-report.json came back from the app")
with open(report_path) as f:
    report = json.load(f)

print(f"platform: {report.get('platform')}, ffmpeg {report.get('ffmpeg')}, whisper {report.get('whisper')}")
print(f"encoders: {', '.join(report.get('encoders', []))}")
print(f"took {report.get('seconds')} s; v1 after {report.get('secondsToV1')} s; export in {report.get('secondsToExport')} s")
for s in report.get("steps", []):
    print(f"  step {s['n']} {s['name']} at {s['atSec']} s{'' if s.get('acknowledged') else ' (no screenshot taken)'}")
for p in report.get("progress", []):
    print(f"  {p['atSec']:>7} s  {p['stage']}")
for e in report.get("errors", []):
    print(f"  console: {e}")

if not report.get("ok"):
    problem(f"the flow stopped: {report.get('failed')}")
    for r in report.get("replies", []):
        print(f"  reply: {r}")
reached = [s["name"] for s in report.get("steps", [])]
missing = [s for s in STEPS if s not in reached]
if missing:
    problem(f"steps not reached: {', '.join(missing)}")

for r in report.get("repliesAfterFootage", []):
    print(f"  after the footage: {r}")
print(f"  versions: {report.get('versionsAfterCommand') or report.get('versionsAfterFootage')}")
print(f"  {plan['command']}: {report.get('replyToCommand')}")
print(f"  toast: {report.get('toast')}")
before = report.get("versionsAfterFootage") or []
after = report.get("versionsAfterCommand") or []
if report.get("ok") and len(after) <= len(before):
    problem(f"{plan['command']} made no new version")

exports_dir = os.path.join(OUT, "Exports")
videos = sorted(n for n in (os.listdir(exports_dir) if os.path.isdir(exports_dir) else []) if n.endswith(".mp4"))
print(f"  exports: {sorted(os.listdir(exports_dir)) if os.path.isdir(exports_dir) else 'none'}")
if not videos:
    problem("no export came back")
else:
    path = os.path.join(exports_dir, videos[-1])
    facts = probe(path)
    v = next((s for s in facts["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in facts["streams"] if s["codec_type"] == "audio"), None)
    length = float(facts["format"]["duration"])
    print(f"{videos[-1]}: {length:.2f} s, {int(facts['format'].get('bit_rate', 0)) // 1000} kb/s")
    if v:
        print(f"  video: {v['codec_name']} {v.get('profile')} {v['width']}x{v['height']} {v.get('pix_fmt')} {v.get('r_frame_rate')}")
    if a:
        print(f"  audio: {a['codec_name']} {a.get('sample_rate')} Hz, {a.get('channels')} channels")
    if not v or v["codec_name"] != "h264":
        problem(f"the export's video is {v and v['codec_name']}, not H.264")
    elif (v["width"], v["height"]) != (1080, 1920):
        problem(f"the export is {v['width']}x{v['height']}, not 1080x1920 after {plan['command']}")
    if v and v.get("pix_fmt") != "yuv420p":
        problem(f"the export's pixels are {v.get('pix_fmt')}, not yuv420p")
    if not a or a["codec_name"] != "aac":
        problem(f"the export's sound is {a and a['codec_name']}, not AAC")
    talking = float(plan.get("talkingSec", 30))
    if not 5 <= length <= talking + 1:
        problem(f"the export runs {length:.2f} s; the talking is {talking} s")
    if a:
        loud = ffmpeg_lines(path, "-map", "0:a:0", "-af", "volumedetect")
        mean = re.search(r"mean_volume: (-?[\d.]+) dB", loud)
        print(f"  mean volume: {mean and mean[1]} dB")
        if not mean or float(mean[1]) < -40:
            problem("the export has no speech in it")
    black = ffmpeg_lines(path, "-map", "0:v:0", "-vf", "blackdetect=d=0.5:pix_th=0.05")
    dark = sum(float(m) for m in re.findall(r"black_duration:([\d.]+)", black))
    print(f"  black: {dark:.2f} s")
    if dark > length / 2:
        problem(f"the export is black for {dark:.2f} s of {length:.2f} s")
    beside = [n for n in os.listdir(exports_dir) if n.startswith(videos[-1][:-4]) and n != videos[-1]]
    print(f"  beside it: {beside or 'nothing'}")

shots = sorted(os.listdir(os.path.join(OUT, "screens"))) if os.path.isdir(os.path.join(OUT, "screens")) else []
print(f"screenshots: {', '.join(shots) or 'none'}")
if not shots:
    problem("no screenshots were taken")

sys.exit(1 if problems else 0)
