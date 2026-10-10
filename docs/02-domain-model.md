# Domain model

## 1. Principes

Le modèle métier est organisé autour de `Video`.

`Video` représente l'objet de connaissance interne à Sillage.

Une vidéo peut être accessible depuis plusieurs provenances. Ces provenances sont représentées par des `VideoSource`.

Les métadonnées issues d'une plateforme, les transcriptions, les fichiers locaux, les notes, les annotations et les autres éléments sont associés à ces objets sans définir l'identité de `Video`.

Schéma conceptuel cible (il inclut aussi des objets futurs) :

```text
                               ┌──────────────────┐
                               │      VIDEO       │
                               │──────────────────│
                               │ id               │
                               │ title_override?  │
                               │ created_at       │
                               │ updated_at?      │
                               └────────┬─────────┘
                                        │
          ┌─────────────────────────────┼──────────────────────────────┐
          │                             │                              │
          │ 1:N                         │ 1:N                          │ 1 → 0..1
          ▼                             ▼                              ▼
┌────────────────────┐        ┌──────────────────┐          ┌──────────────────┐
│    VIDEO_SOURCE    │        │    MEDIA_FILE    │          │       NOTE       │
│────────────────────│        │──────────────────│          │──────────────────│
│ id                 │        │ id               │          │ video_id PK/FK   │
│ video_id           │        │ video_id         │          │ content_md       │
│ provider           │        │ path             │          │ created_at       │
│ external_id?       │        │ format           │          │ updated_at       │
│ canonical_url?     │        │ size             │          └──────────────────┘
│ title              │        │ added_at         │
│ description?       │        └──────────────────┘
│ publisher_id?      │
│ duration_ms?       │
│ thumbnail_url?     │
│ published_at?      │
│ ...                │
└─────────┬──────────┘
          │
          │ 1:N
          ▼
┌────────────────────┐
│     TRANSCRIPT     │
│────────────────────│
│ id                 │
│ video_source_id    │
│ language           │
│ provenance         │
│ local_path?        │
│ last_fetched_at    │
└────────────────────┘


            ┌──────────────────┐        ┌──────────────────┐
            │    ANNOTATION    │        │      ASSET       │
            │──────────────────│        │──────────────────│
            │ id               │        │ id               │
            │ video_id         │        │ video_id         │
            │ timestamp_ms     │        │ type             │
            │ content_md       │        │ path             │
            │ created_at       │        │ timestamp_ms?    │
            │ updated_at       │        │ created_at       │
            └──────────────────┘        └──────────────────┘


          ┌───────────────┐                          ┌───────────────┐
          │     VIDEO     │ N                      N │      TAG      │
          │               ├─────── VIDEO_TAG ────────┤               │
          └───────────────┘                          └───────────────┘
```

Ce schéma reste volontairement simple et inclut des concepts futurs.
Les objets `Note` et `Tag` de l'étape 4 sont implémentés et persistés.
L'étape 4 bis implémente `Publisher`, `Person`, les associations vidéo–personne
et les tags des publishers et personnes. `MediaFile`, `Annotation`, `Asset`,
`title_override` et les artefacts IA restent futurs.

Relations complémentaires implémentées :

```text
VideoSource → Publisher : zéro ou un publisher par source
Publisher → VideoSource : zéro à plusieurs sources par publisher
Publisher → Person      : zéro ou une personne de référence
Person → Publisher      : zéro à plusieurs publishers
Video ↔ Person          : N:N via VIDEO_PERSON, sans rôle
Publisher ↔ Tag         : N:N via PUBLISHER_TAG
Person ↔ Tag            : N:N via PERSON_TAG
```

Les concepts doivent être ajoutés ou enrichis uniquement lorsqu'un besoin réel apparaît.

## 2. `Video`

### 2.1 Responsabilité

`Video` est l'agrégat conceptuel principal.

Il ne signifie pas « vidéo YouTube ».

Il signifie :

> cette vidéo telle qu'elle existe dans la base de connaissances de l'utilisateur.

Elle peut avoir :

- une ou plusieurs sources ;
- zéro ou plusieurs fichiers locaux ;
- zéro ou une note principale pour l'étape 4 ;
- des annotations ;
- des tags ;
- zéro à plusieurs personnes explicitement associées au contenu ;
- des assets ;
- des transcriptions accessibles par ses sources ;
- plus tard, des artefacts IA.

### 2.2 Identité

`Video` possède son propre identifiant interne Sillage.

Décision actuelle :

```text
Video.id = entier 64 bits généré par SQLite
```

La persistance utilise :

```sql
INTEGER PRIMARY KEY AUTOINCREMENT
```

Cet identifiant :

- n'est pas l'identifiant YouTube ;
- n'est pas dérivé d'une URL ;
- reste stable indépendamment des sources associées ;
- n'est pas réutilisé par SQLite après suppression.

Le domaine peut représenter cette identité par un type dédié tel que :

```go
type VideoID int64
```

### 2.3 Métadonnées et titre affiché

Les métadonnées de la vidéo provenant d'une plateforme appartiennent à
`VideoSource`. Les informations du compte de publication appartiennent à
`Publisher`.

Ainsi, le titre récupéré auprès de YouTube n'est pas le titre propre de `Video` : il s'agit du titre observé auprès de cette source.

Un champ tel que :

```text
title_override
```

peut permettre à l'utilisateur de définir son propre titre pour la vidéo sans modifier le titre provenant de la source.

Le comportement visé est conceptuellement :

```text
title_override présent
        ↓
titre affiché = title_override

sinon
        ↓
titre affiché = titre de la source utilisée pour l'affichage
```

Dans le MVP, où une vidéo possède généralement une seule source YouTube, ce choix est trivial.

La politique métier de sélection du titre par défaut lorsqu'une `Video`
possède plusieurs sources reste ouverte. En 5.1, la première source retournée
par REST est utilisée provisoirement pour présenter une carte ; cette convention
ne crée pas de source principale persistée.

La sémantique exacte d'un éventuel `updated_at` reste également à préciser : un rafraîchissement de source, l'ajout d'une transcription ou une modification utilisateur ne doivent pas être assimilés implicitement.

## 3. `VideoSource`

### 3.1 Responsabilité

`VideoSource` représente une **provenance** de la vidéo ainsi que les métadonnées observées ou fournies par cette provenance.

Une source n'est pas nécessairement une plateforme en ligne.

Exemple initial :

```text
provider      = youtube
external_id   = <youtube-video-id>
canonical_url = https://www.youtube.com/watch?v=...
```

Plus tard, d'autres valeurs de `provider` pourront être ajoutées, par exemple :

```text
vimeo
local
...
```

Seul YouTube est pris en charge dans l'implémentation actuelle.

### 3.2 Identité interne

`VideoSource` possède son propre identifiant interne Sillage :

```text
VideoSource.id = entier 64 bits généré par SQLite
```

La persistance utilise :

```sql
INTEGER PRIMARY KEY AUTOINCREMENT
```

`video_id` est la clé étrangère qui rattache la source à l'objet `Video`.

Il ne faut pas confondre :

```text
video_id
```

qui désigne une `Video` interne à Sillage, avec :

```text
external_id
```

qui désigne éventuellement la vidéo dans l'espace de noms du `provider`.

### 3.3 `provider`

`provider` identifie le système ou la catégorie de provenance de la source.

Il sert notamment à interpréter les informations qui lui sont spécifiques.

Exemple :

```text
provider    = youtube
external_id = IgKU8xCgbjc
```

L'identifiant externe n'a pas de signification suffisante sans le contexte du provider.

`provider` joue également le rôle de discriminant permettant à l'application de choisir le comportement ou l'adapter approprié.

Le nom `provider` est conservé.

### 3.4 `external_id`

`external_id` est l'identifiant de la vidéo dans l'espace de noms défini par le `provider`.

Au niveau du modèle générique, `external_id` est facultatif : toutes les futures provenances ne fourniront pas nécessairement un identifiant externe stable.

Lorsqu'il est présent, l'identité externe d'une source est le couple :

```text
(provider, external_id)
```

La persistance impose donc l'unicité de ce couple uniquement lorsque `external_id` n'est pas `NULL`.

Pour YouTube, `external_id` est obligatoire au niveau applicatif.

### 3.5 `canonical_url`

`canonical_url` est un localisateur canonique permettant d'accéder à la source lorsqu'une telle URL existe.

Il ne définit pas l'identité de `VideoSource`.

Pour YouTube, l'adapter normalise les différentes formes d'URL et fournit une URL canonique telle que :

```text
https://www.youtube.com/watch?v=IgKU8xCgbjc
```

Même lorsqu'une URL pourrait être reconstruite à partir du `provider` et de `external_id`, la conserver reste utile :

- elle évite de disperser la logique de reconstruction ;
- elle fournit directement un localisateur utilisable ;
- toutes les futures sources ne suivront pas nécessairement les mêmes conventions.

Au niveau générique, `canonical_url` est facultatif.

Pour YouTube, il est obligatoire au niveau applicatif.

### 3.6 Métadonnées

`VideoSource` contient les métadonnées provenant de cette source et dont l'application a réellement besoin.

Champs actuels :

- titre ;
- description ;
- référence facultative au publisher ;
- durée ;
- miniature ;
- URL canonique ;
- identifiant externe ;
- langue audio originale facultative (`original_audio_language`).

Des champs supplémentaires pourront être ajoutés à partir de besoins réels, par exemple une date de publication.

Ces métadonnées restent génériques : un fichier local peut lui aussi fournir
un titre ou une durée via ses tags, son nom ou une analyse du média.

Les propriétés techniques d'un fichier concret — chemin, taille, conteneur, codecs, résolution, etc. — appartiennent en revanche à `MediaFile`.

L'ancien champ `creator` contenait `channel`, avec repli sur `uploader`, sans
garantir une attribution d'auteur. L'étape 4 bis le supprime et le remplace par
`publisher_id`, facultatif. Aucun nom de secours n'est stocké dans la source.
Le REST restitue un objet minimal `publisher: {id, name}`, ou `null` ; il s'agit
d'une projection du compte partagé, pas d'une duplication en persistance.

### 3.7 Pas de `raw_metadata` par défaut

Le modèle ne prévoit pas de conserver systématiquement le JSON brut complet des métadonnées renvoyées par `yt-dlp`.

Décision actuelle :

- identifier explicitement les métadonnées utiles ;
- les normaliser ;
- réinterroger la source si le modèle évolue.

Un cache ou une trace brute pourra être ajouté plus tard si un besoin concret de debug, d'audit ou de résilience apparaît.

Cette décision concerne les métadonnées générales de `VideoSource`.

Elle n'interdit pas de conserver ponctuellement un fichier source tel qu'un JSON3 de transcription lorsque celui-ci constitue lui-même le contenu acquis.

### 3.8 Multiples sources

La relation conceptuelle est :

```text
Video 1:N VideoSource
```

Dans le MVP, une vidéo aura probablement une seule source YouTube.

La relation 1:N permet toutefois de représenter plusieurs provenances de la même vidéo sans faire dépendre l'identité de `Video` d'une plateforme particulière.

Deux sources représentant le même contenu conceptuel ne sont pas nécessairement parfaitement synchronisées.

Exemple :

```text
Source A
00:00 début du contenu

Source B
00:00 intro ou logo
00:10 début du même contenu
```

Les deux sources peuvent appartenir à la même `Video`, tout en possédant des timelines différentes.

Cette propriété est importante pour les données temporelles telles que les transcriptions.

La détection automatique qu'une source d'une autre plateforme correspond à une `Video` déjà existante reste une question ouverte.

### 3.9 Source locale

Une source locale est une possibilité prévue, mais son identité exacte n'est pas encore définie.

Exemple conceptuel :

```text
provider      = local
external_id   = NULL
canonical_url = NULL
```

Il ne faut pas décider prématurément si une future identité locale doit être fondée sur :

- un chemin ;
- un hash ;
- un identifiant généré ;
- une autre propriété.

Cette question sera traitée lors de l'implémentation réelle de l'import de fichiers locaux.

Aucun héritage ou sous-type SQL `OnlineVideoSource` / `LocalVideoSource` n'est introduit à ce stade.

### 3.10 `Publisher` — compte de publication

Décision validée et implémentée à l'étape 4 bis : un publisher représente un
compte ou une entité de publication sur une plateforme, indépendamment des
vidéos. Ce n'est pas nécessairement un auteur, une personne physique ou un
propriétaire juridique.

```text
PUBLISHER
  id
  provider
  external_id
  name?
  person_id?
```

- `id` est une identité interne Sillage.
- `(provider, external_id)` identifie le compte externe ; le nom ne sert jamais
  à identifier ou fusionner les comptes.
- `name` est facultatif et affichable. Il n'est pas un historique du nom observé
  à chaque import. Une future actualisation affectera toutes les sources liées.
- Un publisher peut exister sans vidéo et sans personne de référence.
- Une personne peut être la référence de plusieurs publishers. Cette association
  n'exprime pas de propriété juridique.
- Une source ne peut référencer qu'un publisher du même provider.

Pour YouTube, `external_id` est obligatoirement un `channel_id` fiable, jamais
un handle ni un nom. L'adapter utilise le nom `channel`, puis `uploader` si
nécessaire, uniquement comme libellé d'un compte déjà identifié.

Une création manuelle résout une URL de chaîne via yt-dlp, par exemple
`https://www.youtube.com/@LexClips`. Si l'identité ne peut pas être obtenue,
l'opération échoue sans création. L'absence du nom n'empêche pas la création.

À l'import vidéo, sans identifiant de compte fiable, aucun publisher n'est créé
et la source reste sans référence. Cela n'invalide pas à soi seul l'import.
L'utilisateur peut ensuite associer, remplacer ou retirer explicitement un
publisher identifié. Aucun rapprochement par nom ni champ `publisher_name`
de secours n'est introduit.

La réutilisation d'un publisher ne rafraîchit ni son nom ni ses associations,
même lorsque son nom est absent. Aucun cas d'usage de rafraîchissement n'est
inclus dans cette tranche. Le réajout d'une vidéo ne répare pas implicitement
ses associations. Les règles des autres providers restent à définir lors de
leur prise en charge ; seul YouTube peut actuellement être résolu.

Le publisher YouTube est le compte principal de publication. Une collaboration
ne crée pas plusieurs `VideoSource`. Les noms de chaînes créditées ne deviennent
automatiquement ni des publishers ni des personnes. Leur modélisation est différée.

### 3.11 `Person` et associations au contenu

```text
PERSON
  id
  name

VIDEO_PERSON
  video_id
  person_id
```

Une personne représente une personne physique identifiable, indépendante des
plateformes. Son nom est obligatoire après suppression des espaces aux extrémités,
mais non unique. Les homonymes restent distincts et aucune fusion n'est automatique.
Une personne peut exister sans publisher ni vidéo. Son nom peut être corrigé.

`VideoPerson` exprime uniquement une association explicite au contenu, sans rôle.
Le couple `(video_id, person_id)` est unique. Aucun `primary_person_id`, `Creator`,
`Author`, `Contributor` ou `Organisation` distinct n'est introduit.

Les chemins suivants sont différents et ne se propagent pas :

- direct : `Video → VideoPerson → Person` ;
- indirect : `Video → VideoSource → Publisher → Person`.

Lex Fridman peut être la référence des publishers Lex Fridman et Lex Clips.
La navigation depuis sa fiche retrouve alors les vidéos de ces comptes sans
créer de liens directs. ThePrimeagen peut être associé directement à une interview
publiée sur une autre chaîne, en plus de sa relation avec son propre publisher.
L'union des deux chemins déduplique les vidéos par leur identité Sillage.

L'association d'une personne à un publisher ou une vidéo est modifiable et
retirable. Aucun import ne crée automatiquement de personne. La suppression des
entités Person et Publisher est hors périmètre de cette tranche.

## 4. `Transcript`

### 4.1 Identité et responsabilité

`Transcript` représente une transcription effectivement acquise et exploitable.
Il appartient à une `VideoSource`, dont il partage la timeline :
`VideoSource 1:N Transcript`. Il ne référence pas directement `Video`.
La découverte distante seule ne crée aucune ligne.

Deux sources d'une même vidéo peuvent être décalées dans le temps. Cette
relation ne prétend pas synchroniser leurs timelines et ne crée aucune
abstraction générique de timeline.

### 4.2 Attributs persistants

```text
id
video_source_id
language
provenance
local_path?
last_fetched_at
```

L'identité initiale est `UNIQUE(video_source_id, language, provenance)`.
Une réacquisition actualise le même ID, sans historique métier.
Les champs d'identité sont obligatoires ; `local_path` reste nullable
(chaîne Go vide pour l'absence).

`language` désigne la langue du contenu : `en`, `fr`, `pt-BR`.
Le suffixe yt-dlp `-orig` ne fait pas partie de la langue métier.
Aucun `provider_track_id` n'est persisté.

`provenance` décrit la production de la transcription. La seule valeur
implémentée est `youtube_auto`. Les valeurs futures telles que
`youtube_manual` ou `local_stt` ne sont pas des fonctionnalités présentes.

`last_fetched_at` date la dernière acquisition réussie publiée en base.
Le service fournit un `time.Time` UTC tronqué à la milliseconde ; SQLite
le stocke au format fixe `YYYY-MM-DDTHH:MM:SS.mmmZ`.

### 4.3 Langue originale et sélection

`VideoSource.original_audio_language` décrit facultativement la langue de
l'audio original. Elle reste absente lorsque les signaux ne permettent pas
de la déterminer et n'est pas exposée par le DTO vidéo actuel.

L'adapter utilise un signal audio original explicite de yt-dlp ; une piste
audio par défaut, le titre ou la description ne suffisent pas. À défaut,
une unique clé de captions `*-orig` peut fournir cette information.

Une langue connue cible la clé originale correspondante ; sinon une unique
clé originale admissible en JSON3 est requise. Les différents formats d'une
clé ne sont pas des candidats distincts. Les contradictions fiables provoquent
un refus de sélection, sans écraser silencieusement la langue connue.
Aucun fallback vers une autre langue, des sous-titres manuels ou du STT.

Lors d'une acquisition réussie, la langue encore inconnue de la source peut
être renseignée atomiquement avec la transcription. Cela ne rafraîchit pas
ses autres métadonnées.

### 4.4 Acquisition et snapshot

Une acquisition réussie comprend récupération, parsing, validation du contenu,
publication du fichier et persistance. Un échec préserve le dernier chemin,
le contenu et la date d'acquisition.

Pour cette tranche, chaque acquisition conserve le JSON3 source localement.
Le chemin est relatif à la racine de snapshots. Un nouveau fichier est publié
avant de changer la référence SQL ; les fichiers précédents ne sont pas
immédiatement supprimés, pour préserver les GET concurrents.
Une interruption peut laisser un fichier non référencé. La rétention durable
et le nettoyage restent ouverts.

La nullabilité de `local_path` sépare l'identité du contenu local. Cependant,
une ligne sans snapshot lisible est une anomalie locale dans le workflow
actuel : le GET ne refait jamais d'acquisition distante.

Les URLs directes de captions ne sont pas persistées ; le prochain POST
redécouvre une URL fraîche. Le dump général yt-dlp n'est pas archivé.
Aucun format JSON propriétaire n'est introduit.

### 4.5 Contenu en mémoire

```go
type TranscriptItem struct {
    StartMS int64
    Text    string
}

type TranscriptContent []TranscriptItem
```

Les items sont des fragments ordonnés, pas nécessairement des mots. Ils n'ont
ni identité propre, ni `end_ms`, ni locuteur. Ils ne sont pas persistés
individuellement dans SQLite.

Le parser calcule notamment `event.tStartMs + seg.tOffsetMs`, avec offset
absent égal à zéro. Il refuse les temps textuels invalides et les débordements,
ignore les événements sans texte, préserve les blancs et l'ordre source,
et matérialise les séparations entre blocs autonomes dans les items.
Un document sans texte exploitable est rejeté.

`TranscriptContent.PlainText()` concatène les items puis normalise les blancs.
Ce texte n'est pas persisté séparément. Une correction utilisateur ou IA future
devra rester une donnée dérivée distincte, sans écraser la source.

### 4.6 Vue singulière

Le GET choisit, parmi les acquisitions `youtube_auto` de la source,
`last_fetched_at DESC, id DESC`. La relation reste 1:N sans interface
multi-transcriptions ni sélection manuelle dans cette tranche.

## 5. `Note`

### 5.1 Responsabilité

`Note` est le document Markdown de travail associé à une vidéo.

Décision actée et implémentée pour l'étape 4 : `Video 1 → 0..1 Note`.
La note appartient directement à `Video`, jamais à une `VideoSource`.

| Champ | Rôle |
| --- | --- |
| `video_id` | Clé primaire et référence vers `Video` ; aucun identifiant propre |
| `content_md` | Contenu Markdown brut, stocké en `TEXT` dans SQLite |
| `created_at` | Date de création de la note |
| `updated_at` | Date de dernière modification effective |

Aucune note n'est créée automatiquement à l'ajout d'une vidéo. Le premier
enregistrement la crée ; les suivants remplacent son contenu. Une chaîne vide
est acceptée, y compris à la création : note absente et note vide sont distinctes.

Le Markdown est restitué à l'identique : indentation, espaces, retours à la ligne,
lignes vides et syntaxes particulières sont préservés. Aucun parsing, rendu HTML,
reformatage ni interprétation des timestamps n'intervient dans la persistance.
Cette représentation laisse possibles de futures syntaxes internes et leur export.

À la création, `created_at` et `updated_at` sont identiques. `created_at` reste
stable ensuite et un contenu strictement inchangé ne modifie pas `updated_at`.
Un changement d'espace ou de retour à la ligne est une modification effective.
Les dates suivent la convention UTC à précision milliseconde.

La dernière écriture gagnante est retenue provisoirement pour l'étape 4, sans
historique ni gestion des conflits. La protection contre les écrasements concurrents est requise en 5.2.
Le mécanisme de version et la politique d'autosauvegarde restent ouverts ;
ils ne sont pas implémentés en 5.1.
Plusieurs notes, l'ajout partiel et la suppression explicite sont hors de cette
tranche ; la suppression reste une évolution UX envisagée.

### 5.2 Références temporelles — orientation pour l'étape 6

Les références restent du texte opaque pour la persistance. Le Markdown brut
peut accueillir des extensions propres à Sillage, sans compatibilité
fonctionnelle obligatoire avec les applications Markdown externes.

Une référence a un début obligatoire et une fin facultative. Insertion rapide
et citation enrichie peuvent partager cette notion sans nécessiter chacune une
entité `Annotation`. La provenance temporelle doit être conservée lorsque
nécessaire : les timelines de plusieurs sources ne sont pas interchangeables.

Une syntaxe de liens Markdown contenant des URI `sillage://` est fortement
privilégiée. Son format exact, l'identification de la provenance et la relation
avec les annotations restent à expérimenter avant validation. Aucun schéma ni
parseur n'est introduit en 5.1.

La copie ordinaire doit préserver les informations utiles. Copie adaptée et
export pourront convertir les références. Un export Markdown de consultation
est distinct d'une sauvegarde réimportable de l'ensemble des données métier.

## 6. `Annotation`

### 6.1 Responsabilité

`Annotation` est une référence temporelle structurée et forte.

Ancienne esquisse conceptuelle, non implémentée et à réexaminer avec les plages et leur provenance :

```text
id
video_id
timestamp_ms
content_md
```

Elle peut plus tard recevoir d'autres propriétés.

### 6.2 Pourquoi garder `Note` et `Annotation`

Les deux concepts servent des besoins différents.

`Note` :

- document libre ;
- prise de notes rapide ;
- organisation personnelle ;
- références temporelles informelles.

`Annotation` :

- identité propre ;
- timestamp canonique ;
- requêtes structurées ;
- marqueur de timeline ;
- usage MCP ;
- future catégorisation ou liens.

### 6.3 Relation encore ouverte

La synchronisation éventuelle entre :

```markdown
[12:42]
```

dans la note et une `Annotation` structurée n'est pas encore décidée.

Options à tester :

- indépendance totale ;
- transformation explicite d'une référence faible en annotation ;
- représentation d'une annotation dans le Markdown ;
- parsing automatique de certaines syntaxes.

Ne pas figer ce comportement avant de tester l'UX.

### 6.4 Plusieurs timelines de source

`Annotation` reste pour l'instant rattachée directement à `Video`.

Cependant, plusieurs `VideoSource` d'une même vidéo peuvent théoriquement avoir des timelines différentes.

Si ce scénario devient réellement supporté dans l'UX, il faudra déterminer si une annotation temporelle doit également référencer :

- une `VideoSource` ;
- un `MediaFile` ;
- une timeline de référence ;
- ou une autre abstraction.

Cette question est volontairement laissée ouverte.

## 7. `Asset`

`Asset` représente un fichier complémentaire produit ou importé autour d'une vidéo.

Exemple principal :

```text
type = screenshot
```

Attributs conceptuels :

```text
id
video_id
type
path
timestamp_ms?
created_at
```

Tous les assets n'ont pas nécessairement un timestamp.

### 7.1 Screenshots

Pour un screenshot :

```text
timestamp_ms = 1123456
```

est la donnée temporelle canonique.

Le nom du fichier peut aussi encoder ce timestamp :

```text
00h18m43s456.jpg
```

mais l'application ne doit pas avoir à parser le nom du fichier pour retrouver sa position temporelle.

Comme pour les annotations, la relation entre un timestamp d'asset et plusieurs sources éventuellement désynchronisées pourra être précisée lorsque ce scénario deviendra concret.

## 8. `MediaFile`

### 8.1 Responsabilité

`MediaFile` représente une **représentation physique locale** de la vidéo ou éventuellement d'une piste média associée.

Il répond à une question différente de `VideoSource` :

```text
VideoSource = d'où vient cette vidéo ?
MediaFile   = quels octets de cette vidéo sont disponibles localement ?
```

Attributs conceptuels :

```text
id
video_id
path
format
size
added_at
```

Le fichier local n'est pas une nouvelle `Video`.

Exemple :

```text
Video #42
├── VideoSource: YouTube
└── MediaFile: /data/media/42/video.webm
```

Une même vidéo peut théoriquement avoir plusieurs fichiers locaux :

- formats différents ;
- audio seul ;
- version basse résolution ;
- fichier temporaire.

La politique exacte de rétention reste à définir.

### 8.2 Source locale et fichier local

Pour une vidéo importée à partir d'un fichier déjà présent localement, le même objet physique peut jouer deux rôles conceptuels distincts :

```text
Video
├── VideoSource
│   provider = local
└── MediaFile
    path = /data/media/sqlite-tutorial.mp4
```

La `VideoSource` décrit la provenance connue par Sillage.

Le `MediaFile` décrit le fichier concret et ses caractéristiques techniques.

Il n'est donc pas nécessaire de fusionner les deux entités ni d'introduire des sous-types de `VideoSource`.

### 8.3 Provenance d'un `MediaFile`

Il pourra devenir utile de savoir de quelle `VideoSource` provient un fichier téléchargé ou importé.

Une future relation facultative telle que :

```text
MediaFile.origin_source_id -> VideoSource.id
```

est envisageable.

Elle n'est pas actée ni nécessaire au schéma actuel et sera décidée lorsque `MediaFile` sera réellement implémenté.

## 9. `Tag`

Les tags forment un catalogue unique partagé entre vidéos, publishers et personnes.
Les associations vidéo sont implémentées depuis l'étape 4 ; les associations aux
publishers et personnes le sont depuis l'étape 4 bis.

Relation :

```text
Video N:N Tag
Publisher N:N Tag
Person N:N Tag
```

via une table associative :

```text
VIDEO_TAG
PUBLISHER_TAG
PERSON_TAG
```

Le modèle suivant est acté et implémenté pour l'étape 4 :

| Champ | Rôle |
| --- | --- |
| `id` | Identifiant entier stable, généré par SQLite |
| `name` | Nom d'affichage |

### 9.1 Identité

- Supprimer les espaces en début et fin de nom ; un nom vide est invalide.
- Établir l'identité avec une normalisation canonique Unicode NFC et une
  comparaison Unicode insensible à la casse.
- Conserver les accents significatifs et la casse d'affichage lors de la création.
- Réutiliser un tag équivalent sans modifier son nom d'affichage.
- Ne pas appliquer NFKC, supprimer les accents ou rapprocher synonymes et concepts.

Exemples contractuels :

| Saisies | Identité attendue |
| --- | --- |
| `DevOps` / `devops` | Même tag |
| `École` / `école` | Même tag |
| `Café` avec `é` précomposé / `Café` avec accent combinant | Même tag |
| `Café` / `Cafe` | Tags distincts |
| `Go` / `Golang` | Tags distincts |

La persistance garantit l'unicité des identités de tags et des paires d'identifiants
de chaque association, y compris lors d'écritures concurrentes. Les tables
associatives explicites ont de vraies clés étrangères ; aucune table polymorphe
`tag_assignments(target_type, target_id)` n'est introduite. La stratégie technique de
comparaison et d'unicité SQL est décrite dans `04-tech-stack-and-decisions.md`,
section 5.6.

### 9.2 Associations et cycle de vie

L'ajout par noms retrouve ou crée les tags, puis les associe à l'entité ciblée sans
doublons et sans retirer les associations préexistantes. Un ajout multiple est
atomique, créations de tags et associations comprises : un échec ne laisse
aucun tag nouvellement créé ni association partielle par cette opération.

Le retrait supprime seulement l'association. Le tag reste dans le catalogue,
même sans aucune entité associée. Aucun quota métier arbitraire de tags par entité
n'est introduit.

Les tags ne se propagent pas entre entités liées. Taguer une personne ne tague
ni ses publishers ni les vidéos associées. Le filtre REST vidéo `tag_id` continue
de sélectionner exclusivement les associations directes `VideoTag`. Une recherche
exploitant les autres chemins reste une évolution distincte.

Le remplacement complet des associations, le renommage, la suppression globale,
les hiérarchies, alias, couleurs et catégories sont hors du périmètre de l'étape 4.

## 10. Extension future : `AIArtifact`

Les résultats IA ne font pas partie du noyau MVP, mais peuvent être modélisés plus tard comme des artefacts associés à une vidéo ou à une autre donnée métier lorsque le besoin devient concret.

Exemple conceptuel :

```text
VIDEO
  │
  │ 1:N
  ▼
┌────────────────────┐
│    AI_ARTIFACT     │
│────────────────────│
│ id                 │
│ video_id           │
│ type               │
│ content            │
│ provider?          │
│ model?             │
│ created_at         │
└────────────────────┘
```

Types possibles :

```text
summary
chapters
key_points
tag_suggestions
```

Une transcription corrigée ou restructurée par IA pourrait également devenir une donnée dérivée distincte si ce besoin apparaît.

Aucun modèle précis n'est acté pour cela.

Une production IA ne doit pas remplacer silencieusement une donnée source.

## 11. Invariants actuels

### 11.1 `Video` n'est pas sa source

Une vidéo conserve la même identité lorsqu'une source supplémentaire est ajoutée.

`Video` représente l'objet de connaissance.

`VideoSource` représente une provenance concrète.

### 11.2 Les timelines appartiennent aux représentations concrètes

Deux `VideoSource` représentant le même contenu peuvent avoir des timelines différentes.

Une donnée temporelle provenant directement d'une source ne doit donc pas être supposée automatiquement synchronisée avec toutes les autres sources de la même `Video`.

C'est notamment la raison pour laquelle :

```text
VideoSource 1:N Transcript
```

est préféré à :

```text
Video 1:N Transcript
```

### 11.3 `VideoSource` n'est pas `MediaFile`

`VideoSource` décrit une provenance et ses métadonnées.

`MediaFile` décrit une représentation physique locale.

Télécharger une source distante crée un `MediaFile`, pas une nouvelle `VideoSource` ni une nouvelle `Video`.

### 11.4 Positions temporelles et dates calendaires

Sillage distingue deux catégories de données temporelles.

Les positions ou durées à l'intérieur d'un média sont représentées en millisecondes entières :

```text
start_ms
timestamp_ms
duration_ms
```

En Go, elles utilisent typiquement un `int64`.

En SQLite :

```text
INTEGER
```

Les dates et heures correspondant à des événements du système ou du domaine sont représentées comme des dates UTC :

```text
created_at
updated_at
last_fetched_at
added_at
```

En Go, elles utilisent `time.Time`.

En SQLite, elles sont stockées sous forme de texte UTC au format RFC 3339 à précision milliseconde fixe :

```text
2026-10-06T18:00:00.000Z
```

Les suffixes `_ms` sont donc réservés aux positions ou durées exprimées en millisecondes dans un média, et ne sont pas utilisés pour les dates calendaires.

### 11.5 Le format source n'est pas le modèle métier

Pour une transcription YouTube :

```text
json3
  ↓
parser
  ↓
TranscriptContent
  ↓
[]TranscriptItem
```

Un fichier JSON3 brut peut être conservé comme snapshot de la source sans devenir pour autant le modèle métier de Sillage.

De même :

```text
yt-dlp metadata JSON
        ↓
adapter
        ↓
champs VideoSource normalisés
```

### 11.6 Les représentations dérivables ne doivent pas être dupliquées sans besoin

Le texte brut d'une transcription peut être reconstruit à partir de son contenu temporel.

Il n'est donc pas persisté séparément par défaut.

Une duplication peut être introduite plus tard pour des raisons mesurées de performance ou d'indexation, mais elle doit alors être explicitement considérée comme une représentation dérivée.

### 11.7 Les données utilisateur ou dérivées doivent être séparées des données source

Le rafraîchissement d'une source ne doit pas écraser :

- notes ;
- annotations ;
- tags ;
- titre personnalisé ;
- assets ;
- autres données créées par l'utilisateur.

Cela inclut les personnes, leurs associations aux vidéos et publishers, les
rattachements explicites source–publisher et les tags de chaque type d'entité.

De la même manière, une correction ou réécriture produite par une IA ne doit pas modifier silencieusement la transcription source.

### 11.8 Disponibilité locale et identité sont distinctes

La présence d'un fichier local ne définit pas l'identité d'une `Video`, d'une `VideoSource` ou d'un `Transcript`.

Pour un `Transcript` :

```text
local_path != NULL
```

signifie qu'une représentation locale du contenu est disponible.

```text
local_path = NULL
```

ne signifie pas que le `Transcript` cesse d'exister.

### 11.9 Identités de publication et associations

L'identité externe d'une vidéo et celle d'un compte occupent des espaces distincts,
même si toutes deux utilisent `(provider, external_id)`. Une chaîne n'est pas une
personne. Les relations directes et indirectes ne se matérialisent pas mutuellement.
La création automatique du publisher participe à la transaction vidéo/source :
un échec ne laisse pas de création partielle par cet import.

## 12. Concepts volontairement différés

Ne pas ajouter prématurément au modèle :

- `Job` persistant ;
- historique complet ;
- audit log ;
- collections/playlists ;
- embeddings ;
- vector store ;
- permissions multi-utilisateur ;
- graphe de relations complexe ;
- provenance IA détaillée ;
- taxonomie de tags avancée ;
- hiérarchie de sous-types `VideoSource` online/offline ;
- format canonique propriétaire de transcription ;
- diarisation ou identité de locuteurs ;
- chapitres comme entité persistante dédiée ;
- modèle générique de timeline ;
- synchronisation automatique entre timelines de différentes sources.
- rôles des personnes et personne principale d'une vidéo ;
- organisations, hiérarchies et relations de propriété complexes ;
- modélisation des chaînes collaboratrices YouTube ;
- propagation automatique des tags ou des personnes ;
- suppression des personnes et publishers et rafraîchissement de leurs métadonnées.

Ces concepts pourront être introduits lorsqu'un besoin réel apparaîtra.
