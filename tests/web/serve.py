#!/usr/bin/env python3
"""Sert le build réel avec SQLite isolé et des métadonnées déterministes."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PORT = 18381
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(port, path, data=None):
    """Traverse l'API réelle, y compris pour préparer les données du navigateur."""
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v1/{path}",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=5) as response:
        return json.load(response)


def wait_ready(server, port):
    """Attend uniquement le processus lancé ici, avec un délai borné."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError("Le serveur de test s'est arrêté.")
        try:
            request(port, "videos")
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.05)
    raise RuntimeError("Le serveur de test ne répond pas.")


def stop(server):
    """Libère le serveur avant la suppression de son répertoire temporaire."""
    if server is not None and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=12)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()


def interrupted(signum, frame):
    """Fait passer SIGTERM par le nettoyage normal."""
    raise KeyboardInterrupt


def main():
    """Prépare via REST, redémarre, puis expose les données persistées à Playwright."""
    server = None
    with tempfile.TemporaryDirectory(prefix="sillage-web-test-") as temporary:
        workspace = Path(temporary)
        metadata = {
            "extractor_key": "Youtube",
            "id": "sillage-test",
            "title": "Comprendre SQLite et ses transactions",
            "duration": 125,
            "channel_id": "UC" + "s" * 22,
            "channel": "Les ateliers du code",
            "thumbnail": f"http://127.0.0.1:{PORT}/missing-thumbnail.jpg",
        }
        # Métadonnées fixes ; un ID dédié à chaque tentative isole les reprises CI.
        executable = workspace / "yt-dlp"
        executable.write_text(
            "#!/usr/bin/python3\nimport json, sys\n"
            + "metadata = " + repr(metadata) + "\n"
            + "external_id = sys.argv[-1].rsplit('/', 1)[-1]\n"
            + "if external_id.startswith('sillage-new-'):\n"
            + "    metadata.update(id=external_id, title='Une nouvelle vidéo pour apprendre', description='Une description conservée dans SQLite.')\n"
            + "if external_id.startswith('sillage-tags-'):\n"
            + "    metadata.update(id=external_id, title=external_id, description='Description pour le classement.')\n"
            + "print(json.dumps(metadata))\n",
            encoding="utf-8",
        )
        executable.chmod(0o700)
        env = os.environ.copy()
        env["PATH"] = f"{workspace}:/usr/bin:/bin"
        env["SILLAGE_WEB_DIR"] = str(ROOT / "web" / "dist")

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            seed_port = probe.getsockname()[1]
        env["SILLAGE_HTTP_ADDR"] = f"127.0.0.1:{seed_port}"
        try:
            server = subprocess.Popen([str(ROOT / "bin" / "sillage")], cwd=workspace, env=env)
            wait_ready(server, seed_port)
            video = request(seed_port, "videos", {"url": "https://youtu.be/sillage-test"})
            request(seed_port, f"videos/{video['id']}/tags", {"names": ["SQLite", "À approfondir"]})
            stop(server)

            # Le port final n'est ouvert qu'après persistance et redémarrage.
            # Un port déjà occupé fait échouer le test, sans réutiliser un autre serveur.
            env["SILLAGE_HTTP_ADDR"] = f"127.0.0.1:{PORT}"
            server = subprocess.Popen([str(ROOT / "bin" / "sillage")], cwd=workspace, env=env)
            wait_ready(server, PORT)
            if server.wait() != 0:
                raise RuntimeError("Le serveur de test s'est arrêté en erreur.")
        finally:
            stop(server)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        pass
