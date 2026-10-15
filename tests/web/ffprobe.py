#!/usr/bin/python3
"""Valide uniquement le média factice créé par le double yt-dlp du parcours Web."""
import json
from pathlib import Path
import sys

path = Path(sys.argv[-1])
if path.name != "media.mp4" or path.read_bytes() != b"complete":
    raise SystemExit(1)
print(json.dumps({
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "125", "size": "8"},
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360},
        {"codec_type": "audio", "codec_name": "aac"},
    ],
}))
