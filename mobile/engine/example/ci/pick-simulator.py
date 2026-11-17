"""Picks an iPhone simulator to run the self-test on: the newest iOS the Mac
has, and on it an iPhone Pro if there is one. Prints its UDID, then what it is.

    python3 ci/pick-simulator.py
"""
import json
import re
import subprocess
import sys

listing = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"]))
best = None
for runtime, devices in listing["devices"].items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m:
        continue
    version = (int(m[1]), int(m[2]))
    for d in devices:
        if not d["name"].startswith("iPhone"):
            continue
        rank = (version, "Pro" in d["name"] and "Max" not in d["name"], d["name"])
        if best is None or rank > best[0]:
            best = (rank, d["udid"], d["name"], runtime.split(".")[-1])
if best is None:
    sys.exit("no iPhone simulator is available")
print(best[1])
print(f"{best[2]} on {best[3]}")
