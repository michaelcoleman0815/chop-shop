"""Prints a phone's self-test report (selftest.json) and fails unless it is
whole and every check in it passed.

    python3 tools/check_report.py selftest.json

A report is whole when it has every check the self-test makes: the renders
in src/renders.json and src/desktop-renders.json and the checks named below,
so a check that stops running fails here instead of disappearing.
"""
import json
import os
import sys

EXAMPLE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ALWAYS = [
    "info",
    "ffmpeg build (stdout as on the command line)",
    "probes at once",
    "whisper base.en on speech.wav",
    "whisper verbatim (-ojf, prompt, --dtw)",
    "cancel a long render",
    "make a 60 s 1080p recording (hardware encoder)",
    "render 60 s of 1080p (captions, logo, loudness, hardware encoder)",
    "preview: play and seek a local file in the WebView",
    "preview: seek deep into the 60 s export (range requests)",
    "saveToPhotos",
    "the importer copies a file in whole",
]

# A device may lack these; the check then says so and is skipped.
MAY_SKIP = {"render encode-hevc"}


def expected_checks():
    with open(os.path.join(EXAMPLE, "src/renders.json")) as f:
        specs = json.load(f)
    with open(os.path.join(EXAMPLE, "src/desktop-renders.json")) as f:
        desktop = json.load(f)
    names = list(ALWAYS)
    names += [f"render {r['name']}" for r in specs["renders"]]
    names += [f"render {r['name']}" for r in desktop["renders"]]
    return names


def main():
    with open(sys.argv[1]) as f:
        report = json.load(f)
    print(json.dumps(report, indent=1))
    print()

    problems = []
    if report.get("crashed"):
        problems.append(f"the self-test could not finish: {report['crashed']}")
    checks = report.get("checks", [])
    width = max((len(c["name"]) for c in checks), default=10)
    for c in checks:
        state = "SKIP" if c.get("skipped") else ("PASS" if c["ok"] else "FAIL")
        print(f"{state}  {c['name']:<{width}}  {c['ms'] / 1000:7.2f} s  {c['detail']}")
        if not c["ok"]:
            problems.append(f"{c['name']}: {c['detail']}")
        if c.get("skipped") and c["name"] not in MAY_SKIP:
            problems.append(f"{c['name']} was skipped: {c['detail']}")
    seen = {c["name"] for c in checks}
    for name in expected_checks():
        if name not in seen:
            problems.append(f"{name}: not in the report")

    print()
    print(f"device: {json.dumps(report.get('device'))}")
    info = report.get("info") or {}
    print(f"ffmpeg {info.get('ffmpegVersion')}, whisper {info.get('whisperVersion')}, encoders: {', '.join(info.get('encoders', []))}")
    print("numbers:")
    for key, value in (report.get("numbers") or {}).items():
        print(f"  {key}: {value}")
    print(f"{report.get('passed', 0)} passed, {report.get('failed', 0)} failed, {report.get('skipped', 0)} skipped in {report.get('ms', 0) / 1000:.0f} s")

    if problems:
        print()
        for p in problems:
            print(f"::error::{p}")
        sys.exit(1)
    print("every check passed")


if __name__ == "__main__":
    main()
