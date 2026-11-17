"""Makes the self-test's sample media on the CI runner, with the runner's own
ffmpeg (it needs libx264, libx265, libwebp, an AV1 encoder and zscale), and
records what each test render should come out as by running it here first,
with libx264 and libx265 in place of the phones' hardware encoders.

    python3 tools/make_media.py OUT_DIR REPO_ROOT

Nothing it makes is committed: it is all made again on every run.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure import facts, mean_colour, measure_output, run  # noqa: E402

OUT = os.path.abspath(sys.argv[1])
REPO = os.path.abspath(sys.argv[2])
EXAMPLE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# One solid colour a second, so any frame says which second it came from.
SECONDS = ["E02020", "E0E020", "20C040", "20C0E0", "2040E0", "E020E0", "F0F0F0", "808080", "F08020", "8020C0"]


def ff(*args):
    run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args])


def tone(seconds, base=330):
    """A tone that steps up every second, the same in both ears."""
    e = f"0.25*sin(2*PI*({base}+110*floor(t))*t)"
    return f"aevalsrc=exprs='{e}|{e}':s=48000:d={seconds}"


def make():
    os.makedirs(OUT, exist_ok=True)
    o = lambda name: os.path.join(OUT, name)  # noqa: E731

    colours = ";".join(f"color=c=0x{c}:s=1920x1080:r=30:d=1[c{i}]" for i, c in enumerate(SECONDS))
    joins = "".join(f"[c{i}]" for i in range(len(SECONDS)))
    ff("-filter_complex", f"{colours};{joins}concat=n={len(SECONDS)}:v=1:a=0[v];{tone(10)}[a]",
       "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
       "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
       o("h264_1080p.mp4"))

    # Like an iPhone held upright: HEVC coded 1920x1080 in a .mov, with a
    # display matrix that turns it 90 degrees clockwise to 1080x1920. Green
    # on the coded left, magenta on the right: upright, green is on top.
    with tempfile.TemporaryDirectory() as tmp:
        coded = os.path.join(tmp, "coded.mov")
        ff("-filter_complex", f"color=c=0x20C040:s=960x1080:r=30:d=3[l];color=c=0xE020E0:s=960x1080:r=30:d=3[r];"
           f"[l][r]hstack[v];{tone(3, 440)}[a]", "-map", "[v]", "-map", "[a]",
           "-c:v", "libx265", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
           "-x265-params", "log-level=error", "-c:a", "aac", coded)
        for angle in ("-90", "90"):
            ff("-display_rotation:v:0", angle, "-i", coded, "-c", "copy", "-metadata:s:v:0", "handler_name=Core Media Video",
               o("hevc_portrait.mov"))
            if facts(o("hevc_portrait.mov"))["video"]["rotation"] == -90:
                break
        else:
            raise SystemExit("could not make a portrait recording with rotation -90")

    # 10-bit HLG in BT.2020, as phones record HDR: three colours, a second each.
    hlg = ";".join(f"color=c=0x{c}:s=1920x1080:r=30:d=1[h{i}]" for i, c in enumerate(["8090A0", "D06040", "40A060"]))
    ff("-filter_complex",
       f"{hlg};[h0][h1][h2]concat=n=3:v=1:a=0,format=yuv420p,"
       "zscale=min=bt709:tin=bt709:pin=bt709:rin=tv:m=gbr:t=linear:p=bt709:npl=100,format=gbrpf32le,"
       "zscale=min=gbr:tin=linear:pin=bt709:p=bt2020:t=arib-std-b67:m=bt2020nc:r=tv:npl=100,format=yuv420p10le[v];"
       f"{tone(3, 550)}[a]",
       "-map", "[v]", "-map", "[a]", "-c:v", "libx265", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p10le",
       "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited",
       "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1",
       "-c:a", "aac", o("hlg_10bit.mov"))

    # The espeak recording the desktop's tests use, its first three lines.
    ff("-t", "16", "-i", os.path.join(REPO, "src/main/learn-fixtures/talk.m4a"), "-ar", "16000", "-ac", "1",
       "-c:a", "pcm_s16le", o("speech.wav"))
    with open(os.path.join(REPO, "src/main/learn-fixtures/talk.json")) as f:
        truth = json.load(f)
    words = [w for w in truth["words"] if w["endSec"] <= 16]
    with open(o("speech-truth.json"), "w") as f:
        json.dump({"durationSec": 16, "words": words}, f, indent=1)

    ff("-filter_complex", "color=c=0xF08020:s=360x160,format=rgba,pad=400:200:20:20:color=0x00000000",
       "-frames:v", "1", o("logo.png"))
    ff("-filter_complex", "color=c=0x208080:s=1920x1080,format=rgb24", "-frames:v", "1", o("still.png"))
    ff("-filter_complex", "color=c=0x6040A0:s=1280x720", "-frames:v", "1", "-c:v", "libwebp", "-quality", "90",
       o("still.webp"))
    av1 = "libaom-av1" if " libaom-av1 " in run(["ffmpeg", "-hide_banner", "-encoders"]).stdout else "libsvtav1"
    ff("-filter_complex", "color=c=0xC0A030:s=640x360,format=yuv420p", "-frames:v", "1", "-c:v", av1,
       *(["-still-picture", "1", "-cpu-used", "8"] if av1 == "libaom-av1" else ["-preset", "12"]), o("still.avif"))

    chord = "+".join(f"0.1*sin(2*PI*{f}*t)" for f in (220, 277.18, 329.63))
    ff("-filter_complex", f"aevalsrc=exprs='{chord}|{chord}':s=48000:d=8", "-c:a", "aac", "-b:a", "160k",
       o("music.m4a"))

    # What else phones record or receive: Apple Lossless (an iPhone voice
    # memo can be), an Opus voice note in Ogg, Motion JPEG video.
    ff("-filter_complex", f"{tone(4, 262)},aresample=44100", "-c:a", "alac", o("alac.m4a"))
    ff("-t", "6", "-i", o("speech.wav"), "-c:a", "libopus", "-b:a", "32k", "-application", "voip", o("voice.ogg"))
    mj = ";".join(f"color=c=0x{c}:s=640x360:r=30:d=1[m{i}]" for i, c in enumerate(SECONDS[:3]))
    ff("-filter_complex", f"{mj};[m0][m1][m2]concat=n=3:v=1:a=0,format=yuvj420p[v]", "-map", "[v]",
       "-c:v", "mjpeg", "-q:v", "3", o("mjpeg.avi"))
    ff("-filter_complex", "anoisesrc=d=0.6:c=pink:a=0.5:r=48000,afade=t=in:d=0.2,afade=t=out:st=0.3:d=0.3,"
       "aformat=channel_layouts=stereo", "-c:a", "pcm_s16le", o("whoosh.wav"))

    # A 3D LUT that swaps red and blue: easy to see it applied.
    n = 17
    lines = ['TITLE "Swap red and blue"', f"LUT_3D_SIZE {n}"]
    for b in range(n):
        for g in range(n):
            for r in range(n):
                lines.append(f"{b / (n - 1):.6f} {g / (n - 1):.6f} {r / (n - 1):.6f}")
    with open(o("grade.cube"), "w") as f:
        f.write("\n".join(lines) + "\n")

    fonts = o("fonts")
    os.makedirs(fonts, exist_ok=True)
    for name in os.listdir(os.path.join(REPO, "resources/fonts")):
        if name.endswith(".ttf"):
            shutil.copy(os.path.join(REPO, "resources/fonts", name), fonts)


def fill(arg, dirs, encoders):
    for key, value in {**dirs, **encoders}.items():
        arg = arg.replace("{" + key + "}", value)
    return arg


# The app's export video settings, with libx264 for the hardware encoder
# (selftest.ts has the phones' own).
EXPORT_VIDEO = ["-c:v", "libx264", "-profile:v", "high", "-b:v", "12000k", "-g", "60", "-pix_fmt", "nv12"]


def expand(args, dirs, encoders):
    out = []
    for a in args:
        if a == "{exportVideo}":
            out += EXPORT_VIDEO
        else:
            out.append(fill(a, dirs, encoders))
    return out


def expectations():
    with open(os.path.join(EXAMPLE, "src/renders.json")) as f:
        specs = json.load(f)
    with open(os.path.join(EXAMPLE, "src/desktop-renders.json")) as f:
        desktop = json.load(f)
    renders = list(specs["renders"])
    for r in desktop["renders"]:
        renders.append({**r, **specs["desktop"][r["name"]]})

    expect = {"probe": {}, "renders": {}}
    for name in ["h264_1080p.mp4", "hevc_portrait.mov", "hlg_10bit.mov", "speech.wav", "logo.png", "still.png",
                 "still.webp", "still.avif", "music.m4a", "alac.m4a", "voice.ogg", "mjpeg.avi"]:
        expect["probe"][name] = facts(os.path.join(OUT, name))
    expect["preview"] = {"file": "h264_1080p.mp4", "t": 2.5,
                         "rgb": mean_colour(os.path.join(OUT, "h264_1080p.mp4"), 2.5, 896, 476, 128, 128),
                         "late": {"t": 8.5, "rgb": mean_colour(os.path.join(OUT, "h264_1080p.mp4"), 8.5, 896, 476, 128, 128)}}

    with tempfile.TemporaryDirectory() as tmp:
        work = os.path.join(tmp, "work")
        out = os.path.join(tmp, "out")
        os.makedirs(work)
        os.makedirs(out)
        dirs = {"media": OUT, "fonts": os.path.join(OUT, "fonts"), "work": work, "out": out}
        encoders = {"h264": "libx264", "hevc": "libx265"}
        for spec in renders:
            for fname, text in (spec.get("files") or {}).items():
                with open(os.path.join(work, fname), "w") as f:
                    f.write(fill(text, dirs, encoders))
            for pre in spec.get("pre", []):
                p = run(["ffmpeg", "-nostdin", *expand(pre, dirs, encoders)], check=False)
                if p.returncode != 0:
                    raise SystemExit(f"{spec['name']} failed on the runner before its render:\n{p.stderr[-3000:]}")
            args = expand(spec["args"], dirs, encoders)
            p = run(["ffmpeg", "-nostdin", *args], check=False)
            if p.returncode != 0:
                raise SystemExit(f"{spec['name']} failed on the runner:\n{p.stderr[-3000:]}")
            measured = measure_output(os.path.join(out, spec["output"]), spec)
            expect["renders"][spec["name"]] = measured
            print(f"{spec['name']}: {json.dumps(measured)}")
    with open(os.path.join(OUT, "expect.json"), "w") as f:
        json.dump(expect, f, indent=1)


if __name__ == "__main__":
    make()
    expectations()
    print(f"media in {OUT}:")
    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        if os.path.isfile(p):
            print(f"  {name}: {os.path.getsize(p)} bytes")
