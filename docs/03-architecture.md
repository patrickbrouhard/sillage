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
Il est utilisé depuis `playing` (1), `paused` (2) et `buffering` (3), ce dernier
prolongeant la lecture en cours de chargement. Depuis `unstarted` (-1), `ended` (0)
ou `video cued` (5), `cueVideoById({videoId, startSeconds})` prépare le départ sans
lecture. Un état inconnu refuse la commande. Aucun `playVideo()` n'est ajouté.
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
cued (5), buffering (3) et inconnus sont refusés ; un départ préparé par 6.1
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
