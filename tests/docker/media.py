#!/usr/bin/env python3
"""Essai YouTube explicite du cycle média dans l'image réelle, avec données isolées."""

import argparse
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def command(*args):
    """Borne les commandes de cycle Docker sans toucher aux conteneurs existants."""
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=40).strip()


def main():
    """Télécharge, redémarre et supprime un média ; conserve la note durant tout le parcours."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--youtube-id", required=True)
    parser.add_argument("--port", type=int, default=18389)
    args = parser.parse_args()
    with socket.socket() as check:
        check.bind(("127.0.0.1", args.port))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    name = "sillage-media-test-" + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix="sillage-media-docker-") as directory:
        root = Path(directory)
        data = root / "data"
        data.mkdir()

        def request(path, method="GET", body=None, expected=200):
            """Vérifie les réponses publiques sans afficher les diagnostics internes."""
            req = urllib.request.Request(
                f"http://127.0.0.1:{args.port}/api/v1/{path}",
                data=None if body is None else json.dumps(body).encode(),
                headers={"Content-Type": "application/json"},
                method=method,
            )
            try:
                response = opener.open(req, timeout=70)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                payload = response.read()
                assert response.status == expected, (response.status, payload)
                return json.loads(payload) if payload else None

        def ready():
            """Attend le démarrage après migrations et rapprochement du stockage."""
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    request("videos")
                    return
                except (urllib.error.URLError, OSError):
                    time.sleep(0.1)
            raise RuntimeError("Server did not start")

        try:
            command(
                "docker", "run", "-d", "--name", name,
                "--user", f"{os.getuid()}:{os.getgid()}",
                "--publish", f"127.0.0.1:{args.port}:8080",
                "--mount", f"type=bind,src={data},dst=/app/data",
                "--env", "SILLAGE_DOWNLOAD_TIMEOUT=3m", "sillage:local",
            )
            ready()
            video = request("videos", "POST", {"url": f"https://youtu.be/{args.youtube_id}"}, 201)
            source = video["sources"][0]
            path = f"videos/{video['id']}/sources/{source['id']}/download"
            note_path = f"videos/{video['id']}/note"
            request(note_path, "PUT", {"content_md": "Connaissance préservée", "expected_revision": 0}, 201)
            request(path, "POST", expected=202)
            deadline = time.monotonic() + 190
            while time.monotonic() < deadline:
                state = request(path)
                if state["status"] == "available":
                    break
                if state["status"] == "failed":
                    raise RuntimeError(state)
                time.sleep(0.5)
            else:
                raise RuntimeError("Download did not finish")
            media = state["media_file"]
            assert request(path, "POST")["media_file"]["id"] == media["id"]
            with sqlite3.connect(data / "sillage.db") as database:
                stored = database.execute("SELECT path FROM media_files WHERE id = ?", (media["id"],)).fetchone()[0]
            assert (data / "media" / stored).stat().st_size == media["size"]
            probe = command(
                "docker", "exec", name, "ffprobe", "-v", "error", "-show_entries",
                "stream=codec_name,width,height:format=duration,format_name", "-of", "json",
                "/app/data/media/" + stored,
            )
            print("Acquisition et ffprobe dans Docker :", media, probe, flush=True)
            command("docker", "restart", "-t", "12", name)
            ready()
            assert request(path)["media_file"]["id"] == media["id"]
            request(f"videos/{video['id']}/media-files/{media['id']}", "DELETE", expected=204)
            assert request(path)["status"] == "not_downloaded"
            assert request(note_path)["content_md"] == "Connaissance préservée"
            assert not (data / "media" / stored).exists()
            print("Redémarrage, idempotence, suppression physique et note préservée : OK", flush=True)
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20, check=False)


if __name__ == "__main__":
    main()
