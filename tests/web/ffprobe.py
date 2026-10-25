#!/usr/bin/python3
"""Sonde le WebM réel et valide le média factice des parcours Web."""
import json
import os
from pathlib import Path
import sys

path = Path(sys.argv[-1])
# Le média retenu porte un nom technique différent lors de la capture, mais reste un vrai WebM.
if path.suffix == ".webm":
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
