#!/usr/bin/env python3
"""Prépare une recette OIDC locale sans modifier la confiance TLS ni le DNS de l'hôte."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STATE = HERE / ".runtime"
IMAGE = "authelia/authelia:4.39.19"


def run(*args):
    """Capture les diagnostics sensibles dans le répertoire privé de recette."""
    env = os.environ.copy()
    if args[0] == "docker":
        # Le moteur local est explicite, indépendamment du contexte courant ou de docker-main.
        args = ("docker", "--host", "unix:///var/run/docker.sock", *args[1:])
        for key in ("DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            env.pop(key, None)
    result = subprocess.run(args, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        (STATE / "failure.log").write_text(result.stdout)
        raise RuntimeError("Commande refusée ; consulter .runtime/failure.log localement.")
    return result.stdout


def compose(*args):
    """Cible toujours le projet isolé, jamais le Compose de développement."""
    return run("docker", "compose", "-p", "sillage-oidc-recipe", "-f", str(STATE / "compose.json"), *args)


def prepare():
    """Crée des secrets aléatoires et deux utilisateurs de test, sans secret en argument."""
    if STATE.exists():
        raise RuntimeError("Recette déjà préparée ; utiliser down ou clean avant une nouvelle préparation.")
    STATE.mkdir(mode=0o700)
    for name in ("config", "data", "authelia", "browser-home"):
        (STATE / name).mkdir(mode=0o700)
    cfg = STATE / "config"
    run("docker", "pull", IMAGE)
    passwords = {}
    hashes = {}
    for name in ("owner", "other", "client"):
        output = run("docker", "run", "--rm", IMAGE, "authelia", "crypto", "hash", "generate", "argon2", "--random", "--random.length", "40")
        values = dict(line.split(": ", 1) for line in output.splitlines() if ": " in line)
        passwords[name], hashes[name] = values["Random Password"], values["Digest"]
    (STATE / "credentials.json").write_text(json.dumps(passwords, indent=2))
    (cfg / "client-secret").write_text(passwords["client"])
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=Sillage OIDC Recipe CA", "-keyout", str(cfg / "ca.key"), "-out", str(cfg / "ca.crt"))
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=auth.sillage.test", "-keyout", str(cfg / "tls.key"), "-out", str(cfg / "tls.csr"))
    (cfg / "tls.ext").write_text("subjectAltName=DNS:auth.sillage.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    run("openssl", "x509", "-req", "-in", str(cfg / "tls.csr"), "-CA", str(cfg / "ca.crt"), "-CAkey", str(cfg / "ca.key"), "-CAcreateserial", "-days", "30", "-extfile", str(cfg / "tls.ext"), "-out", str(cfg / "tls.crt"))
    run("openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(cfg / "signing.key"))
    subject = str(uuid.uuid4())
    users = {name: {"displayname": name, "password": hashes[name], "email": name + "@sillage.test", "groups": []} for name in ("owner", "other")}
    (cfg / "users.json").write_text(json.dumps({"users": users}))
    authelia = {
        "server": {"address": "tcp://:9091/", "tls": {"key": "/config/tls.key", "certificate": "/config/tls.crt"}},
        "log": {"level": "warn"},
        "identity_validation": {"reset_password": {"jwt_secret": secrets.token_hex(32)}},
        "authentication_backend": {"file": {"path": "/config/users.json"}},
        "access_control": {"default_policy": "one_factor"},
        "session": {"secret": secrets.token_hex(32), "cookies": [{"domain": "auth.sillage.test", "authelia_url": "https://auth.sillage.test:9091"}]},
        "storage": {"encryption_key": secrets.token_hex(32), "local": {"path": "/state/db.sqlite3"}},
        "notifier": {"filesystem": {"filename": "/state/notifications.txt"}},
        "identity_providers": {"oidc": {
            "hmac_secret": secrets.token_hex(32),
            "jwks": [{"key_id": "recipe", "algorithm": "RS256", "use": "sig", "key": (cfg / "signing.key").read_text()}],
            "clients": [{"client_id": "sillage-recipe", "client_secret": hashes["client"], "public": False,
                "authorization_policy": "one_factor", "require_pkce": True, "pkce_challenge_method": "S256",
                "redirect_uris": ["http://localhost:18082/api/v1/auth/oidc/callback"], "scopes": ["openid"],
                "grant_types": ["authorization_code"], "response_types": ["code"], "token_endpoint_auth_method": "client_secret_basic"}]
        }}
    }
    (cfg / "authelia.json").write_text(json.dumps(authelia, indent=2))
    (cfg / "sillage.json").write_text(json.dumps({"version": 1, "owner": {"mode": "managed", "username": "owner"}, "authentication": {"policy": "oidc", "oidc": {"issuer": "https://auth.sillage.test:9091", "subject": subject, "client_id": "sillage-recipe", "client_secret_file": "client-secret"}}}, indent=2))
    identity = f"{os.getuid()}:{os.getgid()}"
    configuration = {"services": {
        "authelia": {"image": IMAGE, "user": identity, "command": ["authelia", "--config", "/config/authelia.json"], "ports": ["127.0.0.1:9091:9091"], "volumes": [f"{cfg}:/config:ro", f"{STATE / 'authelia'}:/state"], "networks": {"default": {"aliases": ["auth.sillage.test"]}}},
        "sillage": {"image": "sillage:oidc-recipe", "build": {"context": str(ROOT), "dockerfile": "deployments/docker/Dockerfile"}, "user": identity,
            "ports": ["127.0.0.1:18082:8080"], "volumes": [f"{cfg}:/config:ro", f"{STATE / 'data'}:/app/data"],
            "environment": {"SILLAGE_CONFIG_FILE": "/config/sillage.json", "SILLAGE_PUBLIC_URL": "http://localhost:18082", "SSL_CERT_FILE": "/config/ca.crt", "SILLAGE_SESSION_LIFETIME": "2m", "SILLAGE_SESSION_RENEW_INTERVAL": "1m"}}
    }}
    (STATE / "compose.json").write_text(json.dumps(configuration, indent=2))
    compose("run", "--rm", "authelia", "authelia", "validate-config", "--config", "/config/authelia.json")
    compose("run", "--rm", "authelia", "authelia", "storage", "migrate", "up", "--config", "/config/authelia.json")
    compose("run", "--rm", "authelia", "authelia", "storage", "user", "identifiers", "add", "owner", "--identifier", subject, "--config", "/config/authelia.json")
    print("Préparation terminée. Identifiants dans .runtime/credentials.json ; aucun secret versionné.")


def trust():
    """Prépare uniquement le magasin de confiance du navigateur isolé."""
    home = STATE / "browser-home"
    # certutil est exécuté dans un conteneur jetable, sans installation sur l'hôte.
    run("docker", "run", "--rm", "-v", f"{home}:/recipe", "-v", f"{STATE / 'config' / 'ca.crt'}:/ca.crt:ro", "debian:bookworm-slim", "sh", "-ec",
        "apt-get update -qq && apt-get install -y -qq libnss3-tools >/dev/null && mkdir -p /recipe/.pki/nssdb && if [ ! -f /recipe/.pki/nssdb/cert9.db ]; then certutil -N --empty-password -d sql:/recipe/.pki/nssdb; fi && certutil -A -d sql:/recipe/.pki/nssdb -n recipe -t C,, -i /ca.crt && chown -R " + f"{os.getuid()}:{os.getgid()} /recipe")
    modern = home / ".local/share/pki/nssdb"
    modern.parent.mkdir(parents=True, exist_ok=True)
    if not modern.exists(): modern.symlink_to(home / ".pki/nssdb", target_is_directory=True)


def browser():
    """Ouvre Chromium WSLg avec confiance NSS et profil exclusivement réservés à la recette."""
    trust()
    home = STATE / "browser-home"
    candidates = sorted((Path.home() / ".cache/ms-playwright").glob("chromium-*/chrome-linux64/chrome"))
    if not candidates:
        raise RuntimeError("Installer Chromium avec web/node_modules/.bin/playwright install chromium.")
    env = dict(os.environ, HOME=str(home))
    subprocess.run([str(candidates[-1]), "--user-data-dir=" + str(home / "profile"), "--no-first-run", "--host-resolver-rules=MAP auth.sillage.test 127.0.0.1", "http://localhost:18082"], env=env, check=True)


if __name__ == "__main__":
    os.umask(0o077)
    action = sys.argv[1] if len(sys.argv) == 2 else "help"
    if action == "prepare": prepare()
    elif action == "up": compose("up", "-d", "--build")
    elif action == "down": compose("down", "--remove-orphans")
    elif action == "browser": browser()
    elif action == "clean":
        compose("down", "--remove-orphans")
        if STATE.resolve() != HERE / ".runtime": raise RuntimeError("Chemin de nettoyage invalide")
        shutil.rmtree(STATE)
    else: print("Usage: python3 tests/manual/oidc/lab.py prepare|up|browser|down|clean")
