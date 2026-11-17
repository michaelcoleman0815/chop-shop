"""Measuring media with a desktop ffmpeg and ffprobe: the facts a probe gives,
the mean colour of a region at a moment, and loudness. make_media.py records
what each test render should come out as with these; check_exports.py
measures what the phone made the same way."""
import json
import re
import subprocess


def run(args, check=True):
    p = subprocess.run(args, capture_output=True, text=True, errors="replace")
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{p.stderr[-3000:]}")
    return p


def probe(path):
    out = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout
    return json.loads(out)


def rotation_of(stream):
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            return int(round(float(side["rotation"])))
    tags = stream.get("tags", {}) or {}
    if "rotate" in tags:
        return -int(tags["rotate"])
    return 0


def facts(path):
    """What the self-test and the runner both check of a file."""
    data = probe(path)
    fmt = data.get("format", {})
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    f = {
        "format": fmt.get("format_name"),
        "duration": round(float(fmt.get("duration", 0) or 0), 3),
        "bytes": int(fmt.get("size", 0) or 0),
        "video": None,
        "audio": None,
    }
    if video:
        f["video"] = {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "pix_fmt": video.get("pix_fmt"),
            "rotation": rotation_of(video),
            "color_transfer": video.get("color_transfer"),
            "color_primaries": video.get("color_primaries"),
        }
    if audio:
        f["audio"] = {
            "codec": audio.get("codec_name"),
            "sample_rate": int(audio.get("sample_rate", 0) or 0),
            "channels": audio.get("channels"),
        }
    return f


MEAN = re.compile(r"mean:\[(\d+) (\d+) (\d+)")


def mean_colour(path, t, x, y, w, h):
    """The mean colour of a region of the frame at t, as [r, g, b]."""
    args = ["ffmpeg", "-hide_banner", "-nostdin"]
    if t:
        args += ["-ss", f"{t:.3f}"]
    args += ["-i", path, "-frames:v", "1", "-vf", f"crop={w}:{h}:{x}:{y},format=gbrp,showinfo", "-f", "null", "-"]
    err = run(args).stderr
    found = MEAN.findall(err)
    if not found:
        raise RuntimeError(f"no colour from {path} at {t}:\n{err[-2000:]}")
    # The first frame shown is the one at t: the seek drops the frames
    # before it ahead of the filters, and ffmpeg pushes a few more through
    # before -frames:v 1 stops it.
    g, b, r = (int(v) for v in found[0])
    return [r, g, b]


LOUDNESS = re.compile(r"I:\s+(-?[\d.]+) LUFS")


def loudness(path):
    err = run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path, "-af", "ebur128", "-f", "null", "-"]).stderr
    found = LOUDNESS.findall(err)
    if not found:
        raise RuntimeError(f"no loudness for {path}")
    return float(found[-1])


def measure_output(path, spec):
    """The facts, sample colours and loudness of a render's output."""
    out = {"facts": facts(path), "samples": []}
    for s in spec.get("samples", []):
        out["samples"].append(mean_colour(path, s["t"], s["x"], s["y"], s["w"], s["h"]))
    if spec.get("loudness"):
        out["loudness"] = loudness(path)
    return out
