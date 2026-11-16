"""Prints what an iOS crash report (.ips) says: why the app stopped and where,
the crashed thread's frames with their images and symbols.

    python3 ci/crash-summary.py REPORT.ips...
"""
import json
import sys

for path in sys.argv[1:]:
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    # A header line of JSON, then the report's own JSON.
    head, _, body = text.partition("\n")
    try:
        report = json.loads(body)
    except json.JSONDecodeError:
        print(f"{path}: not a JSON crash report; its start:\n{text[:3000]}")
        continue
    print(f"== {path}")
    print(f"exception: {json.dumps(report.get('exception'))}")
    print(f"termination: {json.dumps(report.get('termination'))}")
    if report.get("asi"):
        print(f"asi: {json.dumps(report['asi'])[:2000]}")
    images = report.get("usedImages", [])
    threads = report.get("threads", [])
    crashed = next((t for t in threads if t.get("triggered")), threads[0] if threads else None)
    if not crashed:
        continue
    print(f"thread: {crashed.get('name') or crashed.get('queue') or ''}")
    for i, frame in enumerate(crashed.get("frames", [])[:40]):
        image = images[frame.get("imageIndex", 0)] if images else {}
        name = image.get("name") or image.get("path", "?").split("/")[-1]
        symbol = frame.get("symbol", "?")
        print(f"  {i:2} {name:<28} {symbol} + {frame.get('symbolLocation', frame.get('imageOffset', 0))}")
