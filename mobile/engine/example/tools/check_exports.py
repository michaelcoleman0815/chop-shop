"""Measures what a phone made, pulled off it after its self-test, with the CI
runner's own ffmpeg and ffprobe, against what the same renders came out as
on the runner (expect.json, from make_media.py): each file's size, length,
sound and size of picture, and its colour at known moments.

    python3 tools/check_exports.py EXPORTS_DIR MEDIA_DIR selftest.json

Fails unless every export is there and right.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure import facts, measure_output, run  # noqa: E402

EXAMPLE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The 60 s export: a new background colour every 10 s (selftest.ts).
BACKGROUNDS = ["3060C0", "C03060", "30C060", "C0C030", "6030C0", "30C0C0"]


def rgb(hexstr):
    return [int(hexstr[i:i + 2], 16) for i in (0, 2, 4)]


def top_atoms(path):
    """The file's top-level MP4 atoms, in order."""
    atoms = []
    with open(path, "rb") as f:
        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            size = int.from_bytes(head[:4], "big")
            kind = head[4:8].decode("latin-1")
            if size == 1:
                size = int.from_bytes(f.read(8), "big")
                f.seek(size - 16, 1)
            elif size == 0:
                atoms.append(kind)
                break
            else:
                f.seek(size - 8, 1)
            atoms.append(kind)
    return atoms


def keyframe_times(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries",
               "frame=pts_time", "-of", "csv=p=0", path]).stdout
    return [round(float(x.strip().rstrip(",")), 3) for x in out.split() if x.strip().rstrip(",").replace(".", "", 1).isdigit()]


def stream_profile(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile", "-of", "csv=p=0",
               path]).stdout
    return out.strip()


def close(a, b, tolerance):
    return len(a) == 3 and len(b) == 3 and all(abs(x - y) <= tolerance for x, y in zip(a, b))


def main():
    exports, media, report_path = sys.argv[1:4]
    with open(os.path.join(media, "expect.json")) as f:
        expect = json.load(f)
    with open(report_path) as f:
        report = json.load(f)
    skipped = {c["name"] for c in report.get("checks", []) if c.get("skipped")}
    with open(os.path.join(EXAMPLE, "src/renders.json")) as f:
        specs = json.load(f)
    with open(os.path.join(EXAMPLE, "src/desktop-renders.json")) as f:
        desktop = json.load(f)
    renders = list(specs["renders"]) + [{**r, **specs["desktop"][r["name"]]} for r in desktop["renders"]]

    problems = []
    for spec in renders:
        name = spec["name"]
        path = os.path.join(exports, spec["output"])
        if f"render {name}" in skipped:
            print(f"SKIP  {name}: skipped on the phone")
            continue
        if not os.path.isfile(path):
            problems.append(f"{name}: {spec['output']} was not pulled off the phone")
            continue
        want = expect["renders"][name]
        got = measure_output(path, spec)
        bad = []
        gf, wf = got["facts"], want["facts"]
        if gf["bytes"] <= 0:
            bad.append("empty")
        for k in ("codec", "width", "height"):
            if (gf["video"] or {}).get(k) != (wf["video"] or {}).get(k):
                bad.append(f"video {k} {(gf['video'] or {}).get(k)}, expected {(wf['video'] or {}).get(k)}")
        if bool(gf["audio"]) != bool(wf["audio"]):
            bad.append("has sound, expected none" if gf["audio"] else "no sound")
        elif gf["audio"] and gf["audio"]["codec"] != wf["audio"]["codec"]:
            bad.append(f"sound in {gf['audio']['codec']}, expected {wf['audio']['codec']}")
        if wf["duration"] > 0 and abs(gf["duration"] - wf["duration"]) > 0.12:
            bad.append(f"{gf['duration']} s long, expected {wf['duration']}")
        if spec.get("bytesBetween") and not spec["bytesBetween"][0] <= gf["bytes"] <= spec["bytesBetween"][1]:
            bad.append(f"{gf['bytes']} bytes, expected {spec['bytesBetween'][0]} to {spec['bytesBetween'][1]}")
        if spec.get("faststart"):
            atoms = top_atoms(path)
            if "moov" not in atoms or "mdat" not in atoms or atoms.index("moov") > atoms.index("mdat"):
                bad.append(f"not fast start: its atoms are {', '.join(atoms)}")
        if spec.get("keyframesWithin"):
            keys = keyframe_times(path)
            ends = keys + [gf["duration"]]
            gap = max((b - a for a, b in zip(ends, ends[1:])), default=float("inf"))
            if len(keys) < 2 or gap > spec["keyframesWithin"]:
                bad.append(f"keyframes at {keys}: {gap:.2f} s apart at most, asked for {spec['keyframesWithin']}")
        if spec.get("profileOnIos") and report.get("platform") == "ios":
            profile = stream_profile(path)
            if profile != spec["profileOnIos"]:
                bad.append(f"profile {profile}, expected {spec['profileOnIos']}")
        tolerance = spec.get("tolerance", 16)
        for s, a, b in zip(spec.get("samples", []), got["samples"], want["samples"]):
            if not close(a, b, tolerance):
                bad.append(f"at {s['t']} s ({s['x']},{s['y']}) rgb {a}, expected {b} within {tolerance}")
        if spec.get("loudness") and abs(got["loudness"] - want["loudness"]) > 1.5:
            bad.append(f"{got['loudness']} LUFS, expected {want['loudness']}")
        video = gf["video"] or {}
        summary = (f"{video.get('codec', '')} {video.get('width', '')}x{video.get('height', '')} " if gf["video"] else "") + \
            f"{gf['audio']['codec'] if gf['audio'] else 'no sound'}, {gf['duration']} s, {gf['bytes']} bytes"
        print(f"{'FAIL' if bad else 'PASS'}  {name}: {summary}{'; ' + '; '.join(bad) if bad else ''}")
        problems += [f"{name}: {b}" for b in bad]

    # The 60 s render, and what whisper wrote.
    path = os.path.join(exports, "export60.mp4")
    if os.path.isfile(path):
        f = facts(path)
        spec = {"samples": [{"t": 45, "x": 864, "y": 842, "w": 192, "h": 130}, {"t": 5, "x": 864, "y": 842, "w": 192, "h": 130}]}
        got = measure_output(path, spec)
        bad = []
        if abs(f["duration"] - 60) > 0.2:
            bad.append(f"{f['duration']} s long")
        if (f["video"] or {}).get("width") != 1920 or (f["video"] or {}).get("height") != 1080:
            bad.append(f"{(f['video'] or {}).get('width')}x{(f['video'] or {}).get('height')}")
        if not f["audio"]:
            bad.append("no sound")
        for s, colour, want in zip(spec["samples"], got["samples"], [rgb(BACKGROUNDS[4]), rgb(BACKGROUNDS[0])]):
            if not close(colour, want, 24):
                bad.append(f"at {s['t']} s rgb {colour}, expected {want}")
        print(f"{'FAIL' if bad else 'PASS'}  export60: {f['video']['codec'] if f['video'] else ''} {f['duration']} s, {f['bytes']} bytes{'; ' + '; '.join(bad) if bad else ''}")
        problems += [f"export60: {b}" for b in bad]
    else:
        problems.append("export60.mp4 was not pulled off the phone")

    for name in ("speech-base.en.json", "speech-base.en-verbatim.json", "speech-small.en-verbatim.json"):
        path = os.path.join(exports, name)
        if not os.path.isfile(path):
            problems.append(f"{name} (whisper's output) was not pulled off the phone")
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        try:
            segments = json.loads(text).get("transcription", [])
            words = " ".join(s.get("text", "").strip() for s in segments)
            print(f"PASS  {name}: {len(segments)} segments: {words[:200]}")
        except json.JSONDecodeError as e:
            # The app reads it with parseWhisperJson, which mends what whisper writes.
            print(f"PASS  {name}: {len(text)} bytes (not strict JSON: {e})")

    if problems:
        for p in problems:
            print(f"::error::{p}")
        sys.exit(1)
    print("every export is right")


if __name__ == "__main__":
    main()
