#!/usr/bin/env python3
"""Valide le provisionnement Compose sans terminal et la rotation sur une bibliothèque isolée."""

import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from auth_support import AuthClient, PASSWORD, USERNAME


def main():
    """Démarre avec les vrais fichiers Compose, sans commande owner init."""
    with tempfile.TemporaryDirectory(prefix="sillage-declarative-") as temporary:
        root = Path(temporary)
        data = root / "data"
        config = root / "config"
        data.mkdir(mode=0o700)
        config.mkdir(mode=0o700)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base_url = f"http://127.0.0.1:{port}"
        image = root / "image.json"
        image.write_text(json.dumps({"services": {"sillage": {
            "image": os.environ.get("SILLAGE_TEST_IMAGE", "sillage:local"),
        }}}))
        env = os.environ.copy()
        env.update({
            "COMPOSE_FILE": ":".join(str(p) for p in [
                ROOT / "deployments/docker/compose.yaml",
                ROOT / "deployments/docker/compose.declarative.yaml",
                image,
            ]),
            "COMPOSE_PROJECT_NAME": "sillage-declarative-" + uuid.uuid4().hex[:8],
            "SILLAGE_CONTAINER_NAME": "sillage-declarative-" + uuid.uuid4().hex[:8],
            "SILLAGE_DATA_DIR": str(data),
            "SILLAGE_CONFIG_DIR": str(config),
            "SILLAGE_UID": str(os.getuid()),
            "SILLAGE_GID": str(os.getgid()),
            "SILLAGE_PORT": str(port),
            "SILLAGE_PUBLIC_URL": base_url,
            "SILLAGE_MCP_ENABLED": "false",
        })
        declaration = {"version": 1, "owner": {
            "mode": "managed", "username": USERNAME, "password_file": "owner-password",
        }}
        config_file = config / "sillage.json"
        config_file.write_text(json.dumps(declaration))
        secret_file = config / "owner-password"
        secret_file.write_text(PASSWORD)
        secret_file.chmod(0o600)

        def compose(*args, check=True):
            """Les arguments et diagnostics ne contiennent aucun secret."""
            result = subprocess.run(["docker", "compose", *args], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=90)
            if check and result.returncode:
                raise RuntimeError("La commande Compose de test a échoué.")
            return result

        def ready():
            """Attend la sonde publique du serveur de test."""
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    client = AuthClient()
                    with client.open(base_url + "/api/v1/auth/session"):
                        return
                except (urllib.error.URLError, OSError):
                    time.sleep(0.1)
            raise RuntimeError("Le serveur déclaratif n'est pas prêt.")

        def owner():
            """Relit uniquement l'état d'identité pour détecter les réécritures inutiles."""
            with sqlite3.connect(data / "sillage.db") as db:
                return db.execute("SELECT username, password_hash, version, managed FROM owner").fetchone()

        def rejected():
            """Une configuration invalide doit arrêter le conteneur sans altérer le propriétaire."""
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                result = subprocess.run(
                    ["docker", "inspect", "--format", "{{.State.Status}}", env["SILLAGE_CONTAINER_NAME"]],
                    capture_output=True, text=True, timeout=10,
                )
                if result.stdout.strip() == "exited":
                    return
                time.sleep(0.1)
            raise RuntimeError("Une configuration invalide n'a pas fermé le serveur.")

        try:
            compose("up", "-d", "--no-build")
            ready()
            client = AuthClient()
            client.login(base_url)
            original = owner()
            request = urllib.request.Request(base_url + "/api/v1/persons",
                data=json.dumps({"name": "Personne conservée A3.1"}).encode(),
                headers={"Content-Type": "application/json"})
            with client.open(request) as response:
                person = json.load(response)
            compose("restart")
            ready()
            assert owner() == original, "Le redémarrage a réécrit le propriétaire."
            with client.open(base_url + "/api/v1/persons/" + str(person["id"])):
                pass
            refused = compose("run", "--rm", "-T", "sillage", "owner", "recover", check=False)
            assert refused.returncode != 0 and "declaratively managed" in refused.stderr + refused.stdout

            rotated = "a rotated declarative test password"
            secret_file.write_text(rotated)
            compose("restart")
            ready()
            assert owner()[2] == original[2] + 1
            try:
                client.open(base_url + "/api/v1/videos")
                raise AssertionError("L'ancienne session a survécu.")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            replacement = AuthClient()
            replacement.login(base_url, password=rotated)
            with replacement.open(base_url + "/api/v1/persons/" + str(person["id"])):
                pass
            persisted = owner()

            declaration["owner"]["unexpected"] = "PRIVATE_CONFIGURATION_VALUE"
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            rejected()
            assert owner() == persisted
            del declaration["owner"]["unexpected"]
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            ready()
            with replacement.open(base_url + "/api/v1/videos"):
                pass
            assert owner() == persisted
            # Un fournisseur hors ligne ne bloque ni le démarrage, ni la session locale autorisée.
            client_secret = config / "client-secret"
            client_secret.write_text("PRIVATE_OIDC_CLIENT_SECRET")
            declaration["owner"]["adopt_existing"] = True
            declaration["authentication"] = {"policy": "both", "oidc": {
                "issuer": "https://unreachable.invalid", "subject": "declared-subject",
                "client_id": "sillage", "client_secret_file": "client-secret",
            }}
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            ready()
            replacement.login(base_url, password=rotated)
            with replacement.open(base_url + "/api/v1/auth/session") as response:
                assert json.load(response)["methods"] == "both"
            before_rotation = owner()
            client_secret.write_text("PRIVATE_ROTATED_OIDC_SECRET")
            compose("restart")
            ready()
            assert owner() == before_rotation, "La rotation technique a modifié la génération."
            with replacement.open(base_url + "/api/v1/videos"):
                pass
            declaration["authentication"]["policy"] = "oidc"
            del declaration["owner"]["password_file"]
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            ready()
            assert owner()[1] == "", "Le propriétaire OIDC conserve un secret local omis."
            try:
                replacement.open(base_url + "/api/v1/videos")
                raise AssertionError("La transition OIDC n'a pas révoqué la session.")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            try:
                AuthClient().login(base_url, password=rotated)
                raise AssertionError("Le login local est disponible en mode OIDC seul.")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            persisted_oidc = owner()
            authentication = declaration.pop("authentication")
            declaration["owner"]["password_file"] = "owner-password"
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            rejected()
            assert owner() == persisted_oidc
            declaration["authentication"] = authentication
            del declaration["owner"]["password_file"]
            config_file.write_text(json.dumps(declaration))
            compose("restart")
            ready()
            assert owner() == persisted_oidc
            logs = compose("logs", "--no-color").stdout
            for forbidden in (PASSWORD, rotated, "PRIVATE_CONFIGURATION_VALUE", "PRIVATE_OIDC_CLIENT_SECRET", "PRIVATE_ROTATED_OIDC_SECRET", str(config)):
                assert forbidden not in logs, "Un diagnostic expose une donnée privée."
            inspection = json.loads(subprocess.check_output(
                ["docker", "inspect", env["SILLAGE_CONTAINER_NAME"]], text=True))[0]
            mount = next(m for m in inspection["Mounts"] if m["Destination"] == "/run/sillage-config")
            assert mount["RW"] is False
            print("Compose déclaratif, rotations, politiques OIDC hors ligne et refus des replis implicites : OK")
        finally:
            compose("down", "--remove-orphans", check=False)


if __name__ == "__main__":
    main()
