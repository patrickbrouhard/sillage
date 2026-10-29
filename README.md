# Sillage

**Sillage** est une base de connaissances personnelle centrée sur la vidéo. L'application permet de regarder une vidéo, prendre des notes Markdown, conserver des passages horodatés et des captures, puis retrouver les connaissances qui en découlent.

YouTube est actuellement la source prise en charge. La conception distingue la vidéo comme objet de connaissance (`Video`), sa provenance (`VideoSource`) et son éventuel fichier local (`MediaFile`). Le projet est **self-hosted**, utilisable sans intelligence artificielle et toujours en développement.

> **État du projet :** le socle de travail vidéo est fonctionnel. L’authentification Web locale et OIDC est disponible ; MCP est temporairement désactivé jusqu’à la tranche des clés API ; l’IA intégrée reste à développer. Voir la [roadmap](docs/05-roadmap.md) pour les prochains jalons.

## Déploiement déclaratif sans interaction

A3.1 permet de préparer un fichier JSON et un fichier de mot de passe, puis de démarrer
avec `docker compose up -d`, sans `owner init`. La [référence de configuration](docs/configuration.md)
décrit le complément Compose, le fichier `.env`, l'adoption explicite d'une bibliothèque
existante, la rotation et le retour à l'administration locale.
Le [démarrage Docker interactif](#démarrage-rapide-avec-docker) reste également disponible.

## Fonctionnalités disponibles

- **Bibliothèque** : ajout de vidéos YouTube par URL, extraction des métadonnées avec `yt-dlp`, détection des doublons et consultation des fiches.
- **Classement** : catalogue partagé sur `/tags` avec compteurs, renommage et suppression ; filtre de bibliothèque par tag ; associations explicites des comptes de publication et personnes, accessibles par REST.
- **Espace de travail** : lecteur vidéo, note Markdown et transcription, avec mise en page adaptée aux écrans desktop et mobile. En-tête compact, navigation latérale, thèmes clair/sombre/système et panneaux Note/Informations.
- **Notes** : éditeur CodeMirror 6, lecture Markdown/GFM, sauvegarde automatique, protection par révision contre les écrasements concurrents, historique Undo/Redo et références temporelles interactives.
- **Transcriptions YouTube** : acquisition explicite de sous-titres automatiques sélectionnés, conservation du JSON3, lecture hors réseau depuis le snapshot, recherche textuelle locale, navigation par timestamp et citation d'extraits dans la note.
- **Lecture distante et locale** : lecteur YouTube ou HTML5 natif, conservation volontaire d'une vidéo avec `yt-dlp`, suivi du téléchargement, consultation des propriétés techniques, suppression explicite du fichier et bascule entre lecteurs. Si le fichier est disponible à l'ouverture, **Local** est sélectionné en premier ; aucune lecture ne démarre automatiquement.
- **Captures PNG** : extraction d'une image au temps courant avec `ffmpeg`, insertion dans la note et conservation indépendante du fichier vidéo et du Markdown qui la référence.
- **Recherche globale** : titres et descriptions des sources, publishers, tags directs et notes ; résultats paginés, extraits et explications.
- **MCP temporairement désactivé** : adapter de lecture conservé, en attente de l’authentification des intégrations.
- **API REST** : accès aux vidéos, notes, tags, transcriptions, publishers, personnes, fichiers locaux et captures.

La recherche **dans une transcription ouverte** reste distincte de la recherche globale, qui n’indexe pas les transcriptions. L’IA intégrée, l’import de vidéos locales et les annotations structurées constituent des travaux futurs.

## Démarrage rapide avec Docker

La distribution initiale cible **Linux AMD64**, notamment Linux natif et WSL2, avec Docker Engine et Compose v2 (ou Docker Desktop intégré à WSL2). L'image rassemble le serveur Go, le frontend compilé, `yt-dlp`, Deno, `ffmpeg` et `ffprobe`. Il n'est pas nécessaire de les installer séparément sur l'hôte.

Depuis la racine du dépôt :

```bash
export SILLAGE_DATA_DIR="$HOME/.local/share/sillage"
export SILLAGE_UID="$(id -u)"
export SILLAGE_GID="$(id -g)"

mkdir -p "$SILLAGE_DATA_DIR"
chmod 700 "$SILLAGE_DATA_DIR"

docker compose -f deployments/docker/compose.yaml config
docker compose -f deployments/docker/compose.yaml build
docker compose -f deployments/docker/compose.yaml run --rm sillage owner init
docker compose -f deployments/docker/compose.yaml up -d
```

Ouvrir **<http://127.0.0.1:8080>**. Se connecter avec le propriétaire créé dans le terminal. Aucun identifiant par défaut n'existe. Le port reste publié sur `127.0.0.1` ; l'exposition HTTPS/homelab relève d'une tranche distincte. Voir [Sécurité](docs/security.md).

Pour consulter les logs et arrêter l'application :

```bash
docker compose -f deployments/docker/compose.yaml logs -f
docker compose -f deployments/docker/compose.yaml down
```

`down` ne supprime pas le répertoire de données monté depuis l'hôte. `make up`, `make logs` et `make down` imposent ce fichier Compose de base. Pour le parcours déclaratif avec `COMPOSE_FILE`, utiliser directement `docker compose`, afin de conserver le complément de configuration.

### Configuration Docker

Depuis la racine du dépôt, copier [l'exemple commenté](deployments/docker/.env.example), puis adapter ses valeurs :

```bash
cp deployments/docker/.env.example deployments/docker/.env
```

Compose lit automatiquement `deployments/docker/.env` avec les commandes `-f deployments/docker/compose.yaml` ci-dessus. Seule **`SILLAGE_DATA_DIR` est obligatoire** ; toutes les autres variables disposent de valeurs par défaut dans le [fichier Compose](deployments/docker/compose.yaml).

La configuration minimale recommandée comprend :

| Variable | Valeur par défaut | Usage |
| --- | --- | --- |
| `SILLAGE_DATA_DIR` | Aucune (obligatoire) | Chemin absolu du répertoire de données |
| `SILLAGE_UID` | `1000` | UID du processus dans le conteneur ; adapter avec `id -u` |
| `SILLAGE_GID` | `1000` | GID du processus dans le conteneur ; adapter avec `id -g` |
| `SILLAGE_PORT` | `8080` | Port HTTP sur l'hôte |

Le répertoire de données doit **exister avant le démarrage** et permettre la lecture, l'écriture et la traversée à l'UID/GID configuré. Compose ne le crée pas automatiquement. Le fichier `.env` est ignoré par Git ; les variables déjà exportées dans le shell prévalent sur son contenu.

Par défaut, les données sont montées dans `/app/data` ; le processus s'exécute sans privilèges root, et le service HTTP écoute sur le port `8080` dans le conteneur. Pour une deuxième installation sur le même hôte, choisir des valeurs distinctes pour le port, le nom du conteneur et le répertoire de données.

## Développement local

Prérequis : **Go 1.27.1**, **Node.js 24**, npm, Make et, pour les acquisitions réelles, `yt-dlp`, `ffmpeg` et `ffprobe` disponibles dans le `PATH`. Les fonctionnalités YouTube peuvent aussi dépendre d'un moteur JavaScript pris en charge par `yt-dlp` (Deno est intégré à l'image Docker).

### Compilation et lancement

```bash
make web-install  # npm ci dans web/
make build        # TypeScript + Vite, puis compilation Go
./bin/sillage owner init  # une fois, serveur arrêté ; saisie interactive masquée
make run          # serveur Go et interface compilée
```

Ouvrir <http://127.0.0.1:8080>. Le processus utilise `data/` relativement au répertoire courant. `make run` sert `web/dist` par l'intermédiaire de `SILLAGE_WEB_DIR` ; reconstruire après une modification du frontend.

### Mode développement

Démarrer deux terminaux depuis la racine :

```bash
# Terminal 1 : API Go
SILLAGE_PUBLIC_URL=http://127.0.0.1:5173 make dev-api
```

```bash
# Terminal 2 : Vite, avec rechargement du frontend
make web-dev
```

Ouvrir <http://127.0.0.1:5173>. Vite relaie les requêtes `/api` vers le serveur Go sur `127.0.0.1:8080`. Sans `SILLAGE_WEB_DIR`, le serveur Go fonctionne en mode **API seule**. Ne pas lancer parallèlement deux serveurs sur le même répertoire `data/`.

### Variables du serveur

| Variable | Défaut hors Docker | Effet |
| --- | --- | --- |
| `SILLAGE_CONFIG_FILE` | Non défini | Fichier JSON de provisionnement local ; voir [Configuration](docs/configuration.md) |
| `SILLAGE_HTTP_ADDR` | `127.0.0.1:8080` | Adresse d'écoute HTTP |
| `SILLAGE_WEB_DIR` | Non défini | Répertoire du build Web à servir ; sinon API seule |
| `SILLAGE_MCP_ENABLED` | `false` | `true` est temporairement refusé |
| `SILLAGE_PUBLIC_URL` | `http://127.0.0.1:PORT` | Origine canonique du navigateur et politique de cookies |
| `SILLAGE_SESSION_LIFETIME` | `12h` | Durée absolue des nouvelles sessions |
| `SILLAGE_SESSION_IDLE_TIMEOUT` | `1h` | Délai sans requête authentifiée |
| `SILLAGE_POST_TIMEOUT` | `60s` | Délai des acquisitions synchrones de métadonnées et transcriptions |
| `SILLAGE_DOWNLOAD_TIMEOUT` | `6h` | Délai des téléchargements médias |
| `SILLAGE_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` ou `ERROR` |
| `SILLAGE_LOG_FORMAT` | `text` | `text` ou `json` ; Docker définit `json` par défaut |

Les délais sont des durées Go strictement positives, par exemple `90s` ou `2h`. La base utilisée par le serveur reste `data/sillage.db`, chemin relatif au répertoire de travail : il n'existe pas de variable de configuration pour la déplacer indépendamment de `data/`.

## Authentification et MCP

Le propriétaire et les sessions sont conservés dans SQLite. En administration locale, la commande interactive
`owner recover`, exécutée serveur arrêté, remplace le mot de passe et révoque toutes les
sessions. Le menu Navigation > Session permet la déconnexion du navigateur ou de toutes
les sessions. Une reconnexion conserve la note en cours dans l'onglet.

MCP est temporairement indisponible jusqu'à la tranche des clés API :
`SILLAGE_MCP_ENABLED=true` refuse le démarrage et `/mcp` renvoie 404.
Les contrats de l'adapter sont conservés dans [MCP](docs/mcp.md).
Les commandes, cookies, CSRF, durées et limites sont détaillés dans [Sécurité](docs/security.md).

## Données, sauvegarde et mises à jour

Le répertoire persistant contient notamment :

```text
data/
├── sillage.db       # SQLite et migrations
├── transcripts/     # snapshots des transcriptions acquises
├── media/           # vidéos téléchargées
└── assets/          # captures PNG
```

**Sauvegarder l'ensemble de ce répertoire, jamais uniquement `sillage.db`.** Les médias, captures et snapshots ne sont pas contenus dans SQLite. Une seule instance Sillage doit utiliser un répertoire de données donné.

### Sauvegarde à froid sous Docker

Compose lit le `.env`, mais n'exporte pas ses variables dans le shell. Pour `tar`, définir `SILLAGE_DATA_DIR` dans le terminal avec **le même chemin que celui utilisé par Compose** :

```bash
export SILLAGE_DATA_DIR="/home/utilisateur/.local/share/sillage"  # À adapter
test -d "${SILLAGE_DATA_DIR:?Définir le répertoire de données}" || exit 1

docker compose -f deployments/docker/compose.yaml stop
tar -C "$SILLAGE_DATA_DIR" -czf "$HOME/sillage-backup-$(date +%Y%m%d-%H%M%S).tar.gz" .
docker compose -f deployments/docker/compose.yaml start
```

Pour restaurer, arrêter le conteneur, extraire l'archive dans **un nouveau répertoire vide**, vérifier les permissions, puis pointer `SILLAGE_DATA_DIR` sur ce dossier avant de recréer le conteneur. Conserver l'ancien répertoire tant que la restauration n'est pas validée.

La publication des fichiers est prudente : après un incident SQL, un crash ou une restauration, des fichiers non référencés peuvent rester sur disque. **Ne pas les effacer automatiquement** : certains peuvent correspondre à des données qu'une sauvegarde plus ancienne ne référence plus. L'inventaire et la maintenance de ces fichiers restent à définir.

### Mise à jour de l'image

Sauvegarder les données avant une mise à jour, puis reconstruire et recréer :

```bash
docker compose -f deployments/docker/compose.yaml build --pull
docker compose -f deployments/docker/compose.yaml up -d --force-recreate
```

Le Dockerfile épingle les images de base ainsi que les versions et empreintes des exécutables téléchargés (`yt-dlp`, Deno). Les actualiser demande une modification ou des arguments de build **explicites** ; Sillage ne met pas automatiquement ces outils à jour au démarrage. Consulter `deployments/docker/Dockerfile` pour les versions actuellement embarquées et les arguments disponibles.

## Utiliser l'espace de travail

Sur une fiche vidéo, le lecteur et la transcription s'appuient sur la même **source de travail**. La note appartient à la vidéo, indépendamment de ses sources. Sur desktop, le lecteur et la transcription composent la partie droite ; la zone Note/Informations reste indépendante.

- **`+ Temps`** insère dans la note, en mode Édition, une référence telle que `[12:42](sillage://videos/5/sources/5?start_ms=762345)`. Les IDs vidéo/source et le timestamp en millisecondes en conservent la provenance. Cette insertion n'engage aucune lecture.
- **Transcription** : après acquisition explicite, les timestamps permettent la navigation dans le lecteur actif, la recherche reste locale au contenu chargé, et « Citer dans la note » peut insérer un extrait avec son lien temporel. Une note non vide exige de choisir préalablement une position d'insertion.
- **Citations Markdown** : les callouts `[!quote]` et `[!quote:tr]` sont reconnus en Lecture ; les références temporelles canoniques disposent également d'une présentation et de gestes adaptés dans CodeMirror.
- **YouTube / Local** : la bascule s'effectue sans lecture automatique ; elle tente de conserver une position admissible dans la session. Les actions d'annotation nécessitent une **position courante réellement disponible**, et non un simple départ préparé.
- **Conservation** : cliquer Local sans fichier peut proposer le téléchargement. Le fichier reste une représentation de la source, pas une nouvelle vidéo. Le lecteur Local repose sur les capacités HTML5 du navigateur : un fichier valide n'est pas forcément décodable par celui-ci.
- **Images** : le bouton à côté de Note/Informations retrouve les captures de la vidéo, toutes sources et même sans référence Markdown ; consultation en Lecture, réinsertion en Édition au point explicitement choisi.
- **Captures** : `+ Capture` demande un PNG au temps courant ; l'Asset est conservé séparément de son insertion Markdown. Retirer une référence de la note ne supprime pas l'image.

Le comportement détaillé des lecteurs, de l'éditeur et des interactions est spécifié dans [Product & UX](docs/01-product-and-ux.md). Une [recette manuelle ciblée](docs/07-local-playback-validation.md) couvre les interactions que les simulations de navigateur ne suffisent pas à confirmer.

## Recherche globale et maintenance

`GET /api/v1/search?q=kube&page=1` recherche les titres et descriptions de toutes les sources, leurs publishers, les tags directement associés aux vidéos et le texte dérivé des notes. Une vidéo apparaît une seule fois. Les transcriptions et tags indirects sont exclus.

Le paramètre facultatif `sort` accepte exactement `relevance` (défaut : BM25 puis ID vidéo croissant) et `newest` (date d'ajout dans Sillage décroissante, puis ID décroissant). Par exemple : `GET /api/v1/search?q=Kubernetes&sort=newest`. La date n'est ni celle de publication ni celle de modification. Un tri vide, inconnu, de casse différente ou répété donne HTTP 400 (`bad_request`).

Les termes sont combinés par ET, même entre champs ou sources. Les tokens de quatre lettres ou chiffres Unicode ou plus utilisent un préfixe ; les termes courts et techniques (`C++`, `C#`) restent entiers. Les guillemets et opérateurs ne donnent accès à aucune syntaxe FTS. La recherche ignore la casse et les accents latins pris en charge par SQLite unicode61.

La réponse contient `results`, `page`, `has_more` et `total`, avec 20 résultats par page. `total` compte toutes les vidéos correspondantes, indépendamment de la page et du tri. Chaque résultat fournit la vidéo, un extrait de note en segments texte/surlignage et les sources contributrices. Les extraits donnent un contexte borné, pas la note entière. La saisie est limitée à 1 024 octets UTF-8 et 32 tokens ; les pages vont de 1 à 1 000. Les paramètres invalides donnent une erreur 400.

Le [contrat technique de recherche](docs/search.md) détaille les paramètres et réponses REST, la tokenisation, les extraits et les garanties de cohérence.

Une recherche sans correspondance retourne par exemple :

```json
{"results": [], "page": 1, "has_more": false, "total": 0}
```

Sur une page au-delà des résultats, `results` est vide et `has_more` vaut `false`, mais `total` conserve le nombre de vidéos correspondantes.

L'ouverture de la base applique la migration additive puis initialise la projection versionnée depuis les données originales dans une transaction atomique. Pour régénérer explicitement cette projection, arrêter le serveur puis lancer depuis la racine :

```bash
go run ./cmd/search-rebuild -db data/sillage.db
```

Cette opération réextrait les notes sans modifier leur Markdown, dates ou révisions. Un échec ou une interruption annule la reconstruction. La prochaine ouverture reprend une initialisation encore nécessaire ; si la version était déjà courante, relancer explicitement la commande de maintenance. Il ne s'agit pas de la commande interne FTS `rebuild`.

## API REST

Le serveur expose l'API sous **`/api/v1`**. Les exemples suivants utilisent `http://127.0.0.1:8080`. L'API exige un cookie de session Web ; ses mutations exigent aussi `X-CSRF-Token`. Les exemples métier ci-dessous supposent ces en-têtes. Voir le [protocole de connexion](docs/security.md#routes-csrf-et-diagnostics). Aucune clé API n'est encore disponible.

Les corps JSON sont validés strictement : types de données, champs inconnus, UTF-8 et limites de taille. Les handlers renvoient des statuts HTTP et des codes d'erreur publics, sans chemins de fichiers internes ni sortie brute des outils.

### Vidéos

| Méthode | Route | Comportement |
| --- | --- | --- |
| `POST` | `/api/v1/videos` | Ajoute une URL YouTube ; `201` à la création, `200` si elle est déjà connue, sans rafraîchissement implicite |
| `GET` | `/api/v1/videos` | Bibliothèque sous `{"videos": [...]}` ; filtre facultatif `?tag_id=7` |
| `GET` | `/api/v1/videos/{id}` | Détail de la vidéo et de ses sources |

```bash
curl -i http://127.0.0.1:8080/api/v1/videos \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.youtube.com/watch?v=IgKU8xCgbjc"}'

curl http://127.0.0.1:8080/api/v1/videos
curl http://127.0.0.1:8080/api/v1/videos/42
```

`POST` accepte un objet `{"url":"…"}` de **16 Kio maximum**. Une création renvoie un en-tête `Location: /api/v1/videos/{id}`. Une vidéo connue reste inchangée : le réajout ne rafraîchit pas ses métadonnées ou associations. L'identité d'une source YouTube est déterminée par `(provider, external_id)`, pas par la forme de son URL.

Exemple de représentation (valeurs illustratives) :

```json
{
  "id": 42,
  "created_at": "2026-10-15T18:30:12.123Z",
  "sources": [{
    "id": 17,
    "provider": "youtube",
    "external_id": "IgKU8xCgbjc",
    "canonical_url": "https://www.youtube.com/watch?v=IgKU8xCgbjc",
    "title": "Exemple de vidéo",
    "description": null,
    "publisher": {"id": 7, "name": "Exemple de chaîne"},
    "duration_ms": 1025000,
    "thumbnail_url": null
  }],
  "tags": [],
  "person_ids": []
}
```

La liste est ordonnée par `created_at DESC, id DESC`, les sources et tags suivant des ordres stables par ID. `publisher` peut être `null` ; il remplace l'ancien champ `creator`. `person_ids` représente uniquement les associations **directes** à la vidéo. Une liste vide renvoie `{"videos":[]}`.

### Notes et tags

| Méthode | Route | Comportement |
| --- | --- | --- |
| `GET` | `/api/v1/videos/{id}/note` | Note principale ou `404 note_not_found` |
| `PUT` | `/api/v1/videos/{id}/note` | Sauvegarde conditionnelle ; `201` à la création, `200` ensuite, `409 note_conflict` en cas de révision obsolète |
| `GET` | `/api/v1/tags` | Catalogue complet par ID croissant ; compteurs directs `video_count`, `publisher_count`, `person_count` |
| `PATCH` | `/api/v1/tags/{id}` | `{"name":"…"}` ; retourne `{id, name}`, `404 tag_not_found` si absent, `409 tag_conflict` en cas de collision |
| `DELETE` | `/api/v1/tags/{id}` | `204` idempotent ; supprime le tag et ses trois types d'associations, conserve les entités |
| `POST` | `/api/v1/videos/{id}/tags` | Ajout additif par noms ; retourne les tags associés |
| `DELETE` | `/api/v1/videos/{id}/tags/{tag_id}` | Retire l'association, sans supprimer le tag du catalogue |

```bash
curl -X PUT http://127.0.0.1:8080/api/v1/videos/42/note \
  -H 'Content-Type: application/json' \
  --data '{"content_md":"# À retenir\n\nUne idée.","expected_revision":0}'

curl -X POST http://127.0.0.1:8080/api/v1/videos/42/tags \
  -H 'Content-Type: application/json' \
  --data '{"names":["Go","SQLite"]}'

curl 'http://127.0.0.1:8080/api/v1/videos?tag_id=7'
```

Chaque `PUT` de note exige **`content_md` et `expected_revision`**. La valeur `0` attend une note absente ; pour les écritures suivantes, reprendre la révision renvoyée par le précédent GET/PUT. Les réponses contiennent `video_id`, `content_md`, `revision`, `created_at` et `updated_at`. Une note absente n'est pas une note vide ; la chaîne vide peut être enregistrée explicitement.

La sauvegarde convertit uniquement CRLF et CR en LF. Une écriture identique sous précondition valide conserve la révision et les dates. Taille maximale du JSON de note : **1 Mio** ; ajout de tags : **64 Kio**. Les noms des tags, limités à 200 points de code après retrait des espaces aux extrémités, ont une identité Unicode NFC sans casse mais conservent leurs accents significatifs et leur nom d'affichage. Les associations n'héritent pas des autres entités.

Le catalogue retourne `{"tags":[{"id":7,"name":"Go","video_count":18,"publisher_count":2,"person_count":1}]}`.
Ces compteurs directs sont informatifs. Un renommage (JSON limité à **16 Kio**) conserve l'ID et
les associations ; une correction de graphie à clé identique est acceptée, une collision avec un
autre tag est refusée sans fusion. La dernière écriture réussie prévaut ; les anciens noms libérés
restent réutilisables. La suppression globale retire tous les liens présents dans sa transaction.
Les tags embarqués dans les vidéos, publishers et personnes gardent leur forme `{id, name}`.

### Transcriptions

| Méthode | Route | Comportement |
| --- | --- | --- |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/transcript` | Acquisition/actualisation explicite ; **corps vide**, `200` après persistance |
| `GET` | `/api/v1/videos/{video_id}/sources/{source_id}/transcript` | Relecture **strictement locale** du snapshot ; aucune acquisition distante |

```bash
curl -X POST http://127.0.0.1:8080/api/v1/videos/42/sources/17/transcript
curl http://127.0.0.1:8080/api/v1/videos/42/sources/17/transcript
```

Exemple de réponse (GET et POST) :

```json
{
  "language": "en",
  "provenance": "youtube_auto",
  "last_fetched_at": "2026-10-15T19:00:00.000Z",
  "items": [
    {"start_ms": 2960, "text": "This"},
    {"start_ms": 3080, "text": " is"}
  ]
}
```

Seules les captions automatiques originales **sélectionnables selon la politique actuelle** sont acquises. L'indication `-orig` ne garantit pas qu'une piste corresponde à la langue originale de l'audio. Les fragments sont conservés dans l'ordre de la source et ne sont pas persistés individuellement en SQLite. En cas d'absence, d'ambiguïté, de délai distant ou de snapshot local illisible, l'API renvoie des erreurs distinctes, sans réessai automatique implicite.

### Publishers et personnes

| Méthode | Route | Comportement |
| --- | --- | --- |
| `POST` / `GET` | `/api/v1/publishers` | Résolution d'une chaîne YouTube par URL / catalogue |
| `GET` | `/api/v1/publishers/{id}` | Compte et tags associés |
| `PUT` | `/api/v1/publishers/{id}/person` | `{"person_id":3}` ou `null` pour retirer le lien |
| `GET` | `/api/v1/publishers/{id}/videos` | Vidéos de ce publisher |
| `POST` / `GET` | `/api/v1/persons` | Création d'une personne / catalogue |
| `GET` / `PATCH` | `/api/v1/persons/{id}` | Détail / renommage |
| `GET` | `/api/v1/persons/{id}/publishers` | Publishers dont elle est la référence |
| `GET` | `/api/v1/persons/{id}/videos` | Filtre `relation` : `direct`, `publisher` ou `all` (par défaut) |
| `PUT` | `/api/v1/videos/{video_id}/sources/{source_id}/publisher` | `{"publisher_id":7}` ou `null` |
| `PUT` / `DELETE` | `/api/v1/videos/{video_id}/persons/{person_id}` | Ajout/retrait d'une association directe, sans corps |
| `POST` | `/api/v1/publishers/{id}/tags` | Ajout additif par noms |
| `DELETE` | `/api/v1/publishers/{id}/tags/{tag_id}` | Retrait d'association |
| `POST` | `/api/v1/persons/{id}/tags` | Ajout additif par noms |
| `DELETE` | `/api/v1/persons/{id}/tags/{tag_id}` | Retrait d'association |

```bash
curl -X POST http://127.0.0.1:8080/api/v1/publishers \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.youtube.com/@LexClips"}'

curl -X POST http://127.0.0.1:8080/api/v1/persons \
  -H 'Content-Type: application/json' \
  --data '{"name":"Lex Fridman"}'

curl 'http://127.0.0.1:8080/api/v1/persons/3/videos?relation=all'
```

Les publishers sont identifiés par leur **`channel_id` YouTube fiable**, pas par le nom de la chaîne ni son handle. Deux personnes homonymes restent deux entités distinctes. Les tags des personnes, publishers et vidéos partagent le catalogue, sans propagation des associations. Les rattachements explicites ne sont pas modifiés lors d'un réimport vidéo.

### Téléchargements et fichiers locaux

| Méthode | Route | Comportement |
| --- | --- | --- |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/download` | Démarre ou retrouve un téléchargement ; corps vide ; `202` si actif, `200` si disponible |
| `GET` | `/api/v1/videos/{video_id}/sources/{source_id}/download` | État local : `not_downloaded`, `downloading`, `available`, `failed` |
| `DELETE` | `/api/v1/videos/{video_id}/media-files/{media_file_id}` | Supprime volontairement l'identité exacte du fichier (`204`) |
| `GET` / `HEAD` | `/api/v1/videos/{video_id}/media-files/{media_file_id}/content` | Diffusion du fichier et prise en charge de `Range` (`200`, `206`, `416`) |

```bash
curl -X POST http://127.0.0.1:8080/api/v1/videos/42/sources/17/download
curl http://127.0.0.1:8080/api/v1/videos/42/sources/17/download
```

Un état `available` contient `media_file` : `id`, `format`, `size`, `duration_ms`, `added_at`, codecs, dimensions, `fps` et `audio_language` (certaines propriétés pouvant être `null`). Un échec de travail est consultable avec **HTTP 200 et `status: "failed"`** ; une erreur de consultation est au contraire un **échec HTTP**. Un fichier référencé mais devenu indisponible donne notamment `409 local_media_unavailable`, avec son identité lorsqu'elle est connue, pour permettre une suppression ciblée.

Un téléchargement ne crée ni autre `Video` ni autre `VideoSource`. Il conserve un média complet volontairement, sans réencodage systématique, et sa publication est distincte de son décodage par le navigateur. La suppression d'un média préserve les notes, transcriptions et captures. Une seule acquisition média est active à la fois par instance de serveur ; les autres sources peuvent obtenir `503 download_busy`.

Le contenu est servi à partir de l'identité du fichier, sans exposer son chemin. `Cache-Control: no-store` et `X-Content-Type-Options: nosniff` protègent la diffusion ; une lecture HTTP ou une capture peut temporairement empêcher une suppression.

### Captures et assets

| Méthode | Route | Comportement |
| --- | --- | --- |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/captures` | Demande de capture à un timestamp avec `request_id` unique ; `202` si en cours, `200` si commande déjà terminée |
| `GET` | `/api/v1/videos/{video_id}/assets?page=1` | Catalogue des captures, toutes sources et tous états, par pages de 12 |
| `GET` | `/api/v1/assets/requests/{request_id}` | Retrouve l'Asset après une réponse de POST incertaine |
| `GET` | `/api/v1/assets/{asset_id}` | Consulte l'état et la provenance |
| `GET` | `/api/v1/assets/{asset_id}/content` | Lit le PNG publié, sans générer de nouvelle capture |

Exemple de demande (remplacer les IDs par ceux d'une vidéo et de sa source) :

```bash
curl -X POST http://127.0.0.1:8080/api/v1/videos/42/sources/17/captures \
  -H 'Content-Type: application/json' \
  --data '{"timestamp_ms":762345,"request_id":"d3e96f35-1e7d-4fc9-8118-dac4503721b9"}'
```

La requête JSON est limitée à **4 Kio**. Une capture acceptée renvoie son ID dans `Location: /api/v1/assets/{id}` et une représentation contenant notamment `id`, `video_id`, `source_id`, `timestamp_ms`, `type`, `status`, `error_code` et `created_at`.

L'Asset est enregistré comme `pending` avant l'extraction et devient `available` ou `failed`. La clé `request_id` sert à retrouver **la même commande** après une réponse perdue : en cas de doute, consulter l'endpoint de récupération puis, si nécessaire, répéter le POST avec **la même clé**, pas avec une nouvelle. Une clé réutilisée avec d'autres paramètres reçoit `409`. Une seule capture s'exécute à la fois par instance, indépendamment du téléchargement.

La capture privilégie le fichier complet de **la même source** s'il est exploitable, puis le flux distant selon une politique de repli bornée. Le fichier PNG et l'Asset restent indépendants de leur éventuelle référence dans une note. Le catalogue par vidéo est indépendant du Markdown et ne teste pas les fichiers. Sa réponse contient `assets`, `page` et `has_more`, triés par `timestamp_ms ASC, id ASC`. `page` vaut 1 par défaut, accepte un entier de 1 à 1 000 000 et refuse les répétitions (`400 bad_request`). Une vidéo absente donne `404 video_not_found` ; une page vide retourne `assets: []`. La pagination ne garantit pas un instantané entre requêtes. Aucune suppression d'assets n'est exposée.

### Erreurs et limites communes

Les erreurs JSON sont de la forme :

```json
{"error":{"code":"video_not_found","message":"video not found"}}
```

| Statut | Exemples de codes | Signification |
| --- | --- | --- |
| `400` | `bad_request` | Identifiant, filtre, corps ou valeur invalide |
| `404` | `video_not_found`, `video_source_not_found`, `note_not_found`, `transcript_not_found`, `asset_not_found` | Ressource absente selon la route |
| `409` | `note_conflict`, `transcript_selection_ambiguous`, `local_media_unavailable` | Conflit, ambiguïté ou état incompatible |
| `413` | `payload_too_large` | Corps trop volumineux |
| `415` | `unsupported_media_type` | Type MIME non accepté pour un corps JSON |
| `502` | `metadata_fetch_failed`, `transcript_fetch_failed` | Acquisition distante impossible |
| `503` | `download_busy`, `capture_busy` | Opération concurrente ou ressource occupée |
| `504` | `metadata_fetch_timeout`, `transcript_fetch_timeout` | Délai d'acquisition synchrone dépassé |
| `500` | `internal_error` | Erreur locale ou interne |

Ces exemples ne constituent pas une liste exhaustive : chaque ressource possède ses erreurs propres. Les messages lisibles peuvent évoluer ; les clients doivent privilégier le **code**. Les routes de lecture ou suppression ne relancent pas implicitement un téléchargement, une acquisition de transcription ou une capture.

## Tests et validation

Depuis la racine du dépôt :

```bash
make test      # go test ./..., go vet, go build et vérification TypeScript
make test-web  # build complet puis Playwright
```

Pour une première utilisation de Playwright, installer Chromium et, si nécessaire, ses dépendances système :

```bash
cd web
npx playwright install --with-deps chromium
cd ..
```

La collection Postman déterministe peut être lancée avec :

```bash
python3 tests/postman/run.py deterministic
```

Elle nécessite Python 3 et Postman CLI ; les détails d'installation, les collections v3 et les conditions d'essai réel YouTube figurent dans [tests/postman/README.md](tests/postman/README.md). Les tests automatisés utilisent des outils ou lecteurs contrôlés lorsque nécessaire : **ils ne prouvent pas à eux seuls les comportements de l'iframe YouTube réelle**.

Pour valider le packaging Docker (nécessite Docker, Python 3 et les prérequis du script) :

```bash
docker build --platform linux/amd64 -f deployments/docker/Dockerfile -t sillage:local .
python3 tests/docker/smoke.py
```

Pour les interactions réelles des lecteurs et du workspace, utiliser la [recette manuelle](docs/07-local-playback-validation.md). Les essais YouTube réels restent volontaires et séparés de la CI déterministe.

## Architecture et documentation

```text
Navigateur React / TypeScript
          │ REST
          ▼
Serveur Go (net/http + Chi)
          │
     Services métier
          │
   ports / adapters
     ├── SQLite
     ├── filesystem
     ├── yt-dlp
     └── ffmpeg / ffprobe

Adapter MCP conservé, transport suspendu → mêmes services métier
Futur : IA intégrée et autres sources → mêmes services métier
```

Les services applicatifs et le domaine restent indépendants des handlers HTTP, de SQLite et des outils externes. SQLite utilise `modernc.org/sqlite`, des migrations SQL embarquées et `PRAGMA user_version`. Les données temporelles dans un média sont des entiers en **millisecondes** ; les dates de calendrier sont des timestamps UTC.

La documentation de référence est organisée ainsi :

| Document | Objet |
| --- | --- |
| [00-project-brief.md](docs/00-project-brief.md) | Vision, objectifs et périmètre |
| [01-product-and-ux.md](docs/01-product-and-ux.md) | Parcours et règles UX actuelles |
| [02-domain-model.md](docs/02-domain-model.md) | Entités métier, identités et invariants |
| [03-architecture.md](docs/03-architecture.md) | Services, adapters, API et garanties techniques |
| [configuration.md](docs/configuration.md) | Provisionnement déclaratif, secrets, adoption et récupération |
| [security.md](docs/security.md) | Propriétaire, sessions Web, administration et continuité des notes |
| [mcp.md](docs/mcp.md) | Contrats de l’adapter MCP temporairement suspendu |
| [04-tech-stack-and-decisions.md](docs/04-tech-stack-and-decisions.md) | Stack et choix techniques en vigueur |
| [05-roadmap.md](docs/05-roadmap.md) | État d'avancement et jalons futurs |
| [06-open-questions.md](docs/06-open-questions.md) | Questions et décisions non résolues |
| [07-local-playback-validation.md](docs/07-local-playback-validation.md) | Recette manuelle de non-régression des lecteurs et du workspace |
| [Historique d'arbitrages](docs/history/sillage-decisions-octobre-2026.md) | Raisons de quelques choix techniques et UX passés |

Les instructions de travail propres au dépôt sont dans [AGENTS.md](AGENTS.md). Le code et les migrations restent les références finales des détails d'implémentation ; les documents de conception décrivent les contrats et intentions à maintenir.

## Prochaines étapes

La recherche globale SQLite FTS5 et l’authentification Web locale/OIDC sont disponibles. L’administration Web (A3.3), les clés API/MCP et le déploiement homelab restent des tranches distinctes ; MCP reste suspendu dans le serveur distribué. L’IA intégrée et les éventuelles écritures MCP restent à cadrer. La recherche de passages de transcription et la navigation temporelle depuis les résultats restent des extensions distinctes.

La [roadmap](docs/05-roadmap.md) donne l'état des jalons et leurs objectifs ; [les questions ouvertes](docs/06-open-questions.md) recensent les choix qui ne sont pas encore tranchés. Leur présence dans ces fichiers ne signifie pas qu'ils sont implémentés ou approuvés.
