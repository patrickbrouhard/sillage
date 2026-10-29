# Clés API et intégrations MCP

Sillage conserve un propriétaire et une bibliothèque uniques. Les clés sont des
identifiants individuels d'intégration, indépendants des sessions Web et du fournisseur
OIDC. Leur unique permission `mcp:read` donne accès aux quatre outils existants sur
l'ensemble de la bibliothèque. Aucun accès REST ou administratif par clé n'est accepté.

## Administration Web

Navigation → Paramètres · Clés API permet de créer, consulter les métadonnées et
révoquer les clés individuellement ou globalement, sans arrêter le serveur.
Le nom est obligatoire (128 octets maximum). L'expiration est absolue et facultative ;
l'absence d'expiration doit être choisie explicitement dans l'interface.
Le secret est affiché une seule fois après création et disparaît à la fermeture de
l'encart, au départ de la page, au verrouillage ou lors d'un remplacement de session.
Une sonde périodique ou un retour de focus confirmant la même session conserve le secret
et n'invalide pas une création en attente.
Il n'est pas conservé dans le stockage du navigateur. La copie exige un contexte
accepté par le navigateur ; une sélection manuelle reste possible.

Une erreur réseau peut masquer une création réussie. Aucune mutation n'est rejouée
implicitement : actualiser la liste, révoquer la clé dont le secret est perdu, puis
créer sa remplaçante. La rotation consiste à créer une nouvelle clé, vérifier le client,
puis révoquer l'ancienne. Il n'existe pas de réaffichage ni de réactivation du secret.

| Route | Contrat |
| --- | --- |
| `GET /api/v1/api-keys` | Liste des métadonnées, sans empreinte ni secret |
| `POST /api/v1/api-keys` | JSON `name`, `expires_at` nullable ; 201 avec `key` et `secret` |
| `DELETE /api/v1/api-keys/{id}` | Révocation idempotente ; 204 |
| `POST /api/v1/api-keys/revoke-all` | Révocation de toutes les clés présentes ; 204 |

Ces routes exigent une session Web valide et le CSRF pour les mutations. La création
revérifie la session et ses échéances dans la transaction d'insertion pour empêcher
une émission tardive après déconnexion. La session courante suffit : cette tranche
n'ajoute pas de réauthentification renforcée. Une session compromise peut donc émettre
une clé durable de lecture ; ce choix devra être réexaminé avant les écritures MCP.

Les secrets sont générés aléatoirement et seule leur empreinte SHA-256 est persistée.
Les clés révoquées restent visibles pour faciliter la réconciliation. Aucun secret
ou empreinte n'est journalisé. La vérification relit SQLite à chaque requête ; une
panne ferme l'accès avec 503. Une révocation interdit les nouvelles vérifications,
sans reprendre les données déjà envoyées ni annuler une lecture déjà autorisée.

## Activation MCP

MCP est actif par défaut sur `/mcp`, avec Bearer obligatoire.
`SILLAGE_MCP_ENABLED=false` désactive le transport et renvoie 404. Les sous-chemins restent inexistants. Un cookie Web seul est refusé.
Les contrôles Host/Origin utilisent l'origine canonique `SILLAGE_PUBLIC_URL` : HTTP
loopback ou HTTPS explicitement configuré. Aucun en-tête de proxy ne fait autorité.
La terminaison TLS et l'exposition homelab ne sont pas fournies par cette tranche.

Exemple de configuration Codex (secret dans l'environnement du processus client) :

```toml
[mcp_servers.sillage]
url = "http://127.0.0.1:8080/mcp"
bearer_token_env_var = "SILLAGE_MCP_TOKEN"
```

En développement avec Vite :

```bash
make dev-api
# Dans un autre terminal :
make web-dev
```

`make dev-api` utilise par défaut `SILLAGE_PUBLIC_URL=http://127.0.0.1:5173`.
Une variable d’environnement explicitement définie conserve sa valeur. Le binaire
lancé directement conserve son défaut propre ; le Makefile ne charge pas `.env`.

Configurer le client MCP sur `http://127.0.0.1:5173/mcp`. Vite relaie `/mcp` et
ses sous-chemins vers Go en conservant Host et Origin, comme pour REST. L'accès direct
au port 8080 avec son Host habituel reste refusé lorsque l'origine canonique est 5173.
Il ne faut pas ajouter d'autorité alternative ni activer `changeOrigin`.
La recette `python3 tests/mcp/vite.py` vérifie ce parcours sur une base jetable,
après `make build`, sur des ports isolés sans arrêter un développement en cours.

La clé voyage uniquement dans `Authorization: Bearer …`, jamais dans une URL.
Aucun parcours OAuth MCP n'est annoncé. Les [contrats MCP](mcp.md) restent inchangés.

## Autorité et récupération

Les clés sont administrées en base, même si l'identité du propriétaire est déclarative.
Les modifications de nom, mot de passe, politique locale/OIDC, issuer, subject, client
ID ou secret client préservent les clés. Elles conservent les effets existants sur les
sessions Web. `owner recover`, `owner recover-auth` et `owner release` préservent
également les clés : récupérer l'accès ne signifie pas traiter une compromission.

Après compromission ou transfert réel de propriété, arrêter le serveur puis lancer :

```bash
./bin/sillage security-reset
```

La commande exige un terminal et la confirmation `RESET`. Elle utilise la même base
`data/sillage.db`, révoque sessions et clés atomiquement, et invalide les connexions
en cours sans modifier l'autorité déclarative ou la configuration OIDC. Elle reste
disponible en mode managed. Corriger les identifiants compromis avant redémarrage.
Une restauration de sauvegarde peut restaurer des accès anciens : effectuer cette
réinitialisation avant réouverture. Révoquer toutes les clés depuis le Web ne révoque
pas les sessions et ne constitue donc pas une récupération complète après incident.
