#!/usr/bin/python3
"""Simule métadonnées et captions, sans accès réseau, pour les parcours Web réels."""

import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlparse


def main():
    """Reproduit l'acquisition média unique et les commandes de transcription existantes."""
    args = sys.argv[1:]
    if "--load-info-json" in args:
        output = Path(args[args.index("--output") + 1])
        track = args[args.index("--sub-langs") + 1].removeprefix("^").removesuffix("$")
        if track not in ("fr-orig", "en-orig"):
            raise ValueError("Unexpected caption selection")
        caption = {"events": [
            {"tStartMs": 2960, "segs": [{"utf8": "Bon"}, {"utf8": "jour"},
                                        {"tOffsetMs": 120, "utf8": " le monde."}]},
            {"tStartMs": 11000, "segs": [{"utf8": "Deuxième intervalle."}]},
        ]}
        (output.parent / f"caption.{track}.json3").write_text(json.dumps(caption), encoding="utf-8")
        return

    url = urlparse(args[-1])
    external_id = parse_qs(url.query).get("v", [url.path.rsplit("/", 1)[-1]])[0]
    if "--format" in args:
        if args[args.index("--format") + 1] != "bv*+ba/b" or "--match-filters" not in args:
            raise ValueError("Unexpected media selection")
        output = Path(args[args.index("--output") + 1])
        path = (output.parent / "media.mkv").resolve()
        info = {"id": external_id, "extractor_key": "Youtube", "live_status": "not_live", "duration": 125}
        print("source:" + json.dumps(info))
        path.write_bytes(bytes.fromhex("1a45dfa38b428288") + b"matroska")
        # L'original de la source reste anglais ; le fichier annonce un doublage.
        info.update(filepath=str(path), acodec="aac", language="fr-FR")
        print("result:" + json.dumps({"file": info, "tracks": []}))
        return

    metadata = {
        "extractor_key": "Youtube", "id": "sillage-test",
        "title": "Comprendre SQLite et ses transactions", "duration": 125,
        "channel_id": "UC" + "s" * 22, "channel": "Les ateliers du code",
        "thumbnail": "http://127.0.0.1:18381/missing-thumbnail.jpg",
    }
    if external_id.startswith("sillage-new-"):
        metadata.update(id=external_id, title="Une nouvelle vidéo pour apprendre",
                        description="Une description conservée dans SQLite.")
    if external_id.startswith(("sillage-notes-", "sillage-tags-", "tr")):
        metadata.update(id=external_id, title=external_id, description="Description pour le classement.")
    if external_id.startswith("tr"):
        metadata["automatic_captions"] = {"fr-orig": [{
            "ext": "json3", "url": "https://example.test/original",
        }]}
    if external_id.startswith("trdl"):
        metadata["live_status"] = "not_live"
        metadata["formats"] = [{
            "format_id": "18", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a",
            "width": 640, "height": 360, "fps": 30,
            "language": "en", "language_preference": 10,
            "url": "https://example.test/media",
        }]
    if external_id.startswith("tr-region"):
        metadata["formats"] = [{"language": "en-US", "language_preference": 10, "acodec": "opus"}]
        metadata["automatic_captions"] = {"en-orig": [{"ext": "json3", "url": "https://example.test/en"}]}
        # Plusieurs captions, comme pour une vidéo proposant des pistes doublées.
        metadata["automatic_captions"]["fr-orig"] = [{"ext": "json3", "url": "https://example.test/fr"}]
    if external_id.startswith("tr-ambigu"):
        metadata["automatic_captions"]["en-orig"] = [{"ext": "json3", "url": "https://example.test/en"}]
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
