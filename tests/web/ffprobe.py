#!/usr/bin/python3
"""Valide uniquement le média factice créé par le double yt-dlp du parcours Web."""
import json
import os
from pathlib import Path
import sys

path = Path(sys.argv[-1])
if path.name == "media.webm":
    os.execv("/usr/bin/ffprobe", ["ffprobe", *sys.argv[1:]])
if path.name != "media.mkv" or path.read_bytes() != bytes.fromhex("1a45dfa38b428288") + b"matroska":
    raise SystemExit(1)
print(json.dumps({
    "format": {"format_name": "matroska,webm", "duration": "125", "size": str(path.stat().st_size)},
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "avg_frame_rate": "30000/1001"},
        {"codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}},
    ],
}))
