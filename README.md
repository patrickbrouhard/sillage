# Sillage

**Sillage** est une base de connaissances personnelle centrée sur la vidéo.
L’objectif est de transformer le visionnage d’une vidéo en connaissance durable, structurée et réutilisable : notes, timestamps, annotations, transcriptions, tags, captures, recherche et enrichissements IA.

> Le projet est actuellement en phase initiale de conception et de développement.

La première tranche persistante est fonctionnelle : Sillage peut extraire les
métadonnées d’une vidéo YouTube avec `yt-dlp`, les normaliser, puis créer ou
retrouver la vidéo dans une base SQLite.

## Vision

Une vidéo est un flux temporel continu. Pendant son visionnage, certaines idées, explications, images ou passages méritent d’être conservés.
Sillage permet de capturer ces éléments et de les rattacher directement à la vidéo et au moment où ils apparaissent.

Exemple de workflow :

```text
vidéo
  ↓
visionnage
  ↓
notes + timestamps + annotations + captures
  ↓
transcription + tags
  ↓
recherche et structuration
  ↓
connaissance exploitable
```

YouTube est la première source prévue, mais le modèle n’est pas limité à une plateforme particulière.

Une `Video` représente un objet de connaissance interne à Sillage ; YouTube, un fichier local ou une autre plateforme ne sont que des sources ou représentations de cette vidéo.

## Fonctionnalités envisagées

### Bibliothèque vidéo

* ajout d’une vidéo depuis une URL ;
* récupération automatique des métadonnées ;
* navigation par miniatures ;
* tags et filtres ;
* recherche.

### Espace de travail vidéo

* lecteur vidéo ;
* notes Markdown ;
* insertion rapide du timestamp courant ;
* navigation depuis une référence temporelle vers la vidéo ;
* annotations temporelles structurées ;
* consultation de la transcription ;
* captures d’écran liées à un timestamp.

Exemple de prise de notes :

```markdown
[12:42] Comparer cette approche avec le fonctionnement de SQLite.
```

### Transcriptions

Pour YouTube, Sillage utilisera dans un premier temps `yt-dlp` afin de récupérer les sous-titres disponibles.
Le format `json3` est ensuite normalisé vers le modèle interne :

```text
Transcript
└── TranscriptSegment
    ├── start_ms
    ├── end_ms
    └── text
```

### Recherche

La recherche doit à terme pouvoir couvrir :

* titres ;
* descriptions ;
* tags ;
* notes ;
* transcriptions ;
* résumés et autres artefacts textuels.

SQLite FTS5 est envisagé pour la recherche plein texte.

### IA et MCP

Sillage est conçu pour être **IA-native**, tout en restant pleinement utilisable sans IA.
Des agents pourront à terme interroger et modifier la base via MCP avec des outils métier tels que :

```text
search_videos
get_video
get_transcript
get_annotations
add_tags
append_note
```

Exemple d’usage :

> Recherche mes vidéos sur Proxmox et Tailscale et indique lesquelles parlent du subnet routing.

## Architecture

Le cœur applicatif est indépendant des interfaces externes et des dépendances techniques.

```text
Web UI / REST / MCP / futur desktop
                ↓
        Application Services
                ↓
          ports / adapters
                ↓
 SQLite / yt-dlp / ffmpeg / filesystem / IA
```

REST et MCP utilisent les mêmes services applicatifs.
Les composants métier ne doivent pas dépendre directement de Chi, SQLite, `yt-dlp`, `ffmpeg` ou d’un fournisseur IA.

## Stack technique

Choix actuels ou privilégiés :

* **Go**
* `net/http`
* **Chi**
* **SQLite** via `database/sql` et `modernc.org/sqlite`
* SQLite **FTS5** à terme
* **yt-dlp**
* **ffmpeg**
* **Docker**
* API REST
* MCP en Go à terme

Le frontend n’est pas encore choisi (React ?)
Une éventuelle version desktop pourra être étudiée plus tard (Wails ?).

## État actuel

Le flux suivant est implémenté :

```text
URL YouTube
    ↓
AddVideo
    ↓
adapter yt-dlp
    ↓
Video + VideoSource
    ↓
SQLite
    ↓
relecture persistante
```

Une `Video` et ses `VideoSource` possèdent des identifiants internes Sillage.
L’identité externe d’une source YouTube repose sur le couple
`(provider, external_id)` : ajouter plusieurs formes d’URL correspondant à la
même vidéo retourne donc la même `Video`, sans rafraîchir implicitement ses
métadonnées.

La base est initialisée par des migrations SQL embarquées et versionnées avec
`PRAGMA user_version`. Les clés étrangères sont activées et la création d’une
vidéo avec ses sources est transactionnelle.

L’API HTTP, l’interface Web, les transcriptions, les notes et les tags ne sont
pas encore implémentés.

## Exécution

Prérequis :

* Go 1.27.1 ;
* `yt-dlp` accessible dans le `PATH`.

Le programme dans `cmd/server` est une interface temporaire permettant de
tester le flux persistant :

```bash
go run ./cmd/server "https://www.youtube.com/watch?v=IgKU8xCgbjc" ./sillage.db
```

Il affiche la `Video` normalisée en JSON. Relancer la commande avec une autre
URL de la même vidéo réutilise l’enregistrement existant dans `sillage.db`.

Pour valider le projet :

```bash
go test ./...
go vet ./...
go build ./...
```

## Structure du projet

```text
.
├── cmd/
│   └── server/
├── internal/
│   ├── video/
│   ├── transcript/
│   ├── adapter/
│   │   ├── sqlite/
│   │   │   └── migrations/
│   │   └── ytdlp/
│   └── http/
├── docs/
└── deployments/
    └── docker/
```

## Documentation

La documentation de conception se trouve dans [`docs/`](docs/).

* [`00-project-brief.md`](docs/00-project-brief.md) — vision et périmètre
* [`01-product-and-ux.md`](docs/01-product-and-ux.md) — workflows et UX
* [`02-domain-model.md`](docs/02-domain-model.md) — modèle métier
* [`03-architecture.md`](docs/03-architecture.md) — architecture
* [`04-tech-stack-and-decisions.md`](docs/04-tech-stack-and-decisions.md) — choix techniques
* [`05-roadmap-and-open-questions.md`](docs/05-roadmap-and-open-questions.md) — roadmap et questions ouvertes

## Roadmap initiale

Le développement doit avancer par incréments verticaux simples :

```text
yt-dlp
  ↓
modèle Go
  ↓
SQLite
  ↓
API REST
  ↓
transcriptions
  ↓
notes + tags
  ↓
UI minimale
  ↓
timestamps
  ↓
téléchargement + screenshots
  ↓
recherche
  ↓
MCP
  ↓
IA intégrée
```

La tranche actuelle permet déjà :

1. de recevoir une URL vidéo ;
2. d’interroger `yt-dlp` ;
3. de normaliser les métadonnées ;
4. de persister la vidéo ;
5. de retrouver une vidéo existante à partir de l’identité de sa source.

La prochaine interface programmable prévue est l’API REST.

## Principes de développement

Le projet privilégie :

* la simplicité ;
* le code Go idiomatique ;
* les abstractions justifiées par un besoin réel ;
* une architecture modulaire sans surarchitecture ;
* une approche local-first.
