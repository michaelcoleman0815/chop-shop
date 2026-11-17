"""Uploads an Android App Bundle to a Google Play track with the Play
Developer API (androidpublisher v3), as a service account that has access
to the app in the Play Console, and releases it there.

    python3 ci/play-upload.py BUNDLE PACKAGE [TRACK]

TRACK is "internal" by default. PLAY_SERVICE_ACCOUNT_JSON holds the service
account's JSON key. PLAY_RELEASE_STATUS is "completed" by default; a new app
the Play Console still shows as a draft takes "draft", until its first
release has been rolled out by hand. The API cannot make the app itself:
it is made in the Play Console, with the first bundle uploaded there.

Needs google-api-python-client and google-auth.
"""
import json
import os
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

bundle_path = sys.argv[1]
package = sys.argv[2]
track = sys.argv[3] if len(sys.argv) > 3 else "internal"
status = os.environ.get("PLAY_RELEASE_STATUS", "completed")

credentials = service_account.Credentials.from_service_account_info(
    json.loads(os.environ["PLAY_SERVICE_ACCOUNT_JSON"]),
    scopes=["https://www.googleapis.com/auth/androidpublisher"],
)
edits = build("androidpublisher", "v3", credentials=credentials, cache_discovery=False).edits()

edit = edits.insert(packageName=package, body={}).execute()["id"]
media = MediaFileUpload(bundle_path, mimetype="application/octet-stream", resumable=True)
code = edits.bundles().upload(packageName=package, editId=edit, media_body=media).execute()["versionCode"]
print(f"uploaded version code {code}")
edits.tracks().update(
    packageName=package,
    editId=edit,
    track=track,
    body={"track": track, "releases": [{"versionCodes": [str(code)], "status": status}]},
).execute()
edits.commit(packageName=package, editId=edit).execute()
print(f"version code {code} is on the {track} track ({status})")
