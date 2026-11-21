"""Makes the footage the app's own flow in CI picks (src/host/drive.ts), with
the runner's ffmpeg, and the plan the app follows:

- Talking.mp4: a landscape camera recording, 1920x1080 at 30 fps, of the
  speech in src/main/learn-fixtures/talk.m4a (espeak, with a retake in
  it), up to a pause, so whisper has real words to find.
- B-roll.mp4: six seconds of a moving picture with nothing but room tone.
- drive.json: those two files, what the person asks for, and the command.

    python3 ci/make-footage.py OUT_DIR

Nothing it makes is committed: it is all made again on every run.
"""
import json
import os
import subprocess
import sys

OUT = os.path.abspath(sys.argv[1])
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "..", "src", "main", "learn-fixtures")

# Where the speech pauses after "anything.", 27.05 s in: a cut between sentences.
TALK_SEC = 27.4
BROLL_SEC = 6

PLAN = {
    "files": ["Talking.mp4", "B-roll.mp4"],
    "request": "Make this into a video for my channel.",
    "command": "/shorts",
    "talkingSec": TALK_SEC,
}


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args], check=True)


H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30"]
AAC = ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"]


def main():
    os.makedirs(OUT, exist_ok=True)
    ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
       "-i", os.path.join(FIXTURES, "talk.m4a"),
       "-map", "0:v", "-map", "1:a", "-t", str(TALK_SEC), *H264, *AAC, os.path.join(OUT, "Talking.mp4"))
    ff("-f", "lavfi", "-i",
       "life=size=320x180:rate=30:mold=10:ratio=0.1:life_color=#c8e6ff:death_color=#1c2b3a,"
       "scale=1920:1080:flags=neighbor,format=yuv420p",
       "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.004:sample_rate=48000",
       "-map", "0:v", "-map", "1:a", "-t", str(BROLL_SEC), *H264, *AAC, os.path.join(OUT, "B-roll.mp4"))
    with open(os.path.join(OUT, "drive.json"), "w") as f:
        json.dump(PLAN, f, indent=1)
    for name in PLAN["files"]:
        print(f"{name}: {os.path.getsize(os.path.join(OUT, name))} bytes")


main()
