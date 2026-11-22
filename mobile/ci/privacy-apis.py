"""Checks the built iOS app against Apple's required reason APIs: every
Mach-O in the app is read for the functions, constants and selectors on
Apple's list, and each category a binary uses has to be declared in a
manifest that covers it: its own framework's PrivacyInfo.xcprivacy, if it
has one, or the app's (ios/App/App/PrivacyInfo.xcprivacy), which covers the
app's own code, the plugins built into it and the engine's libraries. The
app's manifest declares nothing that no binary needs from it.

    python3 ci/privacy-apis.py path/to/App.app

Prints what each binary uses and exits non-zero when a category is missing
from the manifests or declared for nothing. The reasons themselves (C617.1
and the like) are for a person to choose; the manifest's comment says why.
"""
import os
import plistlib
import subprocess
import sys

# Apple's list, as symbols a binary imports and selectors it sends.
CATEGORIES = {
    "NSPrivacyAccessedAPICategoryFileTimestamp": {
        "symbols": {
            "_stat", "_fstat", "_lstat", "_fstatat", "_getattrlist", "_getattrlistbulk", "_fgetattrlist",
            "_getattrlistat", "_stat$INODE64", "_fstat$INODE64", "_lstat$INODE64", "_fstatat$INODE64",
            "_NSFileCreationDate", "_NSFileModificationDate", "_NSURLCreationDateKey",
            "_NSURLContentModificationDateKey",
        },
        "selectors": {"fileModificationDate"},
    },
    "NSPrivacyAccessedAPICategorySystemBootTime": {
        "symbols": {"_mach_absolute_time"},
        "selectors": {"systemUptime"},
    },
    "NSPrivacyAccessedAPICategoryDiskSpace": {
        "symbols": {
            "_statfs", "_statvfs", "_fstatfs", "_fstatvfs", "_statfs$INODE64", "_fstatfs$INODE64",
            "_NSURLVolumeAvailableCapacityKey", "_NSURLVolumeAvailableCapacityForImportantUsageKey",
            "_NSURLVolumeAvailableCapacityForOpportunisticUsageKey", "_NSURLVolumeTotalCapacityKey",
            "_NSFileSystemFreeSize", "_NSFileSystemSize",
        },
        "selectors": set(),
    },
    "NSPrivacyAccessedAPICategoryActiveKeyboards": {
        "symbols": set(),
        "selectors": {"activeInputModes"},
    },
    "NSPrivacyAccessedAPICategoryUserDefaults": {
        "symbols": {"_OBJC_CLASS_$_NSUserDefaults"},
        "selectors": {"standardUserDefaults"},
    },
}

MACHO = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
}

problems = []


def problem(text):
    problems.append(text)
    print(f"::error::{text}")


def declared(path):
    """The categories a manifest declares, with their reasons."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        manifest = plistlib.load(f)
    return {
        entry["NSPrivacyAccessedAPIType"]: entry.get("NSPrivacyAccessedAPITypeReasons", [])
        for entry in manifest.get("NSPrivacyAccessedAPITypes", [])
    }


def binaries(app):
    for top, _dirs, files in os.walk(app):
        for name in files:
            path = os.path.join(top, name)
            if os.path.islink(path):
                continue
            with open(path, "rb") as f:
                if f.read(4) in MACHO:
                    yield path


def own_manifest(app, path):
    """The manifest of the framework a binary is, if it is one and has one."""
    rel = os.path.relpath(path, app).split(os.sep)
    for i, part in enumerate(rel):
        if part.endswith(".framework"):
            return os.path.join(app, *rel[: i + 1], "PrivacyInfo.xcprivacy")
    return None


def uses(path):
    """What a binary uses from the list: category -> the symbols and selectors that say so."""
    out = subprocess.run(["nm", "-u", path], capture_output=True, text=True).stdout
    imported = {line.split()[-1] for line in out.splitlines() if line.strip() and not line.endswith(":")}
    with open(path, "rb") as f:
        data = f.read()
    found = {}
    for category, apis in CATEGORIES.items():
        hits = sorted(apis["symbols"] & imported)
        hits += [s for s in sorted(apis["selectors"]) if b"\x00" + s.encode() + b"\x00" in data]
        if hits:
            found[category] = hits
    return found


def main():
    app = sys.argv[1]
    app_manifest = declared(os.path.join(app, "PrivacyInfo.xcprivacy"))
    if app_manifest is None:
        problem("the app has no PrivacyInfo.xcprivacy")
        app_manifest = {}
    print("the app's manifest: " + (", ".join(f"{c} {r}" for c, r in app_manifest.items()) or "nothing"))
    needed = {}
    for path in sorted(binaries(app)):
        rel = os.path.relpath(path, app)
        found = uses(path)
        manifest_path = own_manifest(app, path)
        own = declared(manifest_path) if manifest_path else None
        names = ", ".join(f"{c.replace('NSPrivacyAccessedAPICategory', '')} ({' '.join(h)})" for c, h in found.items())
        print(f"{rel}: {names or 'none'}{'' if own is None else ' [its own manifest: ' + (', '.join(own) or 'nothing') + ']'}")
        for category in found:
            if own is not None and category in own:
                continue
            needed.setdefault(category, []).append(rel)
    for category, where in sorted(needed.items()):
        if category not in app_manifest:
            problem(f"{category} is used by {', '.join(where)}, and no manifest declares it")
    for category in sorted(app_manifest):
        if category not in needed:
            problem(f"the app's manifest declares {category}, which nothing in the app needs it to")
    if not problems:
        print("every required reason API in the app is declared, and nothing more")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
