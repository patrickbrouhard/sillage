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
- publisher et nom du compte partagé ;
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
    ListByTag(ctx context.Context, tagID TagID) ([]Video, error)
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
Depuis l'étape 4, `ListByTag` sélectionne par association tout en conservant
les sources et tags complets des vidéos.

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
    Extract(ctx context.Context, url string) (VideoSource, error)
}
```

L'adapter `yt-dlp` implémente ce port pour les sources prises en charge.

Depuis l'étape 4 bis, la source normalisée peut contenir les métadonnées d'un
publisher sans identifiant interne. L'adapter résout l'identité externe ; le
repository crée ou retrouve le compte dans la transaction vidéo/source.
L'extraction distante précède cette transaction. Aucun identifiant interne ni
personne de référence ne provient des métadonnées externes.

Le port distinct `PublisherProvider.ResolvePublisher` permet de résoudre une URL
de chaîne indépendamment d'une vidéo. Il est consommé par `PublisherService`.

### 5.4 Transcriptions

`transcript.Service.Fetch` et `Get` portent l'acquisition et la lecture locale.
Ils vérifient d'abord la vidéo et l'appartenance de sa source via un petit
port `VideoReader`, satisfait par le repository vidéo existant.

Le port `Provider` expose une acquisition normalisée :
langue du contenu, `TranscriptContent`, octets source opaques à conserver.
L'adapter yt-dlp découvre les formats audio/captions, sélectionne l'original,
récupère son JSON3 et le parse. Les options CLI et structures JSON3 restent
dans cet adapter. La langue audio enregistrée donne priorité à sa clé exacte
admissible, puis à sa clé générique si l'étiquette est une simple langue-région
(deux lettres ou trois chiffres pour la région) ; sinon seule une piste
`-orig` admissible unique est acceptée. Ce marqueur peut concerner un doublage :
la sélection privilégie l'audio original sans le garantir.
Les langues audio et transcription peuvent diverger. Ni l'import ni l'acquisition
ne déduisent la langue audio d'une caption.

Le port `Snapshots` publie un nouveau fichier complet et relit son contenu
sans réseau. L'adapter filesystem reçoit le parser JSON3 lors de l'assemblage
dans `cmd/server` ; le service ne choisit ni extension ni parser technique.

Le repository de transcription conserve l'identité stable par
`(video_source_id, language, provenance)`. Sa transaction actualise le chemin
et la date, sans modifier la langue audio ni imposer son égalité avec la transcription. Elle ne reste
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

### 5.6 Notes et tags — étape 4 implémentée

Le cadrage et l'implémentation sont terminés. Lecture et enregistrement de la note, catalogue de tags,
ajout et retrait d'associations et filtrage des vidéos passent par des services
applicatifs indépendants de HTTP et SQLite, avec des ports spécialisés et des
handlers minces. REST et le futur MCP réutiliseront les mêmes cas d'usage.
`note.Service` et `video.TagService` utilisent leurs ports spécialisés.
`video.Service.ListVideosByTag` porte le filtrage. Ce découpage reste local
et révisable, sans repository générique.

Ces opérations sont locales et ne dépendent d'aucune acquisition ou actualisation
distante. Les notes et tags restent séparés des métadonnées et transcriptions
source ; un rafraîchissement ne doit pas les écraser.

L'adapter SQLite garantit l'unicité concurrente des tags et associations ainsi
que l'atomicité de tout ajout multiple, créations de tags comprises. Un simple
contrôle d'existence avant insertion ne suffit pas à garantir ces invariants.
La migration embarquée `0003_notes_tags.sql` ajoute les trois tables sans
modifier les vidéos, sources ou transcriptions existantes.

Les lectures filtrées conservent toutes les sources et tous les tags
des vidéos sélectionnées. Le réajout d'une vidéo existante restitue également
ses tags actuels. Le repository charge les sources puis les tags en lot pour
éviter une requête par vidéo et le produit des deux relations.

### 5.7 Publishers et personnes — étape 4 bis implémentée

`video.PublisherService` et `video.PersonService` portent les cas d'usage sur les
comptes, personnes, associations, tags et parcours de navigation. Leurs ports
`PublisherRepository` et `PersonRepository` sont spécialisés et implémentés par
SQLite. Les handlers n'interprètent ni métadonnées externes ni SQL.

Les types restent dans `internal/video`, autour du domaine central, sans framework
d'entités ni repository générique. Ce placement est un choix local révisable.
`NormalizeTagNames` est partagé par les trois services de tags ; le catalogue SQL
reste unique. Le futur MCP pourra appeler exactement les mêmes services.

La création du publisher lors d'un import est atomique avec vidéo et sources.
Sa réutilisation ne fait aucun UPDATE. Le réajout d'une vidéo existante ne modifie
ni ses métadonnées ni ses rattachements explicites, même absents.

Les parcours directs et indirects sélectionnent les vidéos avec EXISTS et les
dédupliquent par leur ID, sans créer d'associations. Les lectures vidéo joignent
les publishers aux sources et chargent séparément les tags et personnes directes
en lot, pour éviter le produit des relations et une requête par vidéo.

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

`ffmpeg` extrait les captures 7.2 dans l'adapter technique `ytdlp.CaptureClient`.
Le service applicatif `asset.Service` orchestre les ports de repository, stockage,
extraction et emprunt du média ; il ne dépend ni des outils CLI ni de SQLite/HTTP.

```text
acceptation → Asset pending → réponse avec identité
                    ↓
         emprunt MediaFile de la source
                    ↓
         extraction locale ou flux YouTube
                    ↓
         validation PNG → publication → état terminal
```

Une seule opération capture appartient au serveur, avec délai maximal de deux
minutes, sans file d'attente. Elle est indépendante de la requête HTTP et du
téléchargement. L'arrêt annule les sous-processus puis attend la finalisation
avant de fermer SQLite. Un serveur unique par répertoire de données reste requis.

L'emprunt du MediaFile et sa suppression partagent le verrou du service média :
la suppression est refusée tant que l'extraction utilise le fichier. La capture
libère l'emprunt avant la publication du PNG. Une anomalie de média local peut
déclencher un repli ; une erreur SQLite ou de stockage n'en déclenche jamais.

Le stockage valide le PNG complet, synchronise son fichier puis publie par lien
sans écrasement dans la même racine. La confirmation SQL suit la publication.
Les fichiers publiés survivent aux échecs SQL ; les fichiers abandonnés ne sont
pas supprimés au démarrage. Seul le temporaire de l'opération vivante est nettoyé.
Le démarrage marque les captures interrompues `failed`, sans régénération.
Si SQLite reste inaccessible lors des deux tentatives de finalisation, la
récupération de l'état attend le prochain démarrage réussi.

Côté Web, une StateField CodeMirror suit un widget avec
`ChangeDesc.mapPos(..., MapMode.TrackDel)`. Les effets visuels ne participent
pas à l'historique. La transaction finale insère le texte et retire le widget.
Le handle de l'ancienne vue ne peut pas insérer dans une session remplacée.
Le suivi des Assets est mutualisé par identité entre le bouton et les images
affichées ; il cesse au démontage, sans arrêter le traitement serveur.

### 7.1 Contrat REST des captures

- `POST /api/v1/videos/{video_id}/sources/{source_id}/captures` :
  `{"timestamp_ms":762345,"request_id":"<UUID>"}`.
  Réponse `202` pour pending, `200` si une répétition retrouve un état terminal.
- `GET /api/v1/assets/requests/{request_id}` : récupération de l'identité après
  une réponse perdue ; si absent, le client peut répéter le POST avec la même clé.
- `GET /api/v1/assets/{asset_id}` : état public et provenance, sans chemin.
- `GET /api/v1/assets/{asset_id}/content` : PNG disponible, sans génération.

Les clés comportent 16 à 80 caractères ASCII alphanumériques, tiret ou underscore.
Une clé réutilisée avec d'autres paramètres reçoit `409`, un serveur occupé
`503` avec `Retry-After`. Les lectures ne relancent jamais une capture.
Un contenu manquant/inaccessible renvoie un refus distinct, sans transformer
un Asset `available` en `failed`. Ces routes servent le même service applicatif
que les futures interfaces.

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
| 409 | `transcript_selection_ambiguous` | Plusieurs pistes originales admissibles sans correspondance exacte ou régionale avec la langue audio enregistrée |
| 502 | `transcript_fetch_failed` | Échec distant ou contenu distant inexploitable |
| 504 | `transcript_fetch_timeout` | Délai applicatif dépassé |
| 500 | `internal_error` | Erreur locale : exécutable indisponible, SQLite, filesystem, snapshot |

Les échecs de processus ne sont pas interprétés en analysant le texte de stderr.
Une déconnexion annule l'opération sans réponse particulière. Un commit déjà
réussi peut néanmoins précéder une déconnexion ; le client peut alors relire le GET.

### API Notes + Tags — disponible

Ces routes et extensions sont implémentées depuis l'étape 4. Les modèles et invariants
sont définis dans [le modèle métier](02-domain-model.md), sections 5 et 9.
Les conventions REST existantes de JSON, DTO et erreurs restent applicables.

Validation des nouveaux corps JSON :

- `application/json` requis, paramètres MIME acceptés ; sinon `415 unsupported_media_type` ;
- un seul objet, champs inconnus refusés ; JSON ou Unicode invalide refusé par
  `400 bad_request`, sans remplacement silencieux de caractères ;
- corps du `PUT` de note limité à 1 Mio et du `POST` de tags à 64 Kio,
  enveloppe et échappements JSON compris ; dépassement : `413 payload_too_large` ;
- `names` est un tableau non vide de chaînes ; absence, `null`, tableau vide,
  élément nul ou nom vide sont refusés par `400 bad_request` ;
- chaque nom est limité à 200 points de code Unicode après suppression des
  espaces aux extrémités ; aucun quota total de tags par vidéo ;
- `tag_id` doit être fourni une seule fois et être un entier strictement positif ;
  valeur vide, répétée, invalide ou requête mal encodée : `400 bad_request`.

Les erreurs locales donnent `500 internal_error`, sans diagnostic technique
dans le JSON. Les limites sont des choix locaux révisables.

#### Note principale

| Méthode | Endpoint | Succès |
| --- | --- | --- |
| `GET` | `/api/v1/videos/{id}/note` | `200` si la note existe |
| `PUT` | `/api/v1/videos/{id}/note` | `201` à la création, `200` ensuite, même sans changement |

En 5.2, le `PUT` exige `content_md` (chaîne, vide acceptée) et
`expected_revision` (entier non négatif, obligatoire). 0 attend une note absente.
Les anciens clients sans précondition sont refusés par `400 bad_request`.
Une version obsolète retourne `409 note_conflict` sans écriture.
Aucun ETag ni If-Match parallèle n'est introduit.
La création retourne aussi `Location: /api/v1/videos/{id}/note`.
Les réponses réussies des deux opérations contiennent `video_id`, `content_md`,
`created_at`, `updated_at` et `revision` positive. Le contenu de la note n'est pas intégré aux
représentations générales de `Video`.

- Vidéo inexistante : `404 video_not_found`.
- Vidéo existante sans note, pour le `GET` : `404 note_not_found`.
- Identifiant invalide ou `content_md` absent, `null` ou de type invalide :
  `400 bad_request`.

Aucune route de suppression, d'ajout partiel ou d'historique n'est prévue.
La résolution d'un conflit réutilise GET et PUT conditionnel ; aucune écriture forcée.
Le service exige la révision attendue et SQLite la compare sous son verrou de
transaction immédiate, y compris à la création. Une lecture HTTP préalable seule
ne constitue pas une protection.

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

Les réponses de création, de réajout, de détail et de liste des vidéos incluent
un champ `tags` contenant ces objets `{id, name}`, ou `[]` sans tags.
Aucun endpoint séparé de lecture des tags d'une vidéo n'est nécessaire.

#### Filtrage des vidéos

`GET /api/v1/videos` accepte le paramètre facultatif `tag_id`, par exemple
`GET /api/v1/videos?tag_id=7`.

- Sans filtre, le comportement existant est conservé, avec l'ajout du champ `tags`.
- Avec filtre, seules les vidéos associées au tag sont sélectionnées.
- La représentation conserve toutes leurs sources et tous leurs tags.
- Un tag inconnu ou inutilisé donne `200` avec `{"videos": []}`.
- Un identifiant invalide donne `400 bad_request`.
- L'enveloppe `{"videos": [...]}` et l'ordre `created_at DESC, id DESC` restent inchangés.

Les combinaisons de filtres et la recherche textuelle sont différées.

### API Publishers + Personnes — disponible

L'étape 4 bis introduit une rupture documentée de `/api/v1` : `creator` disparaît
des sources. Chaque source expose `publisher: {id, name}` ou `null`. Le nom peut
être `null` même si le publisher existe. Aucun `publisher_id` séparé n'est exposé
dans la réponse source ; la persistance conserve bien cette clé étrangère.
Les réponses vidéo ajoutent `person_ids`, liste croissante des associations
directes uniquement, vide sous la forme `[]`.

Les ressources autonomes ont ces représentations :

```json
{"id":7,"provider":"youtube","external_id":"UC…","name":null,"person_id":null,"tags":[]}
```

```json
{"id":3,"name":"Lex Fridman","tags":[]}
```

Les routes suivantes sont préfixées par `/api/v1` :

| Méthode | Route | Corps | Succès |
| --- | --- | --- | --- |
| POST | `/publishers` | `{"url":"https://www.youtube.com/@LexClips"}` | 201 créé avec Location ; 200 réutilisé sans refresh |
| GET | `/publishers` | — | 200, `{"publishers": [...]}` |
| GET | `/publishers/{id}` | — | 200, publisher et tags propres |
| POST | `/persons` | `{"name":"Lex Fridman"}` | 201 avec Location, y compris pour un homonyme |
| GET | `/persons` | — | 200, `{"persons": [...]}` |
| GET | `/persons/{id}` | — | 200, personne et tags propres |
| PATCH | `/persons/{id}` | `{"name":"…"}` | 200, personne renommée |
| PUT | `/publishers/{id}/person` | `{"person_id":3}` ou `{"person_id":null}` | 204 |
| PUT | `/videos/{video_id}/sources/{source_id}/publisher` | `{"publisher_id":7}` ou `{"publisher_id":null}` | 204 |
| PUT / DELETE | `/videos/{video_id}/persons/{person_id}` | aucun corps | 204, idempotent |
| POST | `/publishers/{id}/tags` | `{"names":["DevOps"]}` | 200, tous les tags associés |
| POST | `/persons/{id}/tags` | même format | 200, tous les tags associés |
| DELETE | `/publishers/{id}/tags/{tag_id}` | — | 204, association seule |
| DELETE | `/persons/{id}/tags/{tag_id}` | — | 204, association seule |
| GET | `/publishers/{id}/videos` | — | 200, `{"videos": [...]}` |
| GET | `/persons/{id}/publishers` | — | 200, `{"publishers": [...]}` |
| GET | `/persons/{id}/videos?relation=direct\|publisher\|all` | — | 200, `{"videos": [...]}` |

`relation` vaut `all` par défaut ; valeur vide, inconnue ou répétée : 400.
Les vidéos conservent l'ordre `created_at DESC, id DESC`, toutes leurs sources,
leurs tags et leurs associations directes. Une vidéo commune aux deux chemins
n'apparaît qu'une fois. Publishers, personnes, tags et identifiants de personnes
sont ordonnés par ID croissant. Les catalogues incluent les entités sans liens.

Les corps JSON suivent les conventions strictes existantes : objet unique,
champs inconnus refusés, UTF-8 valide et `application/json` requis. Limites locales :
16 Kio pour création/renommage/rattachement, 64 Kio pour les tags ; dépassement : 413.
Les champs de rattachement doivent être présents ; seul `null` retire le lien.
`Person.name` est non vide après trim, sans unicité. Les noms de tags gardent les
limites et la normalisation existantes. Les ajouts de tags sont additifs et atomiques.

Les erreurs d'identifiant, d'entrée ou de provider incompatible donnent
`400 bad_request`. Les ressources absentes donnent `404 publisher_not_found`,
`person_not_found`, `video_not_found` ou `video_source_not_found` ; une source
d'une autre vidéo est également absente pour ce chemin.
La résolution distante utilise `502 metadata_fetch_failed` et
`504 metadata_fetch_timeout`, avec `SILLAGE_POST_TIMEOUT`. Une erreur locale
donne `500 internal_error`. Les diagnostics techniques ne sont pas exposés.

Le catalogue `/tags` reste unique. Le filtre `/videos?tag_id=…` reste direct.
Aucune suppression de personne/publisher, aucun rafraîchissement, rôle,
héritage ou traitement de collaboration n'est exposé.

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

**Acté :** SPA React avec TypeScript et Vite, consommant l'API REST Go existante.
Le cœur applicatif reste indépendant de React et des interfaces. Aucun accès
direct du navigateur à SQLite ou au filesystem interne n'est prévu.

En développement, Vite sert l'interface et relaie `/api` vers Go ; les appels
du navigateur restent relatifs, sans ajouter de CORS. En production, Go sert
les fichiers statiques compilés livrés à côté du binaire dans la même image
Docker. Aucun SSR ni serveur Node.js permanent n'est requis.

Le jalon 1 utilise `SILLAGE_WEB_DIR` pour activer le build statique. Son absence
conserve le serveur API seul, indépendant de Node pour sa compilation.
Le répertoire est ouvert avec `os.OpenRoot` pour borner les accès filesystem.

Les routes API, les assets et les routes SPA doivent être séparés : le repli vers
`index.html` ne doit jamais masquer une erreur API ou un asset absent. Seul le
répertoire frontend est public, jamais celui des données.

En 5.1, le jalon 2 utilisait React Router en mode déclaratif pour `/`, `/videos/new`
et `/videos/:videoId`. Les cartes et retours sont des liens ; la fiche relit
REST indépendamment de la navigation précédente. Les lectures sont annulées
au démontage et leurs réponses tardives ignorées. Le formulaire lance un seul
POST par soumission explicite et distingue 201/200 sans modifier AddVideo.
L'état reste local aux pages ; aucune bibliothèque de store n'est ajoutée.
En 5.2, un data router React Router permet le blocage des navigations internes
et de l'historique pendant la confirmation des sauvegardes. CodeMirror 6 est
intégré directement et reste monté, masqué pendant la lecture GFM chargée à la demande.
CodeMirror utilise son découpage natif CRLF/CR/LF et sa sérialisation LF, y compris
pour les collages Windows. L'ancien `lineSeparator.of('\n')` est retiré : il laissait
des CR dans le document et créait des positions de caret invisibles en fin de ligne.
La session travaille sur une représentation LF et compare avec la version LF du
contenu confirmé, tout en gardant la réponse serveur originale et sa révision.
Ainsi, ouvrir une ancienne note, changer de mode ou quitter la fiche ne déclenche
aucune écriture de normalisation. Un enregistrement explicite peut la normaliser
même sans édition visible ; les éditions continuent à utiliser l'autosauvegarde.
Le choix de la version serveur après conflit applique la même représentation locale.

Le service applicatif Go normalise CRLF puis CR en LF avant d'appeler le port de
persistance. SQLite compare ce contenu canonique sous la précondition de révision
existante ; les variantes de séparateurs n'incrémentent pas une note déjà canonique.
La première normalisation d'une ancienne note incrémente sa révision. Les GET ne
transforment rien et aucune migration n'est ajoutée. Les réponses de sauvegarde LF
permettent la réconciliation après réponse perdue, sans seconde écriture automatique.

Une session locale par note gère le contenu courant, la dernière version confirmée,
les temporisations et une unique écriture en cours. Elle est détruite à la sortie ;
aucun brouillon n'est persisté dans le navigateur. Les requêtes ont un délai de
12 secondes. Les reprises réseau sont limitées à deux, après 1 puis 3 secondes,
avec relecture de l'état serveur après un résultat incertain. Ces valeurs sont
des choix locaux révisables. Les conflits suspendent l'autosauvegarde ; le choix
local reste conditionnel sur la version serveur consultée. Le service et SQLite
assurent la protection pour tous les clients, indépendamment de cette session React.

La fiche 5.1 ne fige pas le workspace ultérieur : note stable, transcription
indépendante et lecteur flexible. Les références temporelles relèvent de 6.

### Workspace 5.3

Le frontend sélectionne la première source `youtube` dont l'identifiant externe
est exploitable par l'IFrame API (11 caractères alphanumériques, tiret ou underscore),
dans l'ordre REST. Cette source unique alimente le lecteur et les URLs de
transcription. Aucun changement de contrat REST, de domaine ou de persistance.
L'absence de source compatible n'affecte pas la note. Les composants restent
montés pendant les changements de grille CSS et de visibilité du lecteur.

L'IFrame Player API est chargée à la demande par une promesse partagée. L'iframe
déclare l'origine réelle, une politique `strict-origin-when-cross-origin`, les
commandes natives et aucune lecture automatique. Le chargement du script et
l'attente de `onReady` ont chacun une limite locale de 15 s et un réessai explicite.
Les événements des instances détruites ou en échec sont ignorés, y compris sous
StrictMode. Le masquage attend une pause confirmée et conserve normalement
l'instance. Sans confirmation après 1 s, ou après une reprise inattendue une fois
masqué, le lecteur est détruit pour arrêter le média ; ces échecs exceptionnels
ne conservent pas la position. La navigation détruit également l'instance.
Ces choix ne définissent pas un comportement générique pour les futurs médias locaux.

Le panneau de transcription conserve séparément son contenu et l'opération en
cours. Le GET local est borné à 12 s côté navigateur ; le POST à 90 s, indépendamment
du délai des notes. Le serveur conserve son délai configurable, de 60 s par défaut :
si celui-ci est porté au-delà de 90 s, le navigateur peut interrompre l'attente avant
le serveur. Une réponse POST incertaine provoque une seule relecture GET, jamais
un POST automatique ; un contenu retrouvé ne prouve pas à lui seul le succès de
l'actualisation demandée. Les réponses abandonnées ne modifient pas la fiche suivante.

Le regroupement parcourt les items dans leur ordre source et crée des blocs
consécutifs par intervalle fixe de 10 secondes depuis 6.3. Les groupes composés
uniquement de blancs sont rattachés
au texte précédent, ou préfixés au premier bloc textuel s'ils sont initiaux, sans
ligne horodatée dédiée ni changement du timestamp du bloc textuel. Les items restent
intacts. Le rendu utilise du texte échappé et `white-space: normal` : chaque bloc
forme un paragraphe fluide, avec normalisation visuelle des blancs et retour à la
ligne selon la largeur disponible. Aucune transformation JavaScript des chaînes
n'est nécessaire ; les données et les règles de regroupement restent inchangées.

Les tests navigateur emploient une IFrame API contrôlée, sans accès à YouTube,
et un faux yt-dlp exécuté par le backend réel pour acquérir puis relire des snapshots.
Les essais avec YouTube réel restent complémentaires aux validations déterministes.

### Recherche locale de transcription 6.3

`TranscriptText` reçoit les fragments chargés et regroupe leur présentation à
10 secondes. La recherche utilise leur concaténation exacte dans l'ordre source,
indépendamment des blocs. `findTranscriptMatches` échappe la saisie puis utilise
une expression régulière Unicode insensible à la casse, avec chaque suite de blancs
de la requête remplacée par `\s+`, pour obtenir des intervalles
UTF-16 dans le texte original, sans conversion préalable susceptible de déplacer
les indices. Les occurrences sont littérales hors équivalence des blancs et non chevauchantes.

`highlightTranscript` parcourt les blocs et les occurrences dans l'ordre pour
projeter ces intervalles en portions de texte exactes. Une occurrence traversant
plusieurs blocs garde le même indice et le même état actif dans chaque portion.
React échappe le texte des éléments `mark` ; aucun HTML de transcription n'est injecté.
Le contenu, les blocs et les résultats sont dérivés en mémoire, sans dépendance ajoutée.

La sélection repart de zéro quand la requête ou le contenu reçu change. La session
de recherche est associée aux IDs vidéo/source ; aucun état navigateur persistant.
Le défilement vise la première portion active : scroll du conteneur sur desktop,
défilement de page sur mobile. Aucun focus n'est transféré au résultat ni commande
lecteur émise ; seul le callback des timestamps conserve la navigation 6.1.
Acquisition et gestion des erreurs restent dans `VideoTranscript`.
Aucun changement REST, domaine ou SQLite ; aucune segmentation linguistique.

### Navigation transcription → YouTube 6.1

La fiche relie le callback de la transcription à une commande impérative du lecteur
YouTube de la même source. La commande reçoit les millisecondes du bloc ; seul le
lecteur les convertit en secondes (`start_ms / 1000`, sans arrondi). Aucun état
temporel ne traverse la session de note et aucune file de commandes n'est créée.

Selon la [sémantique officielle de l'IFrame API](https://developers.google.com/youtube/iframe_api_reference#seekTo),
`seekTo(seconds, true)` conserve la pause uniquement depuis l'état `paused` (2).
Il est utilisé pour toutes les navigations explicites depuis les états connus
(-1, 0, 1, 2, 3, 5). Depuis unstarted, cued ou ended, le clic demande donc aussi
le démarrage. Un état inconnu refuse la commande. Aucun playVideo supplémentaire.
cueVideoById reste réservé au départ initial d'une bascule, sans lecture.
YouTube peut viser l'image clé précédente : transmettre la valeur exacte ne
garantit pas une précision de lecture à la milliseconde.

Le lecteur masqué est réaffiché avant navigation ; un masquage dont la pause n'est
pas confirmée garde priorité. Sans instance prête, le clic est refusé explicitement
et n'est jamais rejoué après chargement, réessai ou changement de fiche. Une
exception de commande passe par le même arrêt et la même invalidation des événements
tardifs qu'une erreur YouTube. L'UI n'annonce pas de succès confirmé à partir d'une
commande sans accusé de position. Ni REST, ni domaine, ni SQLite ne changent.

Le double navigateur reproduit le démarrage de `seekTo` hors pause et la préparation
sans lecture de `cueVideoById`. Les tests couvrent les six états natifs, clavier,
clics répétés, fractions de seconde, masquage, erreurs, absence de commande différée
et conservation de la session de note.

### Insertion du temps courant 6.2

La fiche compose une référence à partir de sa vidéo, de sa source de travail
et d'une lecture synchrone `getCurrentTimeMs()` du lecteur. L'adapter YouTube
appelle `getCurrentTime()` seulement pour une instance prête, hors masquage en
cours, dans les états ended (0), playing (1) ou paused (2). Un lecteur masqué
conservé en pause reste utilisable sans réaffichage. Les états unstarted (-1),
cued (5), buffering (3) et inconnus sont refusés ; un départ préparé lors d'une bascule
n'est jamais substitué à la position courante. Les valeurs non finies, négatives
ou hors des entiers sûrs en millisecondes sont refusées. Zéro reste valide.
La conversion utilise `Math.round(seconds * 1000)` ; elle conserve la précision
fournie sans garantir une précision réelle de mesure à la milliseconde.
Aucune lecture, pause, navigation, acquisition ou commande différée n'est déclenchée.

Le constructeur spécifique `temporalReference` produit uniquement
`[libellé](sillage://videos/{videoID}/sources/{sourceID}?start_ms={milliseconds})`.
L'autorité est `videos`, le chemin commence par l'identifiant vidéo. Aucun parseur
général ni résolution de références n'est nécessaire. `end_ms` reste réservé.

`VideoNote` demande l'insertion via une commande impérative du `MarkdownEditor`
existant. Une transaction insère à `selection.main.to`, sans remplacer la
sélection, ajoute un espace de continuation, place le curseur après celui-ci,
puis rend le focus. `isolateHistory.of('full')` sépare l'action des frappes voisines
et des autres insertions. L'écouteur `docChanged` alimente la session et ses délais
d'autosauvegarde existants, y compris sa suspension en cas d'erreur ou conflit.
Ni `initial`, ni l'état complet de l'éditeur ne sont réinjectés. La note suit la
convention LF canonique. Le bouton est désactivé en mode Lecture.

Le rendu initialement inerte de 6.2 est remplacé par l'activation contrôlée
de 6.5 en Lecture seulement (voir ci-dessous), sans modification du Markdown persisté.

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

Le fichier SQLite et les données persistantes vivent dans un bind mount vers un
répertoire hôte explicite et configurable. Compose ne crée pas de volume nommé.
Le chemin actuel est `data/` relatif au processus : le packaging emploie
`WORKDIR /app` et un bind mount `/app/data`, snapshots et sauvegardes compris.
Le serveur écoute sur toutes les interfaces du conteneur, mais le port publié
reste lié à localhost par défaut, en l'absence d'authentification.
Le Dockerfile multi-stage et Compose sont implémentés au jalon 4 de 5.1.
Le conteneur non-root réunit Go, le frontend et les outils externes ; seule la
publication localhost est activée par défaut. Les données ne font jamais partie
de l'image. Voir le README pour les droits et les sauvegardes à froid.

## 13. Gestion des opérations longues

Certaines opérations pourront devenir longues :

- téléchargement ;
- transcription STT ;
- traitements IA ;
- import massif.

Il n'est pas nécessaire de modéliser immédiatement un système persistant de `Job`.

Les acquisitions de métadonnées/transcriptions restent synchrones. En 7.1,
le téléchargement est asynchrone et possédé par le service applicatif.

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

### Citation de transcription 6.4 — implémentation frontend

La sélection DOM est traduite en offsets du texte continu, en parcourant uniquement
les paragraphes de transcription (mark inclus) ; le fragment du premier caractère
non blanc fournit le start_ms. Copie et citation partagent l'extraction normalisée,
sans modifier le modèle source. La commande traverse la fiche vers la session de note,
sans dépendance envers le lecteur ni API supplémentaire. CodeMirror distingue
l'emplacement choisi des focus automatiques, conserve sa sélection et réalise
l'insertion comme transaction isolée. Voir Product & UX et roadmap pour le contrat,
les refus et les limites de contexte Markdown.

Le module transcriptSelection traduit les bornes de Range en offsets UTF-16,
en ignorant les boutons de timestamp. Les bornes normalisées de Range couvrent
aussi les sélections inversées et les éléments mark. L'extrait mémorisé est lié
à la version du rendu ; une nouvelle recherche ou un remplacement effectif
l'invalide. L'événement copy utilise la sélection vivante et fournit text/plain,
sans intercepter les copies de champs ou de l'éditeur. Il ne nécessite aucune
permission Clipboard API dans l'application.

VideoPage construit la référence avec les identifiants de la fiche/source,
puis appelle l'action impérative de VideoNote vers MarkdownEditor.
L'éditeur mémorise le choix explicite par geste de pointeur, navigation clavier
ou transaction utilisateur ; les focus et insertions programmatiques ne suffisent
pas. Ce choix est réinitialisé avec une nouvelle version d'éditeur, conservé lors
des pertes de focus et des bascules Lecture/Édition. L'insertion utilise la borne
supérieure de la sélection CodeMirror et isolateHistory, sans changer NoteSession
ni son protocole de sauvegarde. Les séparateurs LF sont ajoutés uniquement selon
le texte adjacent, sans analyse du contexte Markdown.


### Navigation temporelle Markdown 6.5

parseTemporalReference est un parseur pur du format canonique produit par Sillage :
validation de la structure entière puis des entiers sûrs, sans normalisation d'URI.
MarkdownReading autorise ces seules URI sur les href de liens via urlTransform,
et délègue les autres attributs/URL au filtre standard de react-markdown.
Le composant de lien devient un bouton natif pour une référence valide ; aucun
href sillage:// n'est envoyé au navigateur. Les liens de même origine restent
des Link React Router. Les autres liens HTTP(S) reçoivent target="_blank" et
rel="noopener noreferrer" ; les autres protocoles autorisés, dont mailto,
gardent leur comportement natif. Ce traitement commun couvre les autoliens GFM.
Le libellé reste le nom accessible ; une description donne le temps structuré.

VideoDetail vérifie les identités vidéo/source de travail et appelle la même
fonction navigate que la transcription. Les refus sont présentés près du bouton
dans une région status ; ils ne passent pas par NoteSession. Les composants de lien
restent stables lors des mises à jour de sauvegarde pour préserver le focus.

YouTubePlayer conserve son protocole immédiat. Une commande transmise incrémente
un état local qui déclenche une mesure en useLayoutEffect, après réaffichage DOM.
La zone youtube-frame est comparée au viewport visuel ; window.scrollBy instantané
déplace seulement la page du delta nécessaire. Aucune attente onReady, animation,
file d'attente, focus d'iframe ou synchronisation continue n'est ajoutée.
Une fiche démontée ne conserve aucun travail de défilement différé.

### Callouts de citation UX 1.1

remarkCallouts reconnaît deux en-têtes dans l'arbre mdast et vérifie leur ligne
source, pour distinguer notamment marqueurs littéraux, échappés et inconnus.
Le plugin isole les en-têtes dans une copie temporaire du texte de rendu, puis
réanalyse la note entière avec le même parseur. Cela empêche les syntaxes inline
et setext de traverser l'en-tête tout en conservant les définitions Markdown/GFM
communes au document. Les continuations paresseuses sont explicitées dans cette
copie uniquement ; les bornes des liens traversant l'en-tête servent à empêcher
leur réactivation par les autoliens GFM. Aucun texte enregistré n'est modifié.
Cette seconde analyse ne relance pas les transformations Remark ; le plugin
s'insère après remark-gfm dans la chaîne actuelle, sans second renderer du corps.

Les propriétés temporaires du blockquote indiquent seulement sa forme et
l'attribution ou l'URI validée avec son titre facultatif en texte simple.
QuoteCallout affiche « Transcription » lorsque le titre manque ou ne contient
que des blancs. La reconnaissance sépare la destination du titre avant validation ;
les parenthèses et syntaxes Markdown du titre restent littérales.
QuoteCallout partage la présentation et reçoit
une action React ; il ne parse aucun Markdown, ne valide aucune URI et ne commande
pas le lecteur. MarkdownReading réutilise TimeButton, parseTemporalReference
et le callback 6.5 existants, avec des composants stables pendant la sauvegarde.
Le filtre des URL et skipHtml restent en place ; les en-têtes rejetés deviennent
des nœuds texte, jamais du HTML ni des liens externes.

temporalReferenceURI centralise la génération canonique pour l'insertion rapide
et transcriptCitation. Aucun changement de CodeMirror, de NoteSession, de REST,
du domaine ou de SQLite. Aucun registre, plugin configurable ou nouveau type.


### Décorations Markdown UX 1.2a

markdownDecorations est un ViewPlugin CodeMirror : Decoration.line pour la
bordure et le fond, Decoration.mark pour marqueur, URI et attribution/titre.
L'arbre syntaxique Lezer de l'éditeur détermine les blockquotes et leur ascendance ;
la présence textuelle de > ne suffit jamais. Les décorations sont limitées aux
lignes visibles, avec contexte du bloc hors écran, et recalculées au changement
du document, du viewport ou de l'arbre syntaxique incrémental.

La bordure par ombre intérieure ne décale pas le texte et suit la hauteur des
lignes repliées. Les lignes couvertes par plusieurs citations sont dédupliquées.
L'extension ne produit aucune transaction, aucun widget ni plage de remplacement.
Elle est installée dans la session EditorView existante.

Seule parseCalloutHeader, fonction pure de validation d'une ligne littérale,
est partagée avec Remark. Chaque environnement conserve son arbre et contrôle
le contexte de reconnaissance. Aucun Remark dans l'éditeur, aucun arbre unifié,
nouvelle dépendance ou moteur générique.

### Compaction temporelle UX 1.2b.1

compactTemporalReferences est une extension CodeMirror distincte de
markdownDecorations. Un ViewPlugin parcourt les Link de l'arbre Markdown dans
les plages visibles, rejette les contextes non admissibles et applique
parseTemporalReference à la destination exacte. Aucun parseur Remark ni
normalisation de destination n'est ajouté. La reconnaissance des en-têtes connus
exclut leurs lignes littérales, y compris dans les citations imbriquées.

Decoration.replace et WidgetType remplacent visuellement des liens monolignes,
sans atomicRanges. Les remplacements ont des frontières non inclusives.
Les sélections qui intersectent les liens retirent leurs décorations ; une keymap
prioritaire permet l'entrée depuis les frontières et protège la suppression
immédiate d'une source cachée. Le clic place une sélection native dans le libellé.
Les widgets égaux conservent leur DOM, sans position source capturée dans un
callback. Les plages sont recalculées lors des changements de document, sélection,
viewport ou arbre syntaxique. Les événements de composition suspendent les
remplacements avec un effet sans modification documentaire ; le retour attend
la fin du traitement natif. Le timer est annulé au démontage.

L'extension reste montée dans la même session. Seul docChanged continue de
déclencher onChange/autosauvegarde. Copie, insertion, modèle NoteSession et
historique textuel restent natifs. UX 1.2b.1 n'introduisait pas de callback lecteur ;
UX 1.2b.2 étend ce périmètre ci-dessous.


### Navigation en Édition UX 1.2b.2

compactTemporalReferences reçoit une fonction d'activation via une facet locale.
MarkdownEditor délègue à callbacks.current ; une nouvelle fonction React ne
reconstruit donc pas EditorView. VideoNote appelle le même onNavigate que Lecture
et affiche le résultat hors de CodeMirror et de NoteSession, dans une région status.

Le collecteur reconnaît également les en-têtes par le contexte Lezer et
parseCalloutHeader. Il conserve la référence validée et la plage exacte d'URI.
Les liens des titres et les en-têtes inadmissibles restent exclus. Le widget et
les protections de sélection/suppression existants servent aux deux formes.

Le mousedown modifié est intercepté avant la sélection native, uniquement sur une
plage reconnue. La position provient du DOM du widget ou de posAtCoords pour la
source révélée. La commande Mod-Enter vérifie un curseur unique strictement intérieur.
L'activation ne dispatch aucune transaction et ne transfère pas le focus.
Le contrôle vidéo/source et player.navigate restent exclusivement dans la fiche
et le lecteur existants ; aucune copie du protocole 6.5 n'est introduite.

Le retour de survol utilise une classe DOM locale au ViewPlugin et des marques
sur les seules plages reconnues révélées. Les widgets compacts conservent leur DOM.
Les événements souris renseignent l'entrée et la sortie ; keydown/keyup sur la
fenêtre couvrent le modificateur pressé sans déplacement de souris, même sans focus
dans l'éditeur. blur efface l'état et destroy retire les écouteurs. La CSS cible
uniquement les références ; aucune transaction n'est émise pour le curseur.


## Téléchargements 7.1 — implémentation

Un service applicatif spécialisé, partagé par REST et futur MCP, prend en charge
les acquisitions indépendamment du contexte HTTP. Une opération globale active,
sans file ; deux demandes de la même source retrouvent l'opération. Une autre
source reçoit un refus temporaire. État actif/dernier échec en mémoire seulement.
Délai propre au téléchargement et arrêt borné du groupe yt-dlp/ffmpeg avec le serveur.
Aucun job persistant, reprise automatique ou annulation utilisateur.

Routes retenues :
- POST /api/v1/videos/{video_id}/sources/{source_id}/download
- GET /api/v1/videos/{video_id}/sources/{source_id}/download
- DELETE /api/v1/videos/{video_id}/media-files/{media_file_id}

POST sans corps : 202 et Location pour une acquisition active, 200 si déjà disponible.
GET local : non téléchargé/en cours/disponible/échec ; aucune exposition des chemins.
La suppression vise une identité précise. La tranche de lecture locale ajoute désormais GET/HEAD sur le contenu de cette identité (voir ci-dessous).

Acquisition dans une zone maîtrisée de data/media, sur le filesystem final :
validation, synchronisation, renommage puis transaction SQLite courte.
Disponibilité seulement après finalisation complète, y compris libération de l’activité.
Le rapprochement est conservateur, sans effacement compensatoire.
Suppression récupérable via déplacement provisoire puis suppression SQL et physique.
Une disparition extérieure est signalée, sans téléchargement automatique.


### Frontières et état

internal/media.Service réutilise un VideoReader et des ports Repository,
Provider et Storage. media.File représente le MediaFile métier. Les adapters
SQLite, filesystem et ytdlp.MediaClient normalisent leurs formats techniques.
L'ID de source indexe l'activité globale ; aucun objet Job ni opération durable.
Start vérifie l'appartenance, retrouve le fichier existant ou l'opération active,
puis réserve la place avant la goroutine. Le contexte de travail dérive du serveur,
jamais de la requête. Les derniers échecs sont bornés à 64 sources en mémoire ;
l'éviction d'une ancienne erreur n'est pas un historique.

Get expose downloading tant que l’opération reste active, nettoyage final compris.
Après libération atomique de l’activité et de son résultat sous verrou, Get consulte
SQLite puis présence, taille et lisibilité du fichier ; il ne lance
ni yt-dlp ni ffprobe. Il ne prouve donc pas l'intégrité d'un fichier modifié à taille
identique. L'état disponible est déduit de la référence durable et du disque,
pas d'une ancienne valeur en mémoire. La suppression et la publication sont
sérialisées avec les consultations ; aucune transaction SQL ne couvre le réseau.

### Publication, suppression et rapprochement

Racine fixe data/media, sous /app/data dans Docker. Une zone .pending-<nombre>
contient les pistes et le fichier final ; aucun JSON de découverte n’est réinjecté. La sortie validée est
synchronisée puis renommée avec un nom aléatoire sûr avant insertion SQL.
La base stocke seulement le nom relatif. Tout fichier déjà publié est conservé
en cas d'erreur SQL ; une relecture peut confirmer un commit au résultat incertain.

La suppression vivante renomme en .deleting, synchronise, supprime la ligne puis
les octets. Au démarrage, seul un .deleting référencé, sûr et sans original peut
être restauré. Les orphelins, temporaires abandonnés et .deleting sans référence
restent intacts et sont signalés. Aucun écrasement en présence de deux versions.
Les anomalies isolées n'empêchent pas le serveur de donner accès aux connaissances.
Les opérations sur un média dangereux ou inaccessible échouent explicitement.
Une racine média inutilisable au démarrage désactive les opérations média jusqu’au
redémarrage après réparation ; le reste du serveur continue. Les anomalies isolées
sont consignées dans les logs et les références indisponibles restent des erreurs
de consultation. Aucun nouvel endpoint de maintenance ou diagnostic n’est ajouté.

Ce protocole ne crée pas de transaction commune SQLite/filesystem. Une seule
instance utilise data/. Une maintenance explicite reste future ; aucun rattachement,
nettoyage ou retéléchargement implicite après restauration de sauvegarde.

### Transport et cycle serveur

REST utilise les états not_downloaded, downloading, available, failed. Le dernier
échec est une réponse GET 200 avec error.code ; un problème de consultation utilise
un statut d'erreur HTTP. Les DTO exposent id, format, size, duration_ms, added_at et les six attributs
nullable video_codec, audio_codec, width, height, fps, audio_language, jamais path. Le détail du contrat et les codes sont dans le README.

SILLAGE_DOWNLOAD_TIMEOUT vaut 6h par défaut, indépendant de SILLAGE_POST_TIMEOUT.
Les appels d'outils ont des sorties bornées. Sous Linux, chaque commande crée un
groupe ; l'annulation envoie SIGTERM, attend une seconde, puis SIGKILL au groupe,
descendants compris. Close attend les opérations avant fermeture de SQLite.
Le shutdown HTTP conserve son budget de 10s ; Compose laisse 15s.
Aucune annulation utilisateur ; les états transitoires sont oubliés au redémarrage.

Le composant VideoDownload est un enfant indépendant des commandes de YouTubePlayer.
Il ne possède aucune référence au lecteur ou à l'éditeur. Les clés du workspace
ne changent pas au gré des états de conservation.


### Acquisition simplifiée et métadonnées — correctif livré

Le correctif utilise une invocation yt-dlp avec contrôles natifs
avant acquisition, puis une validation ffprobe. Le port Acquired et File
portent les six nouvelles métadonnées nullable ; le DTO media_file existant
les expose sans nouvel endpoint. Un seul état React alimente commandes et
métadonnées locales. Publication, récupération, concurrence et arrêt restent inchangés.

Le filtre natif yt-dlp exige id, extractor_key=Youtube et live_status not_live/was_live
avant téléchargement des octets. Les sorties préfixées source: (pre_process) et
result: (after_move) sont des projections JSON minimales, bornées en mémoire.
Un refus filtré peut sortir avec succès sans résultat final : le parser exige
une identité cohérente, un statut terminé et un unique résultat avant ffprobe.
Un échec de l'extracteur avant ce préambule reste download_failed.
Le groupe de processus, le délai et le nettoyage temporaire existants sont conservés.
useVideoDownload possède la consultation unique ; VideoDownload et LocalFileDetails
la partagent. Les propriétés ajoutées sont aussi présentes dans les erreurs
local_media_unavailable, afin de décrire un fichier enregistré devenu indisponible.


## Journalisation HTTP

Le logger slog est construit au point de composition et porté par le contexte.
internal/logging ne connaît ni HTTP ni les adapters. Les objets métier restent
indépendants de la journalisation. Les services ne lisent pas le contexte Chi.

Le middleware extérieur couvre l'API et la SPA avec RequestLogger de Chi et une récupération
locale des panics. Les handlers enrichissent une seule entrée HTTP avec un code public et
un diagnostic sûr. Le modèle de route est récupéré après résolution ; aucune URL
arbitraire n'est journalisée. Les panics n'exposent pas leur valeur. Le writer
Chi conserve les capacités de réponse ; HEAD, Range, flush progressif et hijack
sont vérifiés. Une requête abandonnée sans réponse n'est pas comptée comme 200.
Avant engagement de la réponse, un panic produit 500. Après écriture ou flush,
il provoque ErrAbortHandler pour interrompre le flux sans le terminer normalement.
Le bilan conserve ERROR et les seules positions du code, jamais la valeur du panic.
Une annulation HTTP ne rétrograde pas une erreur serveur déjà constatée.
Les crashes du runtime peuvent rester sur stderr hors de ce mécanisme.


Les services capture et média conservent le logger de l'opération sur le contexte
serveur, avec origin_request_id copié à l'acceptation. Le contexte HTTP n'est
jamais le parent du worker. Les vérifications SQL indépendantes conservent ce
logger. Une capture utilise capture:<asset_id> ; un téléchargement reçoit une
identité aléatoire éphémère. La clé de commande capture reste inchangée.

Le résultat terminal suit le nettoyage et la finalisation. Une vérification
confirmant un commit incertain autorise un succès ; sinon les logs distinguent
l'incertitude et la conservation du fichier. Aucun journal ne remplace l'état
persistant. Après un crash, un début peut ne pas avoir de fin.

La récupération d'une capture par sa clé de commande enrichit son bilan HTTP
avec asset_id et operation_id de la capture retrouvée. La clé brute reste exclue ;
la nouvelle requête HTTP ne remplace pas origin_request_id de l'opération.

## Lecture locale — transport et composition du workspace

GET et HEAD /api/v1/videos/{video_id}/media-files/{media_file_id}/content
servent une identité exacte. Le service vérifie les IDs, la vidéo propriétaire,
la finalisation et l'ouverture. Le port Storage.Open retourne Reader/Seeker/Closer.
Le filesystem borne l'ouverture par os.OpenRoot, vérifie la racine ouverte,
refuse les liens symboliques finaux avec O_NOFOLLOW et les fichiers non réguliers.
O_NONBLOCK évite le blocage sur un FIFO substitué ; Stat contrôle le descripteur
réel et sa taille. Les fichiers .deleting ambigus restent indisponibles.
Aucun chemin ne vient de la requête ni ne sort dans les DTO.

L'ouverture et la prise de réservation sont sérialisées avec DELETE. La lecture
s'effectue sans verrou global. Close ferme le descripteur puis libère une seule
fois la réservation ; le handler le diffère, y compris après déconnexion ou panic.
Plusieurs lectures sont possibles, ainsi que les captures et les téléchargements
d'autres sources. DELETE refuse un fichier réservé. Une réservation protège une
requête, pas une séance complète : après sa fin, une suppression peut réussir et
une requête Range ultérieure recevoir 404. La connaissance reste accessible.

Le handler utilise http.ServeContent : corps complet, HEAD, plages et réponses
206/416, requêtes conditionnelles natives. Le MIME est déduit de l'extension du
conteneur validé, avec application/octet-stream si inconnu, sans liste de formats
autorisés. X-Content-Type-Options: nosniff et Cache-Control: no-store sont posés.
Sur les erreurs de plage, Go peut retirer les en-têtes de cache selon son
comportement standard. Aucun encodage HTTP transformant les octets n'est ajouté.
Les erreurs avant transfert conservent les codes 400 bad_request, 404
video_not_found/media_file_not_found, 409 local_media_unavailable et 500 internal_error.
Les réservations de lecture/capture utilisent le refus 503 download_busy existant
à la suppression, avec un message désormais adapté à l'utilisation d'un média.

VideoPlayer possède le panneau et l'en-tête permanents ; il compose les deux surfaces
concrètes avec getCurrentTimeMs, navigate et stop pour les usages du workspace.
PlayerSurfaceHandle ajoute toggleVisibility pour l'en-tête et getTransferPosition,
réservé à la bascule (confirmed, prepared, empty ou uncertain) ; la surface
publie sa visibilité confirmée, notamment après pause YouTube. Une seule instance
de lecture est montée.
La sélection initiale attend le premier état de téléchargement ou son erreur :
Local si available, sinon YouTube. Aucun lecteur n'est monté pendant l'attente.
Le choix n'est pas recalculé lors des actualisations du téléchargement. Local utilise directement
l'URL HTTP dans video, sans téléchargement préalable du fichier dans un Blob.

La bascule transmet une position initiale facultative, consommée une fois à
onReady/loadedmetadata. L'ancienne instance est arrêtée avant la transition ;
les effets nettoient leurs écouteurs et ignorent les événements obsolètes.
Les timestamps ordinaires ne rejoignent jamais ce mécanisme d'initialisation.
Le curseur de transfert circule dans VideoPlayer par la sélection de session ;
chaque surface conserve et qualifie sa préparation, sans historique parallèle ni
hook supplémentaire. La clé vidéo/source du workspace borne cette mémoire.
YouTube conserve le départ cued d'une bascule. Une navigation explicite invalide
ce départ et utilise seekTo ; elle ne stocke pas sa cible comme temps courant.
Lecture et buffering invalident ce repli ; les erreurs et destructions forcées
l'invalident aussi. Un seek explicite ne crée aucun verrou de confirmation.
YouTube est interrogé au clic dans les états ended, playing ou paused ; le temps
annoncé est utilisé même s'il diffère de la cible et sans nouvel événement.
Les départs seulement préparés, buffering, états inconnus, erreurs et masquage
en cours restent refusés. L'API ne fournit pas d'identifiant de seek ni de garantie
image par image ; un temps momentanément ancien après commande reste une limite
acceptée. Aucun seuil de proximité, délai de confirmation ni polling n'est ajouté.
Le libellé interne confirmed du transfert désigne une mesure admissible selon le
lecteur, pas un accusé de réception du dernier seek YouTube.
Local distingue le chargement initial, le seek demandé en pause et une position
réellement décodable ; la durée effective borne la préparation. Arrêt, erreur et
suppression effacent les préparations locales. Les callbacks d'instances détruites
restent ignorés. Aucun polling temporel ni stockage de progression.
getCurrentTimeMs reste indépendant de ce repli et refuse les préparations :
+ Temps et + Capture ne consomment jamais le curseur de transfert.
Le défilement conditionnel est partagé, sans focus forcé ni scroll des panneaux.
VideoNote, sa session et VideoTranscript restent hors de cette alternance.

Les tests navigateur ajoutent un WebM VP8/Opus généré par ffmpeg dans le workspace
temporaire du lanceur. L'acquisition distante est simulée, mais publication,
SQLite, GET/Range, ffprobe et décodage HTML5 sont réels. Les fixtures MKV factices
restent utilisées pour les seuls parcours de gestion des téléchargements.


### Panneau vidéo — interactions de la phase 1

useVideoDownload demeure l'unique propriétaire de la consultation et du polling.
Son suivi éphémère distingue une demande, une activité observée et son résultat
confirmé ; un timer de cinq secondes efface seulement le résultat de présentation.
Aucun champ métier, stockage navigateur ou contrat REST supplémentaire.
VideoDownload est la modale de conservation unique. Les suppressions mémorisent
l'identité exacte du fichier à confirmer ; elles réutilisent mutate et le déchargement.
PlayerInformation partage les données déjà chargées ; LocalFileDetails utilise
un identifiant accessible propre à chaque instance. Aucun appel HTTP à l'ouverture
du popover. Les commandes d'en-tête ne remountent ni notes ni transcription.

### Navigation explicite YouTube et blocage navigateur

La navigation commune aux notes, callouts, éditeur et transcription appelle seekTo
directement depuis le geste utilisateur. Elle conserve la pause depuis paused,
sinon demande la lecture. L'initialisation et les bascules conservent autoplay: 0
et cueVideoById ; Local est inchangé.

L'iframe délègue autoplay en plus des capacités existantes. Cette permission
n'est pas une commande de démarrage. onAutoplayBlocked affiche seulement un
message non fatal lorsqu'il est reçu ; l'événement playing l'efface. Les gardes
disposed/failed ignorent les événements obsolètes. Aucune détection par délai,
polling, relance, changement de mode ou coupure du son. L'API ne cite pas
explicitement seekTo parmi les appels couverts par ce signal ; son absence
n'est pas une preuve de démarrage. Les erreurs fatales restent distinctes.

### Présentation bord à bord du lecteur

La classe player-surface identifie les deux conteneurs déjà existants ; aucun
nouvel arbre React ni changement de cycle de vie. Le CSS étend seulement video
et youtube-frame de 2rem avec marges latérales négatives. Le padding inférieur
du panneau est retiré uniquement lorsqu'une surface non masquée contient le média.
Le panneau reste en overflow visible ; seule la youtube-frame découpe son iframe
aux coins inférieurs. video porte directement son arrondi. Le rayon intérieur
soustrait le pixel de bordure au rayon du panneau.
Les règles de ratio, hauteur et responsive sont conservées.

## Fiche vidéo — onglets locaux (tranche A)

App fournit un emplacement DOM stable dans l'en-tête ; VideoDetail y rend son h1 et VideoTags
par portail depuis son unique lecture REST. Le démontage de la fiche retire son
titre et ses tags, y compris lors d'une navigation avec requête précédente encore en cours.
Il n'existe ni état miroir du titre ni requête d'en-tête.

VideoDetail possède uniquement le choix Note/Informations et les boutons d'onglet.
VideoNote reste monté ; son panneau est masqué avec hidden, tandis que le dialogue
de départ et le signalement d'erreur restent hors de ce panneau. NoteSession garde
les écritures, conflits et protections de navigation. Informations conserve son défilement desktop ; dans Note, note-content est
le propriétaire commun du défilement des modes Édition et Lecture. Le mobile conserve le flux lecteur, note, transcription.

MarkdownEditor contrôle l'admissibilité d'une citation avant d'appeler la révélation
synchrone de Note. La transaction isolée et le focus s'appliquent ensuite à la même
vue visible. Une bascule ordinaire demande seulement une nouvelle mesure CodeMirror,
sans prendre le focus du bouton d'onglet. Les captures en cours gardent leur handle
et leur ancrage ; leur retour réseau ne révèle pas Note.

La hauteur desktop est allouée par deux lignes CSS au niveau de la page :
en-tête intrinsèque puis main avec minimum de 40rem (workspace 38rem + paddings).
La grille des trois zones reste unique ; aucune colonne React supplémentaire,
aucun observateur de hauteur ni hauteur d'en-tête codée en JavaScript.

### Présentation de la note et confirmations observables

VideoNote conserve son arborescence stable : note-controls contient la barre et
les messages, note-content contient l'éditeur masquable, la lecture et la résolution
du conflit. Le CSS affecte la hauteur et le défilement sans recréer EditorView.
cm-scroller reste en overflow visible ; l'ancêtre note-content porte le défilement
desktop. Le mobile conserve le flux de page avec commandes sticky. Le panneau
extérieur ne découpe pas les infobulles et peut agrandir la page en cas de nombreux
messages. Les tags sont désormais dans l'en-tête.

NoteSnapshot expose confirmationCount, compteur de session en mémoire incrémenté
uniquement par confirm : PUT réussi ou réconciliation d'une réponse perdue.
Le GET initial et l'adoption explicite de la version serveur ne l'incrémentent pas.
Aucun champ persistant ni contrat REST ne change.

NoteSaveButton observe les publications de la session pour la rétroaction de
cinq secondes. confirm publie avant la libération de running : le composant
attend la publication finale et l'absence de toute modification non confirmée.
Une confirmation partielle est consommée sans coche. Le compteur évite de déduire
un succès de la résolution de save(), qui peut aussi terminer sans écriture,
sur erreur ou conflit. Les règles, délais, réessais et protections de NoteSession
restent inchangés ; le temporisateur de présentation est nettoyé au démontage.

### Débordement des informations — contenant des textes accessibles

Le panneau video-information est positionné relativement pour contenir les
descendants absolus, notamment le libellé sr-only « nouvel onglet » des liens
externes. Sans ce contenant, ce texte invisible peut échapper à overflow auto
et augmenter le scrollHeight de la page. La correction conserve le défilement
interne, le libellé accessible et le défilement de page des fenêtres basses.


### Navigation globale et tags adaptatifs

App monte SiteNavigation indépendamment des données vidéo. Le volet utilise
dialog.showModal : fond inerte, boucle de focus locale, fermeture par Échap,
bouton ou clic sur le fond. Le verrou de défilement conserve la gouttière
réservée par scrollbar-gutter: stable, sans déplacement du workspace.
Les liens ferment synchroniquement le dialogue avant React Router, afin de ne
pas concurrencer le dialogue de protection de NoteSession. Un changement de
location ferme aussi le volet. ThemeSelector reste son unique instance et
conserve ses règles existantes. Aucun état de lecteur ou d'éditeur n'est déplacé.

Le portail stable appartient toujours à VideoDetail : pas de contexte métier
global, de copie de données ni de nouvelle requête de titre ou de tags.
VideoTags conserve sa modale, TagEditor et les relectures existantes à l'ouverture
de la gestion. VideoTagList ne reçoit que la liste chargée et un rappel de focus.

VideoTagList mesure les pilules et les compteurs dans des copies non interactives,
inert et aria-hidden, découpées dans un contenant positionné de hauteur nulle.
ResizeObserver suit le conteneur disponible et ces copies, indépendamment des
liens visibles. Le calcul teste les préfixes dans l'ordre REST avec la largeur
exacte du compteur correspondant, y compris aux transitions +9/+10/+100.
Il n'existe ni tri local ni nombre maximal fixe de tags. Les règles CSS gardent
min-width: 0 et une piste racine minmax(0, 1fr), empêchant les noms longs de
forcer la largeur de page.

Le popover natif auto reste non modal et ne contient que des liens de filtre.
Sa position est bornée au viewport, ses noms reviennent à la ligne et sa hauteur
permet un défilement interne. Un défilement extérieur le ferme ; son propre
défilement reste possible. Les changements de liste ou de préfixe visible
ferment une consultation périmée et restaurent au besoin un focus visible.
Les copies de mesure n'agrandissent jamais le document. Aucun appel réseau
n'accompagne une ouverture du popover ou un redimensionnement.
