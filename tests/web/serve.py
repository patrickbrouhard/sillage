#!/usr/bin/env python3
"""Sert le build réel avec SQLite isolé et des métadonnées déterministes."""

import sys
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
sys.path.insert(0, str(ROOT / "tests"))
from auth_support import AuthClient, initialize
OPENER = AuthClient()



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
            OPENER.opener.open(f"http://127.0.0.1:{port}/api/v1/auth/session", timeout=5).close()
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
        # Chaque acquisition traverse l'exécutable simulé, puis les adapters réels.
        executable = workspace / "yt-dlp"
        executable.write_text(
            (ROOT / "tests/web/ytdlp.py").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        executable.chmod(0o700)
        probe_executable = workspace / "ffprobe"
        probe_executable.write_text((ROOT / "tests/web/ffprobe.py").read_text(encoding="utf-8"), encoding="utf-8")
        probe_executable.chmod(0o700)
        # Un vrai média commun exerce le décodage, les seeks et le transport HTTP.
        playable = workspace / "playable.webm"
        subprocess.run([
            "/usr/bin/ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "125", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
            "-b:v", "100k", "-c:a", "libopus", "-b:a", "16k", str(playable),
        ], check=True)
        env = os.environ.copy()
        env["SILLAGE_TEST_MEDIA"] = str(playable)
        env["PATH"] = f"{workspace}:/usr/bin:/bin"
        env["SILLAGE_WEB_DIR"] = str(ROOT / "web" / "dist")

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            seed_port = probe.getsockname()[1]
        env["SILLAGE_HTTP_ADDR"] = f"127.0.0.1:{seed_port}"
        initialize([str(ROOT / "bin" / "sillage"), "owner", "init"], workspace)
        try:
            server = subprocess.Popen([str(ROOT / "bin" / "sillage")], cwd=workspace, env=env)
            wait_ready(server, seed_port)
            OPENER.login(f"http://127.0.0.1:{seed_port}")
            video = request(seed_port, "videos", {"url": "https://youtu.be/sillage-test"})
            request(seed_port, f"videos/{video['id']}/tags", {"names": ["SQLite", "À approfondir"]})
            state_dir = ROOT / "web" / "tests" / ".auth"
            state_dir.mkdir(exist_ok=True)
            (state_dir / "state.json").write_text(json.dumps(OPENER.playwright_state()), encoding="utf-8")
            (state_dir / "csrf.txt").write_text(OPENER.csrf, encoding="utf-8")
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
