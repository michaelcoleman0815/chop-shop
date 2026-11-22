"""Prints where a process crashed, from its macOS crash report (.ips): the
exception, then the frames of the thread that crashed, with the library and
the symbol of each where the report has them.

    python3 ci/crashed-thread.py REPORT.ips

ci/ios-drive.sh runs it on the reports of the app and its web views.
"""
import json
import sys

with open(sys.argv[1]) as f:
    text = f.read()
# A report is a line of JSON about it, then the report itself.
_, _, body = text.partition("\n")
try:
    report = json.loads(body)
except json.JSONDecodeError:
    print(text[:3000])
    sys.exit(0)

print(f"process: {report.get('procName')} ({report.get('procPath')})")
print(f"exception: {report.get('exception')}")
if report.get("termination"):
    print(f"termination: {report['termination']}")
if report.get("asi"):
    print(f"messages: {report['asi']}")
images = report.get("usedImages", [])
for thread in report.get("threads", []):
    if not thread.get("triggered"):
        continue
    print(f"thread {thread.get('id')} {thread.get('name') or thread.get('queue') or ''}")
    for frame in thread.get("frames", [])[:48]:
        index = frame.get("imageIndex")
        image = images[index].get("name", "?") if index is not None and index < len(images) else "?"
        symbol = frame.get("symbol") or f"+{hex(frame.get('imageOffset', 0))}"
        print(f"  {image}  {symbol}{'+' + str(frame['symbolLocation']) if 'symbolLocation' in frame else ''}")
