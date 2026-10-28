#!/usr/bin/env python3
"""Vérifie l'image et Compose avec un bind mount temporaire, sans YouTube réel."""

import sys
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from auth_support import AuthClient, initialize
OPENER = AuthClient()
IMAGE = os.environ.get("SILLAGE_TEST_IMAGE", "sillage:local")


def command(*args, env=None):
    """Exécute une commande bornée et conserve sa sortie dans les erreurs."""
    result = subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f"{args}:\n{result.stdout}\n{result.stderr}")
    return result.stdout


def request(port, path, data=None, expected=200, method=None):
    """Traverse le HTTP réel et vérifie aussi les statuts d'erreur."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=None if data is None else json.dumps(data).encode(),
        headers={"Content-Type": "application/json", "X-Request-ID": "PRIVATE_CLIENT_ID"},
        method=method,
    )
    try:
        response = OPENER.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        assert response.headers.get("X-Request-ID") not in (None, "", "PRIVATE_CLIENT_ID")
        assert response.status == expected, (path, response.status, body)
        return body


def main():
    """Teste les outils réels, puis le cycle de vie Compose avec acquisition simulée."""
    if os.getuid() == 0:
        raise RuntimeError("Lancer ce test avec un utilisateur hôte non-root.")
    with tempfile.TemporaryDirectory(prefix="sillage-docker-") as directory:
        root = Path(directory)
        data = root / "data"
        data.mkdir()
        fixture = root / "fixture"
        fixture.mkdir()
        metadata = {
            "id": "docker-test",
            "extractor_key": "Youtube",
            "title": "Vidéo Docker persistante",
            "description": "Une description\nsur deux lignes.",
            "duration": 125,
            "webpage_url": "https://youtu.be/docker-test",
            "url": "https://example.invalid/video.mp4",
            "ext": "mp4",
        }
        (fixture / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        executable = fixture / "yt-dlp"
        executable.write_text("#!/bin/sh\ncat /fixture/metadata.json\n", encoding="utf-8")
        executable.chmod(0o755)

        # Sans réseau : ce diagnostic vérifie le runtime JS et EJS embarqué.
        diagnostics = command(
            "docker", "run", "--rm", "--network", "none",
            "--mount", f"type=bind,src={fixture},dst=/fixture,readonly",
            "--entrypoint", "/bin/sh", IMAGE, "-ec",
            'test "$(id -u)" != 0; '
            'test ! -w /usr/local/bin/yt-dlp; test ! -w /usr/local/bin; '
            'test -s /etc/ssl/certs/ca-certificates.crt; '
            'yt-dlp --version; deno eval "console.log(1 + 1)"; '
            'ffmpeg -version; ffprobe -version; '
            'yt-dlp --ignore-config --verbose --simulate --load-info-json /fixture/metadata.json 2>&1',
        )
        assert re.search(r"JS runtimes:.*deno", diagnostics), diagnostics
        assert "yt_dlp_ejs" in diagnostics, diagnostics
        print("Outils réels, Deno/EJS et permissions : OK", flush=True)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        env = os.environ.copy()
        env.update(
            SILLAGE_DATA_DIR=str(data),
            SILLAGE_UID=str(os.getuid()),
            SILLAGE_GID=str(os.getgid()),
            SILLAGE_PORT=str(port),
            SILLAGE_CONTAINER_NAME=f"sillage-test-{os.getpid()}",
            SILLAGE_LOG_LEVEL="INFO",
            SILLAGE_LOG_FORMAT="json",
        )
        # Ce double n'existe que dans le conteneur du test ; l'image reste intacte.
        overlay = root / "test.json"
        overlay.write_text(json.dumps({"services": {"sillage": {
            "image": IMAGE,
            "environment": {"PATH": "/fixture:/usr/local/bin:/usr/bin:/bin"},
            "volumes": [{
                "type": "bind", "source": str(fixture), "target": "/fixture",
                "read_only": True, "bind": {"create_host_path": False},
            }],
        }}}), encoding="utf-8")
        base = [
            "docker", "compose", "-p", f"sillage-test-{os.getpid()}",
            "-f", str(ROOT / "deployments/docker/compose.yaml"), "-f", str(overlay),
        ]

        def compose(*args):
            """Conserve le projet et l'environnement propres à ce test."""
            return command(*base, *args, env=env)

        def ready():
            """Attend le conteneur lancé ici, sans dépendance réseau externe."""
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    OPENER.opener.open(f"http://127.0.0.1:{port}/api/v1/auth/session", timeout=5).close()
                    return
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    time.sleep(0.1)
            raise RuntimeError("Le conteneur ne répond pas.")

        def stop_cleanly():
            """Détecte notamment un SIGKILL après expiration du délai de shutdown."""
            cid = compose("ps", "-q", "sillage").strip()
            compose("stop")
            state = json.loads(command("docker", "inspect", cid))[0]["State"]
            assert state["ExitCode"] == 0 and not state["OOMKilled"], state
            logs = command("docker", "logs", env["SILLAGE_CONTAINER_NAME"])
            records = [json.loads(line) for line in logs.splitlines()]
            events = [record.get("event") for record in records]
            assert "server.ready" in events and "server.stopped" in events, events
            assert "PRIVATE_CLIENT_ID" not in logs
            assert not any(row["level"] == "DEBUG" for row in records)
            assert all("time" in row and "level" in row for row in records)

        try:
            initialize([*base, "run", "--rm", "sillage", "owner", "init"], ROOT, env)
            compose("up", "-d", "--no-build")
            ready()
            request(port, "/api/v1/videos", expected=401)
            OPENER.login(f"http://127.0.0.1:{port}")
            cid = compose("ps", "-q", "sillage").strip()
            inspection = json.loads(command("docker", "inspect", cid))[0]
            assert inspection["Name"] == "/" + env["SILLAGE_CONTAINER_NAME"]
            log_config = inspection["HostConfig"]["LogConfig"]
            assert log_config["Type"] == "local", log_config
            assert log_config["Config"]["max-size"] == "20m", log_config
            assert log_config["Config"]["max-file"] == "5", log_config
            bindings = inspection["NetworkSettings"]["Ports"]["8080/tcp"]
            assert bindings == [{"HostIp": "127.0.0.1", "HostPort": str(port)}], bindings
            assert inspection["Config"]["User"] == f"{os.getuid()}:{os.getgid()}"
            assert any(m["Source"] == str(data) and m["Destination"] == "/app/data"
                       and m["Type"] == "bind" and m["RW"] for m in inspection["Mounts"])
            html = request(port, "/").decode()
            assert '<div id="root">' in html
            assert 'href="/favicon.ico"' in html
            assert request(port, "/favicon.ico").startswith(bytes([0, 0, 1, 0]))
            assert request(port, "/favicon.ico", method="HEAD") == b""
            request(port, "/missing-icon.ico", expected=404)
            asset = re.search(r'src="(/assets/[^"]+\.js)"', html).group(1)
            assert len(request(port, asset)) > 1000
            assert request(port, "/videos/123") == html.encode()
            request(port, "/api/v1/absent", expected=404)
            request(port, "/api/v1/videos/999999", expected=404)
            request(port, "/assets/missing.js", expected=404)
            request(port, "/data/sillage.db", expected=404)
            video = json.loads(request(port, "/api/v1/videos",
                                      {"url": "https://youtu.be/docker-test"}, 201))
            vid = video["id"]
            assert json.loads(request(port, "/api/v1/videos",
                                      {"url": "https://youtu.be/docker-test"}))["id"] == vid
            request(port, f"/api/v1/videos/{vid}/tags", {"names": ["Docker"]})
            note_content = "# Docker\r\n\nNote conservée.  \n"
            # La sauvegarde normalise CRLF/CR en LF sans retirer les autres blancs.
            expected_note_content = "# Docker\n\nNote conservée.  \n"
            note_path = f"/api/v1/videos/{vid}/note"
            request(port, note_path, {"content_md": note_content, "expected_revision": 0},
                    expected=201, method="PUT")
            saved_note = json.loads(request(port, note_path))
            assert saved_note["content_md"] == expected_note_content and saved_note["revision"] == 1, saved_note
            # Le fichier secondaire représente les snapshots conservés avec SQLite.
            snapshots = data / "transcripts"
            snapshots.mkdir(exist_ok=True)
            (snapshots / "persistence-check.txt").write_text("snapshot", encoding="utf-8")
            assert (data / "sillage.db").stat().st_uid == os.getuid()
            stop_cleanly()
            records = [json.loads(line) for line in command("docker", "logs", env["SILLAGE_CONTAINER_NAME"]).splitlines()]
            assert any(row.get("event") == "video.added" for row in records), records
            compose("down")
            compose("up", "-d", "--no-build")
            ready()
            persisted = json.loads(request(port, f"/api/v1/videos/{vid}"))
            assert persisted["sources"][0]["title"] == metadata["title"], persisted
            assert persisted["tags"][0]["name"] == "Docker", persisted
            assert (snapshots / "persistence-check.txt").read_text() == "snapshot"
            persisted_note = json.loads(request(port, note_path))
            assert persisted_note["content_md"] == expected_note_content and persisted_note["revision"] == 1, persisted_note
            request(port, note_path, {"content_md": "obsolète", "expected_revision": 0},
                    expected=409, method="PUT")
            stop_cleanly()
            # Vérifier les surcharges sans changer l'image ni les données.
            env["SILLAGE_LOG_FORMAT"] = "text"
            env["SILLAGE_LOG_LEVEL"] = "DEBUG"
            compose("up", "-d", "--no-build", "--force-recreate")
            ready()
            request(port, "/api/v1/videos")
            compose("stop")
            logs = command("docker", "logs", env["SILLAGE_CONTAINER_NAME"])
            assert "level=DEBUG" in logs and "event=http.completed" in logs, logs
            assert "PRIVATE_CLIENT_ID" not in logs
            print("Compose, HTTP/SPA, persistance, JSON/texte et arrêt propre : OK", flush=True)
        except BaseException:
            print(compose("logs", "--no-color"))
            raise
        finally:
            compose("down", "--remove-orphans")


def check_rotation():
    """Exerce local avec un petit seuil dans un conteneur appartenant au test."""
    name = f"sillage-rotation-test-{os.getpid()}"
    try:
        command(
            "docker", "run", "--name", name, "--network", "none",
            "--log-driver", "local", "--log-opt", "max-size=1k",
            "--log-opt", "max-file=2", "--log-opt", "compress=false",
            "--entrypoint", "/bin/sh", IMAGE, "-ec",
            'echo rotation_start; i=0; while [ "$i" -lt 2000 ]; do '
            'echo "rotation_payload_abcdefghijklmnopqrstuvwxyz_0123456789_$i"; '
            'i=$((i+1)); done; echo rotation_end',
        )
        logs = command("docker", "logs", name)
        assert "rotation_end" in logs and "rotation_start" not in logs, logs
        assert len(logs) < 10000, len(logs)
        print("Rotation Docker local avec seuil réduit : OK", flush=True)
    finally:
        command("docker", "rm", "-f", name)


if __name__ == "__main__":
    main()
    check_rotation()
