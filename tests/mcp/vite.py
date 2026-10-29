"""Vérifie le vrai proxy Vite et le serveur Go sur une bibliothèque jetable."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from auth_support import AuthClient, initialize


def main():
    """Utilise des ports isolés et nettoie uniquement les processus de cette recette."""
    ports = []
    for _ in range(2):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            ports.append(probe.getsockname()[1])
    backend, frontend = ports
    base = f"http://127.0.0.1:{frontend}"
    children = []
    with tempfile.TemporaryDirectory(prefix="sillage-vite-mcp-") as temporary:
        env = {k: v for k, v in os.environ.items() if not k.startswith("SILLAGE_")}
        binary = str(ROOT / "bin/sillage")
        initialize([binary, "owner", "init"], temporary, env)
        env.update(SILLAGE_PUBLIC_URL=base, SILLAGE_HTTP_ADDR=f"127.0.0.1:{backend}", SILLAGE_MCP_ENABLED="true")
        try:
            children.append(subprocess.Popen([binary], cwd=temporary, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            # Charger la vraie configuration ; seuls les ports changent pour ne pas
            # interrompre un développement en cours sur 5173/8080.
            launcher = """
import config from './vite.config.ts';
import { createServer } from 'vite';
config.server.port = Number(process.argv[1]);
for (const proxy of Object.values(config.server.proxy)) {
 if (proxy.target !== 'http://127.0.0.1:8080' || proxy.changeOrigin !== false) throw new Error('Unexpected proxy configuration');
 proxy.target = 'http://127.0.0.1:' + process.argv[2];
}
const server = await createServer({ ...config, configFile: false });
await server.listen();
"""
            children.append(subprocess.Popen(["node", "--input-type=module", "-e", launcher, str(frontend), str(backend)], cwd=ROOT / "web", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            client = AuthClient()
            deadline = time.monotonic() + 20
            while True:
                if any(child.poll() is not None for child in children):
                    raise RuntimeError("Un serveur de test s'est arrêté.")
                try:
                    with client.opener.open(base + "/api/v1/auth/session", timeout=1):
                        break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Démarrage trop long.")
                    time.sleep(.1)
            client.login(base)
            request = urllib.request.Request(base + "/api/v1/api-keys", data=b'{"name":"Vite fixture"}', headers={"Content-Type": "application/json"})
            with client.open(request) as response:
                created = json.load(response)
            plain = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def call(expected, path="/mcp", secret=created["secret"], extra=None, url=base):
                """Ne journalise ni le secret synthétique ni les corps sensibles."""
                headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
                if secret:
                    headers["Authorization"] = "Bearer " + secret
                headers.update(extra or {})
                req = urllib.request.Request(url + path, data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers=headers)
                try:
                    with plain.open(req, timeout=5) as response:
                        status, body = response.status, response.read()
                except urllib.error.HTTPError as error:
                    status, body = error.code, b""
                assert status == expected, (path, status, expected)
                if expected == 200:
                    assert len(json.loads(body)["result"]["tools"]) == 4

            call(200)
            call(200, path="/mcp?transport=test")
            call(200, extra={"Origin": base})
            call(401, secret="")
            call(403, extra={"Origin": "http://untrusted.example"})
            call(403, extra={"Host": f"localhost:{frontend}"})
            call(403, url=f"http://127.0.0.1:{backend}")
            call(404, path="/mcp/missing")
            with client.open(urllib.request.Request(base + "/api/v1/api-keys/" + created["key"]["id"], method="DELETE")):
                pass
            call(401)
            print("Vite/Go MCP : catalogue authentifié, Host/Origin, refus anonymes, sous-chemins et révocation vérifiés.")
        finally:
            for child in reversed(children):
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    main()
