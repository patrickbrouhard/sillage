# Architecture

## 1. Objectif

L'architecture doit permettre :

- un développement initial très simple ;
- une API HTTP ;
- une interface Web ;
- un serveur MCP ;
- l'utilisation de `yt-dlp` et `ffmpeg` ;
- SQLite ;
- une future version desktop ;
- éventuellement d'autres sources vidéo et fournisseurs IA.

Le principe principal est de conserver un **cœur applicatif indépendant des interfaces et des dépendances externes**.

## 2. Vue générale

```text
                  ┌───────────────────┐
                  │      Web UI       │
                  └─────────┬─────────┘
                            │ HTTP
                            ▼
                  ┌───────────────────┐
                  │    HTTP / Chi     │
                  └─────────┬─────────┘
                            │
                            ▼
              ┌────────────────────────────┐
              │    Application Services    │
              │────────────────────────────│
              │ AddVideo                   │
              │ GetVideo                   │
              │ SearchVideos               │
              │ UpdateNotes                │
              │ AddAnnotation              │
              │ FetchTranscript            │
              │ DownloadMedia              │
              │ CaptureFrame               │
              └──────┬───────────┬─────────┘
                     │           │
            ports    │           │    ports
                     ▼           ▼
              ┌──────────┐   ┌──────────────┐
              │Repository│   │Video Provider│
              └────┬─────┘   └──────┬───────┘
                   │                │
                   ▼                ▼
               SQLite            yt-dlp
                                    │
                                    ▼
                                  ffmpeg


                    ┌───────────────────┐
                    │    MCP Server     │
                    └─────────┬─────────┘
                              │
                              └────────────► Application Services
```

## 3. Le cœur n'est pas l'API

L'API HTTP est une interface vers le cœur applicatif.

Elle ne contient pas le métier.

Un handler HTTP doit idéalement :

1. lire et valider la requête ;
2. convertir les données vers les types applicatifs ;
3. appeler un service ;
4. convertir le résultat en réponse HTTP.

Il ne doit pas :

- lancer directement `yt-dlp` ;
- écrire du SQL métier ;
- manipuler directement le système de fichiers ;
- contenir les règles de domaine.

## 4. Application services

Les services applicatifs orchestrent les cas d'usage.

Exemples :

```text
AddVideo()
GetVideo()
ListVideos()
SearchVideos()
UpdateNote()
AddTag()
AddAnnotation()
FetchTranscript()
DownloadMedia()
CaptureFrame()
```

Ils représentent les opérations que peuvent consommer :

- REST ;
- MCP ;
- un CLI ;
- une future application desktop.

Ils doivent utiliser des ports/interfaces pour leurs dépendances.

### 4.1 `AddVideo`

Le premier cas d'usage persistant est `AddVideo`.

Flux validé :

```text
AddVideo(url)
    ↓
extracteur de métadonnées
    ↓
VideoSource normalisée
    ↓
FindBySource(provider, external_id)
    ├── existe
    │     ↓
    │  retourner la Video existante
    │
    └── absente
          ↓
       créer Video
          +
       créer VideoSource
          ↓
       transaction SQLite
```

Pour une source telle que YouTube, plusieurs formes d'URL correspondant au même couple :

```text
(provider, external_id)
```

doivent aboutir à la même `Video`.

`AddVideo` est ainsi idempotent au niveau métier pour une même identité externe de source.

La contrainte d'unicité de la base reste la garantie ultime contre une création concurrente en double.

### 4.2 Pas de rafraîchissement implicite

Lorsqu'une source existe déjà, `AddVideo` retourne la `Video` existante.

Il ne rafraîchit pas implicitement :

- titre ;
- description ;
- créateur ;
- miniature ;
- autres métadonnées de source.

La politique de rafraîchissement reste distincte et pourra devenir un cas d'usage explicite plus tard.

## 5. Ports et adapters

Une approche ports/adapters légère est privilégiée.

Il n'est pas nécessaire de reproduire une Clean Architecture cérémonieuse.

L'objectif est simplement de rendre explicites les frontières.

### 5.1 `VideoRepository`

Le port initial est volontairement petit et spécialisé :

```go
type VideoRepository interface {
    Create(ctx context.Context, video Video) (Video, error)
    Get(ctx context.Context, id VideoID) (Video, error)
    List(ctx context.Context) ([]Video, error)
    FindBySource(
        ctx context.Context,
        provider string,
        externalID string,
    ) (Video, error)
}
```

SQLite implémente cette interface.

À ce stade, ne pas ajouter sans besoin concret :

- repository générique ;
- `Update` ;
- `Delete`.

`List` est utilisé par le service `ListVideos` pour l'API de bibliothèque.

Le repository expose une erreur applicative stable telle que :

```go
ErrVideoNotFound
```

plutôt que d'obliger le service applicatif à interpréter directement une erreur SQLite.

Il n'est pas nécessaire d'introduire une hiérarchie complexe d'erreurs.

### 5.2 Création atomique

La création d'une `Video` et de sa première `VideoSource` doit être atomique.

L'adapter SQLite utilise donc une transaction pour :

```text
INSERT Video
+
INSERT VideoSource
```

Si la source ne peut pas être persistée, la `Video` ne doit pas rester seule en base à la suite de ce cas d'usage.

### 5.3 Provider de métadonnées

Exemple :

```go
type MetadataProvider interface {
    Extract(ctx context.Context, url string) (*SourceMetadata, error)
}
```

L'adapter `yt-dlp` implémente ce port pour les sources prises en charge.

### 5.4 Transcriptions

`transcript.Service.Fetch` et `Get` portent l'acquisition et la lecture locale.
Ils vérifient d'abord la vidéo et l'appartenance de sa source via un petit
port `VideoReader`, satisfait par le repository vidéo existant.

Le port `Provider` expose une acquisition normalisée :
langue du contenu, `TranscriptContent`, octets source opaques à conserver.
L'adapter yt-dlp découvre les formats audio/captions, sélectionne l'original,
récupère son JSON3 et le parse. Les options CLI et structures JSON3 restent
dans cet adapter. Une langue connue contraint la sélection.

Le port `Snapshots` publie un nouveau fichier complet et relit son contenu
sans réseau. L'adapter filesystem reçoit le parser JSON3 lors de l'assemblage
dans `cmd/server` ; le service ne choisit ni extension ni parser technique.

Le repository de transcription conserve l'identité stable par
`(video_source_id, language, provenance)`. Sa transaction actualise le chemin
et la date et peut renseigner une langue audio encore inconnue. Elle ne reste
jamais ouverte pendant l'accès distant ou l'écriture du fichier.

### 5.5 Publication locale

Les snapshots sont conservés dans `data/transcripts/`, avec des chemins
relatifs en base. Publication : fichier temporaire, écriture complète,
synchronisation, fermeture, renommage, puis transaction SQLite.
Chaque acquisition dispose d'un chemin distinct, y compris en concurrence.

Le fichier précédent n'est pas écrasé et reste disponible aux GET en cours.
Un échec SQL ou un crash peut laisser un fichier non référencé ; aucune
politique complète de nettoyage n'est implémentée. Ce compromis de développement
ne constitue ni un historique métier ni une politique durable de rétention.

Le GET charge uniquement le snapshot référencé et le parse. Absence, erreur
de lecture ou corruption donnent une erreur locale. Il ne dépend d'aucun
provider distant. Les transcriptions ne sont pas imbriquées dans le type
`video.VideoSource`, ce qui évite une dépendance cyclique entre packages.

### 5.6 Notes et tags — étape 4 à implémenter

Le cadrage est terminé. Lecture et enregistrement de la note, catalogue de tags,
ajout et retrait d'associations et filtrage des vidéos passent par des services
applicatifs indépendants de HTTP et SQLite, avec des ports spécialisés et des
handlers minces. REST et le futur MCP réutiliseront les mêmes cas d'usage.
Le découpage exact des services et repositories reste un choix d'implémentation.

Ces opérations sont locales et ne dépendent d'aucune acquisition ou actualisation
distante. Les notes et tags restent séparés des métadonnées et transcriptions
source ; un rafraîchissement ne doit pas les écraser.

L'adapter SQLite garantit l'unicité concurrente des tags et associations ainsi
que l'atomicité de tout ajout multiple, créations de tags comprises. Un simple
contrôle d'existence avant insertion ne suffit pas à garantir ces invariants.
Les évolutions de schéma utiliseront les migrations embarquées et versionnées.

Les lectures filtrées devront conserver toutes les sources et tous les tags
des vidéos sélectionnées. Le réajout d'une vidéo existante devra également
restituer ses tags actuels. La stratégie de chargement reste libre.

## 6. Adapter `yt-dlp`

`yt-dlp` est utilisé comme **binaire externe**, appelé depuis Go.

Ce choix est cohérent avec l'expérience existante sur un ancien programme CLI.

Flux :

```text
Go
 ↓
exec yt-dlp
 ↓
sortie structurée
 ↓
parsing
 ↓
modèle interne
```

Avantages :

- pas d'intégration du code Python de `yt-dlp` dans le processus Go ;
- séparation claire ;
- remplacement ou adaptation future possible ;
- comportement facilement testable via un adapter.

Le code métier ne doit pas connaître les options CLI précises de `yt-dlp`.

L'adapter actuel ne supporte que YouTube. Cette limitation est acceptable : ne pas introduire maintenant une abstraction destinée uniquement à anticiper le fait que `yt-dlp` supporte aussi d'autres plateformes.

## 7. Adapter `ffmpeg`

`ffmpeg` est prévu pour les opérations média nécessitant un traitement local.

Cas principal :

```text
timestamp courant
      ↓
MediaFile local
      ↓
ffmpeg
      ↓
screenshot
      ↓
Asset
```

Il peut également être utilisé par `yt-dlp` lors du post-traitement.

L'appel `ffmpeg` doit rester dans un adapter/service technique et ne pas contaminer le domaine.

## 8. API HTTP

### 8.1 Stack

L'API utilise :

```text
net/http
+
Chi
```

Chi est choisi comme routeur HTTP léger plutôt qu'un framework Web lourd.

Les décisions de la tranche HTTP sont implémentées et décrites dans le README
(section « Contrat API v1 »), qui contient les exemples et la liste des erreurs.

- Trois routes : POST /api/v1/videos, GET /api/v1/videos, GET /api/v1/videos/{id}.
- POST synchrone ; résultat applicatif AddVideoResult{Video, Created}.
- Création : 201 avec Location ; vidéo existante : 200 sans refresh.
- DTO HTTP distincts ; sources imbriquées sans video_id ; champs absents à null.
- Liste complète sous {"videos": [...]} ; created_at DESC, id DESC.
- Sources par ID croissant ; dates UTC / RFC 3339.
- Corps JSON strict, 16 Kio ; application/json avec paramètres accepté.
- Timeout applicatif configurable de 60 s propagé par contexte.
- Erreurs : 400, 404, 413, 415, 502, 504, 500 ; aucune analyse fragile de stderr.
- Écoute locale 127.0.0.1:8080 configurable ; pas d'auth ni CORS.
- Chemin de base fixe data/sillage.db (relatif au répertoire de travail) ; création du dossier, sans déplacement de l'ancienne base.

### API des transcriptions

```text
POST /api/v1/videos/{video_id}/sources/{source_id}/transcript
GET  /api/v1/videos/{video_id}/sources/{source_id}/transcript
```

Le POST sans corps acquiert ou rafraîchit la caption automatique originale.
Aucun `Content-Type` n'est requis ; un corps non vide est rejeté par `400 bad_request`.
Il retourne toujours `200 OK`, sans `Location`, après publication et persistance.
Le délai global `SILLAGE_POST_TIMEOUT` couvre toute l'acquisition.

Le GET ne fait aucun accès distant. Il sélectionne la dernière acquisition
`youtube_auto` par `last_fetched_at DESC, id DESC`, puis parse le snapshot local.
Une ligne dont le snapshot est absent, illisible ou corrompu donne `500 internal_error`.
Le service vérifie la vidéo et l'appartenance de la source avant tout accès au contenu.

GET et POST exposent exactement les mêmes champs :

```json
{
  "language": "en",
  "provenance": "youtube_auto",
  "last_fetched_at": "2026-10-07T14:21:35.042Z",
  "items": [
    {"start_ms": 2960, "text": "This"},
    {"start_ms": 3080, "text": " is"}
  ]
}
```

L'ID du transcript, `video_source_id` et `local_path` restent internes.
Il n'existe pas de ressource autonome `/api/v1/transcripts`.

| Statut | Code | Situation |
| --- | --- | --- |
| 400 | `bad_request` | Identifiant invalide ou corps non vide |
| 404 | `video_not_found` | Vidéo inexistante |
| 404 | `video_source_not_found` | Source absente ou appartenant à une autre vidéo |
| 404 | `transcript_not_found` | Aucune acquisition pour la politique actuelle |
| 404 | `transcript_not_available` | Aucune piste originale JSON3 sélectionnable de façon fiable |
| 502 | `transcript_fetch_failed` | Échec distant ou contenu distant inexploitable |
| 504 | `transcript_fetch_timeout` | Délai applicatif dépassé |
| 500 | `internal_error` | Erreur locale : exécutable indisponible, SQLite, filesystem, snapshot |

Les échecs de processus ne sont pas interprétés en analysant le texte de stderr.
Une déconnexion annule l'opération sans réponse particulière. Un commit déjà
réussi peut néanmoins précéder une déconnexion ; le client peut alors relire le GET.

### API Notes + Tags — contrat validé, non encore disponible

Ces routes et extensions sont prévues pour l'étape 4. Les modèles et invariants
sont définis dans [le modèle métier](02-domain-model.md), sections 5 et 9.
Les conventions REST existantes de JSON, DTO et erreurs restent applicables ;
les limites raisonnables des requêtes et les validations secondaires seront
définies pendant le développement.

#### Note principale

| Méthode | Endpoint | Succès |
| --- | --- | --- |
| `GET` | `/api/v1/videos/{id}/note` | `200` si la note existe |
| `PUT` | `/api/v1/videos/{id}/note` | `201` à la création, `200` ensuite, même sans changement |

Le `PUT` exige un champ `content_md` de type chaîne ; la chaîne vide est acceptée.
Les réponses réussies des deux opérations contiennent `video_id`, `content_md`,
`created_at` et `updated_at`. Le contenu de la note n'est pas intégré aux
représentations générales de `Video`.

- Vidéo inexistante : `404 video_not_found`.
- Vidéo existante sans note, pour le `GET` : `404 note_not_found`.
- Identifiant invalide ou `content_md` absent, `null` ou de type invalide :
  `400 bad_request`.

Aucune route de suppression, d'ajout partiel, d'historique ou de résolution
des conflits n'est prévue dans cette tranche.

#### Tags et associations

| Méthode | Endpoint | Comportement |
| --- | --- | --- |
| `GET` | `/api/v1/tags` | `200`, tous les tags, même inutilisés |
| `POST` | `/api/v1/videos/{id}/tags` | `200`, ajout additif par noms, retour de tous les tags associés |
| `DELETE` | `/api/v1/videos/{id}/tags/{tag_id}` | `204`, même si l'association est déjà absente |

Corps du `POST` :

```json
{"names": ["Go", "SQLite", "DevOps"]}
```

Le `GET` du catalogue et le `POST` utilisent la même enveloppe :

```json
{
  "tags": [
    {"id": 3, "name": "Go"},
    {"id": 7, "name": "SQLite"}
  ]
}
```

Une liste vide est représentée par `{"tags": []}`. Les tags sont ordonnés
par `id` croissant dans toutes les réponses : catalogue, résultat d'ajout et
tags imbriqués dans une vidéo. Cette règle simple donne un ordre stable sans
imposer de tri linguistique à la future interface.

Une vidéo inexistante donne `404 video_not_found` ; des identifiants ou noms
invalides donnent `400 bad_request`.

Les réponses de création, de réajout, de détail et de liste des vidéos incluront
un champ `tags` contenant ces objets `{id, name}`, ou `[]` sans tags.
Aucun endpoint séparé de lecture des tags d'une vidéo n'est nécessaire.

#### Filtrage des vidéos

`GET /api/v1/videos` acceptera le paramètre facultatif `tag_id`, par exemple
`GET /api/v1/videos?tag_id=7`.

- Sans filtre, le comportement existant est conservé, avec l'ajout du champ `tags`.
- Avec filtre, seules les vidéos associées au tag sont sélectionnées.
- La représentation conserve toutes leurs sources et tous leurs tags.
- Un tag inconnu ou inutilisé donne `200` avec `{"videos": []}`.
- Un identifiant invalide donne `400 bad_request`.
- L'enveloppe `{"videos": [...]}` et l'ordre `created_at DESC, id DESC` restent inchangés.

Les combinaisons de filtres et la recherche textuelle sont différées.

## 9. MCP

### 9.1 Même cœur, autre adapter

Le serveur MCP appelle directement les services applicatifs.

Il ne doit pas appeler l'API HTTP locale uniquement pour réutiliser le métier.

```text
REST ─────┐
          │
MCP ──────┼──► Application Services
          │
CLI ──────┘
```

### 9.2 Outils métier

MCP doit exposer des capacités sémantiques.

Exemples :

```text
search_videos
get_video
get_transcript
get_annotations
add_tags
append_note
```

À éviter :

```text
execute_sql
read_database_file
run_ytdlp_command
```

L'agent doit interagir avec le domaine, pas avec l'implémentation.

### 9.3 Position dans la roadmap

MCP est important pour la vision produit, mais peut être implémenté relativement tard.

Lorsque les services applicatifs sont déjà stables, le serveur MCP devient une couche d'adaptation assez mince.

## 10. Interface Web

L'interface Web consomme l'API HTTP.

Elle ne doit pas nécessiter d'accès direct à SQLite ou au filesystem interne.

Le choix du framework frontend n'est pas encore arrêté.

Le MVP peut rester visuellement simple.

## 11. Desktop futur

Une version desktop reste une possibilité, notamment avec un outil adapté à Go tel que Wails.

L'architecture doit permettre :

```text
Desktop UI
    ↓
mêmes services applicatifs
    ↓
SQLite / yt-dlp / filesystem
```

Le choix de Wails n'est pas acté et la version desktop n'est pas prioritaire.

L'important est de ne pas l'empêcher par un couplage excessif entre cœur et serveur HTTP.

## 12. Déploiement initial

L'application cible d'abord un conteneur Docker.

Stockage conceptuel :

```text
/data/
├── sillage.db
├── media/
├── assets/
└── transcripts/   # si des snapshots locaux sont conservés
```

La structure exacte reste non contractuelle.

Le fichier SQLite et les données persistantes doivent vivre sur un volume.

## 13. Gestion des opérations longues

Certaines opérations pourront devenir longues :

- téléchargement ;
- transcription STT ;
- traitements IA ;
- import massif.

Il n'est pas nécessaire de modéliser immédiatement un système persistant de `Job`.

Pour les premiers incréments, certaines opérations peuvent être synchrones.

Un système de jobs pourra être introduit lorsque les limites deviennent concrètes.

## 14. Structure de packages Go possible

Exemple indicatif :

```text
cmd/
  server/

internal/
  video/
    model.go
    service.go
    repository.go

  transcript/
    model.go
    service.go

  note/
  annotation/
  tag/

  adapter/
    sqlite/
    ytdlp/
    ffmpeg/
    filesystem/

  http/
    handlers.go
    routes.go

  mcp/
```

Cette structure n'est pas une décision définitive.

Elle illustre seulement la séparation souhaitée entre :

- domaine/application ;
- adapters techniques ;
- interfaces externes.

## 15. Règles d'architecture

1. Le domaine ne dépend pas de HTTP.
2. Le domaine ne dépend pas de MCP.
3. Le domaine ne dépend pas de SQLite.
4. Le domaine ne dépend pas de `yt-dlp`.
5. Le domaine ne dépend pas d'un LLM particulier.
6. Les handlers restent minces.
7. Les outils MCP appellent les mêmes cas d'usage que l'API.
8. Les formats externes sont interprétés aux frontières avant d'être utilisés par le cœur. Une représentation source peut néanmoins être conservée telle quelle comme snapshot local.
9. Le système de fichiers ne définit pas l'identité des objets métier.
10. Une abstraction n'est introduite que si elle protège une vraie frontière ou répond à un besoin concret.
11. Les contraintes de la base renforcent les invariants applicatifs ; elles ne sont pas remplacées par un simple « check puis insert ».
