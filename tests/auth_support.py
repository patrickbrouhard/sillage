"""Prépare une identité de test via la vraie commande interactive et authentifie les clients HTTP."""

import http.cookiejar
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import termios
import time
import urllib.request

USERNAME = "test-owner"
PASSWORD = "sillage test password phrase"


def initialize(command, cwd, env=None):
    """Pilote le terminal réel sans ajouter de voie d'initialisation spéciale au serveur."""
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave)
    buffer = b""
    try:
        for prompt, answer, secret in [
            (b"Identifiant", USERNAME, False),
            (b"Nouveau mot de passe", PASSWORD, True),
            (b"Confirmez", PASSWORD, True),
        ]:
            deadline = time.monotonic() + 20
            while prompt not in buffer:
                if time.monotonic() > deadline or process.poll() is not None:
                    raise RuntimeError("La commande interactive d'initialisation a échoué.")
                if select.select([master], [], [], 0.1)[0]:
                    buffer += os.read(master, 4096)
            buffer = b""
            # Attendre la désactivation de l'écho avant d'envoyer un secret au pseudo-terminal.
            while secret and termios.tcgetattr(slave)[3] & termios.ECHO:
                if time.monotonic() > deadline:
                    raise RuntimeError("La saisie masquée n'est pas prête.")
                time.sleep(0.01)
            os.write(master, (answer + "\n").encode())
        if process.wait(timeout=20) != 0:
            raise RuntimeError("La commande d'initialisation a échoué.")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


class AuthClient:
    """Utilise le même login, cookie et CSRF que React."""
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.jar),
        )
        self.csrf = ""

    def login(self, base, username=USERNAME, password=PASSWORD):
        """Établit une session et garde les secrets uniquement dans le client de test."""
        with self.opener.open(base + "/api/v1/auth/session", timeout=5) as response:
            self.csrf = json.load(response)["csrf_token"]
        request = urllib.request.Request(
            base + "/api/v1/auth/login",
            data=json.dumps({"username": username, "password": password}).encode(),
            headers={"Content-Type": "application/json", "X-CSRF-Token": self.csrf},
        )
        with self.opener.open(request, timeout=5) as response:
            self.csrf = json.load(response)["csrf_token"]

    def open(self, request, timeout=5):
        """Ajoute le jeton aux mutations sans modifier leur corps ni leurs préconditions."""
        if isinstance(request, urllib.request.Request):
            request.add_header("X-CSRF-Token", self.csrf)
        return self.opener.open(request, timeout=timeout)

    def playwright_state(self):
        """Expose la session synthétique au navigateur et au client REST de Playwright."""
        return {
            "cookies": [
                {"name": cookie.name, "value": cookie.value, "domain": cookie.domain,
                 "path": cookie.path, "expires": cookie.expires or -1,
                 "httpOnly": True, "secure": cookie.secure, "sameSite": "Lax"}
                for cookie in self.jar if cookie.name == "sillage_session"
            ],
            "origins": [],
        }
