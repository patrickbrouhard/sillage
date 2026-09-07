# Sillage

**Sillage** est une base de connaissances personnelle centrée sur la vidéo.
L’objectif est de transformer le visionnage d’une vidéo en connaissance durable, structurée et réutilisable : notes, timestamps, annotations, transcriptions, tags, captures, recherche et enrichissements IA.

> Le projet est actuellement en phase initiale de conception et de développement.

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
* **SQLite**
* SQLite **FTS5** à terme
* **yt-dlp**
* **ffmpeg**
* **Docker**
* API REST
* MCP en Go à terme

Le frontend n’est pas encore choisi (React ?)
Une éventuelle version desktop pourra être étudiée plus tard (Wails ?).

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
│   │   └── ytdlp/
│   └── http/
├── migrations/
├── docs/
├── testdata/
└── deployments/
    └── docker/
```

## Documentation

La documentation de conception se trouve dans [`docs/`](docs/).

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

Le premier objectif est de disposer d’un backend capable :

1. de recevoir une URL vidéo ;
2. d’interroger `yt-dlp` ;
3. de normaliser les métadonnées ;
4. de persister la vidéo ;
5. de la restituer via l’API.

## État du projet

Sillage n'est pas fonctionnel

Le projet privilégie :

* la simplicité ;
* le code Go idiomatique ;
* les abstractions justifiées par un besoin réel ;
* une architecture modulaire sans surarchitecture ;
* une approche local-first.
