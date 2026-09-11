#!/usr/bin/env python3
"""Lance une collection Postman contre Sillage et une base temporaire dédiée."""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
COLLECTIONS = Path(__file__).resolve().parent / "sillage-api"


def parse_args():
    """Expose les deux collections sans sélection implicite des tests YouTube."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", choices=["deterministic", "youtube"])
    parser.add_argument("--serve", action="store_true", help="Garder le serveur ouvert pour Postman ; Ctrl+C pour arrêter.")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--postman", default="postman", help="Commande ou chemin du binaire Postman CLI.")
    parser.add_argument("--youtube-url", help="URL réelle utilisée uniquement par la collection youtube.")
    parser.add_argument("--logs-dir", type=Path, help="Dossier des logs conservés ; temporaire par défaut.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port doit être compris entre 1 et 65535")
    if args.youtube_url and args.collection != "youtube":
        parser.error("--youtube-url exige la collection youtube")
    return args


def wait_for_server(server, base_url):
    """Attend notre processus et vérifie que sa bibliothèque dédiée est vide."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError("Sillage s'est arrêté avant d'être prêt.")
        try:
            with opener.open(base_url + "/api/v1/videos", timeout=1) as response:
                body = json.load(response)
            if body != {"videos": []}:
                raise RuntimeError("La bibliothèque de test n'est pas vide.")
            if server.poll() is not None:
                raise RuntimeError("Le processus Sillage s'est arrêté au démarrage.")
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.1)
    raise RuntimeError("Sillage n'est pas prêt après 10 secondes.")


def stop_process(process):
    """Arrête uniquement le processus lancé ici, avec un délai de fermeture borné."""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=12)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    """Construit le vrai serveur, l'isole, puis conserve le code de sortie de la CLI."""
    args = parse_args()
    go = shutil.which("go")
    if go is None:
        raise RuntimeError("Go doit être disponible dans PATH.")
    postman = None if args.serve else shutil.which(args.postman)
    if not args.serve and postman is None:
        raise RuntimeError("Postman CLI est absent ; utiliser --postman /chemin/vers/postman.")
    if args.collection == "youtube":
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise RuntimeError("La collection YouTube est réservée aux lancements locaux.")
        if shutil.which("yt-dlp") is None:
            raise RuntimeError("La collection YouTube exige le vrai yt-dlp dans PATH.")

    logs_dir = args.logs_dir.resolve() if args.logs_dir else Path(tempfile.mkdtemp(prefix="sillage-postman-logs-"))
    logs_dir.mkdir(parents=True, exist_ok=True)
    base_url = f"http://127.0.0.1:{args.port}"
    print(f"Collection : {args.collection}\nLogs : {logs_dir}", flush=True)

    server = None
    cli = None
    # Le répertoire de travail isole data/sillage.db, sans changer l'application.
    with tempfile.TemporaryDirectory(prefix="sillage-postman-") as workspace:
        workspace = Path(workspace)
        binary = workspace / "sillage"
        subprocess.run([go, "build", "-o", str(binary), "./cmd/server"], cwd=ROOT, check=True)

        # Refuser un port occupé évite d'exécuter la collection contre une autre instance.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", args.port))

        env = os.environ.copy()
        env["SILLAGE_HTTP_ADDR"] = f"127.0.0.1:{args.port}"
        env["SILLAGE_POST_TIMEOUT"] = "60s"
        if args.collection == "deterministic":
            # Aucun exécutable réel ou simulé n'est fourni au serveur pour cette collection.
            empty_path = workspace / "empty-path"
            empty_path.mkdir()
            env["PATH"] = str(empty_path)

        with (logs_dir / "server.log").open("w", encoding="utf-8") as server_log:
            try:
                server = subprocess.Popen([str(binary)], cwd=workspace, env=env, stdout=server_log, stderr=subprocess.STDOUT)
                wait_for_server(server, base_url)
                print(f"Serveur prêt : {base_url}", flush=True)
                if args.serve:
                    print("Ouvrir la collection dans Postman avec cette baseUrl. Ctrl+C pour arrêter.", flush=True)
                    while server.poll() is None:
                        time.sleep(0.5)
                    raise RuntimeError("Le serveur s'est arrêté.")

                command = [
                    postman, "collection", "run", str(COLLECTIONS / args.collection),
                    "--env-var", f"baseUrl={base_url}",
                    "--timeout-request", "75000",
                    "--timeout", "240000",
                    "--bail",
                    "--no-report-events",
                ]
                if args.youtube_url:
                    command += ["--env-var", f"youtubeUrl={args.youtube_url}"]
                with (logs_dir / "postman.log").open("w", encoding="utf-8") as cli_log:
                    cli = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                    for line in cli.stdout:
                        print(line, end="", flush=True)
                        cli_log.write(line)
                    result = cli.wait()
                if result:
                    print(f"Échec Postman ; consulter {logs_dir}", file=sys.stderr)
                return result
            finally:
                stop_process(cli)
                stop_process(server)


def interrupted(signum, frame):
    """Permet au nettoyage normal de s'exécuter aussi sur SIGTERM."""
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Erreur : {error}", file=sys.stderr)
        sys.exit(1)
