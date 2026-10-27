# Domain model — Sillage

Ce document définit **les concepts métier et les invariants actuellement applicables** dans Sillage. Il distingue les objets persistés des extensions simplement envisagées. Il ne retrace pas les étapes de développement et ne constitue pas une spécification des écrans, des endpoints ou des adapters.

Documents complémentaires : [Product & UX](01-product-and-ux.md), [Architecture](03-architecture.md), [Tech stack & decisions](04-tech-stack-and-decisions.md), [Roadmap](05-roadmap.md) et [Open questions](06-open-questions.md).

**Convention :** sauf mention **futur / non implémenté**, les règles décrivent le modèle en vigueur. Les noms précis des colonnes, contraintes et migrations restent vérifiables dans les migrations SQL ; les types Go et les services constituent la référence pour les API internes.

## 1. Principes et relations

`Video` est l'objet de connaissance central, indépendant de la plateforme ou du fichier par lequel on y accède. Les métadonnées de provenance appartiennent à `VideoSource` ; le contenu utilisateur et les représentations conservées sont rattachés à l'identité Sillage appropriée.

### 1.1 Vue du modèle implémenté

```text
Video (id, created_at)
├── VideoSource [1:N] (id, video_id, provider, external_id?, ...)
│   ├── Publisher [0..1] (compte de publication de la même plateforme)
│   └── Transcript [0:N] (source + langue + provenance)
├── MediaFile [0:N] (représentation physique locale)
│   └── origin_source_id? → VideoSource (obligatoire pour un téléchargement YouTube)
├── Note [0..1] (video_id PK/FK, content_md, revision, dates)
├── Asset [0:N] (captures PNG ; source_id et timestamp_ms pour screenshot)
├── Person [N:N] (associations directes, sans rôle)
└── Tag [N:N] (associations directes)

Publisher (id, provider, external_id, name?, person_id?)
├── VideoSource [0:N]
├── Person [0..1] (personne de référence, association facultative)
└── Tag [N:N]

Person (id, name)
├── Publisher [0:N] (dont elle est la référence)
└── Tag [N:N]
```

Dans cette vue, les relations `Video`–`Person`, `Video`–`Tag`, `Publisher`–`Tag` et `Person`–`Tag` passent par des tables associatives explicites. Le `Publisher` d'une source n'implique ni auteur identifié ni personne automatiquement associée à la vidéo.

Une `Video` possède au moins une source dans le parcours d'import actuel ; le modèle relationnel permet d'en accueillir plusieurs. **`Annotation`, `AIArtifact`, une véritable `VideoSource` locale et les clips durables ne sont pas implémentés.** Ils ne doivent pas être traités comme des entités existantes dans les schémas ou les APIs.

### 1.2 Règles de séparation

- **`Video`** : identité de la connaissance dans Sillage, indépendante de ses accès et représentations.
- **`VideoSource`** : provenance et métadonnées issues de cette provenance.
- **`MediaFile`** : octets physiques conservés localement, sans nouvelle identité de vidéo.
- **`Transcript`** : transcription acquise pour une source et sa timeline.
- **`Note`** : document Markdown libre lié à la vidéo, indépendant de la source.
- **`Asset`** : donnée visuelle durable, rattachée à la vidéo et, pour les captures, à la source et au temps demandés.
- **`Publisher`** : compte de publication ; **`Person`** : personne physique ; leurs identités et relations ne sont pas interchangeables.
- **`Tag`** : catalogue partagé, associations explicites sans propagation automatique.

Les données des sources, les modifications utilisateur et les représentations dérivées ne sont jamais confondues. Le rafraîchissement d'une source ne doit pas écraser les connaissances utilisateur.

## 2. `Video`

### 2.1 Responsabilité et identité

`Video` représente « cette vidéo dans la base de connaissances de l'utilisateur », pas « cette URL YouTube ». Elle possède un identifiant interne stable :

```go
type VideoID int64
```

SQLite utilise `INTEGER PRIMARY KEY AUTOINCREMENT` ; l'identifiant n'est ni une URL ni un `external_id`, et les identifiants supprimés ne sont pas réattribués. Une vidéo peut avoir plusieurs sources et représentations physiques sans changer d'identité.

Le type Go courant regroupe l'identité, `created_at`, les sources, les tags et les IDs des personnes directement associées. La note, les transcriptions, les assets et les médias sont accessibles par leurs propres modèles ; ce ne sont pas des champs obligatoirement embarqués dans `Video`.

### 2.2 Métadonnées et titre

Les titres, descriptions, durées et miniatures provenant d'une plateforme appartiennent à ses `VideoSource`. Les informations de publication appartiennent à `Publisher`.

Le titre présenté actuellement dans le Web peut provenir de la première source REST. Ce choix d'affichage **ne crée pas de source principale persistée**. Un futur `title_override` utilisateur ou une politique de sélection entre sources reste à définir ; aucun tel champ n'est implémenté dans `Video`.

De même, un éventuel `updated_at` de vidéo exige une sémantique explicite : modification utilisateur, nouvelle acquisition ou rafraîchissement distant ne sont pas nécessairement équivalents. Ne pas introduire cette donnée par simple commodité technique.

La recherche globale conserve cette identité : un résultat par `Video`, même si plusieurs sources contribuent. Sa projection textuelle est reconstructible depuis les sources, publishers, tags directs et note ; elle ne crée ni titre principal, ni association héritée, ni nouvelle entité de connaissance. Une citation de transcription copiée dans la note est recherchable comme texte utilisateur ; la transcription d'origine reste hors de cet index.

## 3. `VideoSource`, `Publisher` et `Person`

### 3.1 `VideoSource` : provenance et identité

Une `VideoSource` décrit une provenance et ses métadonnées observées. Le seul provider opérationnel actuellement est `youtube` ; une source `local` ou un provider supplémentaire relèvent d'évolutions futures.

Champs et conventions principales :

| Champ | Sens |
| --- | --- |
| `id` | Identité interne `VideoSourceID` (entier SQLite AUTOINCREMENT) |
| `video_id` | `Video` à laquelle appartient la source |
| `provider` | Espace de provenance, par exemple `youtube` |
| `external_id` | Identifiant dans cet espace ; nullable au niveau générique |
| `canonical_url` | Localisateur canonique ; nullable au niveau générique |
| `title` | Titre provenant de la source |
| `description` | Description facultative |
| `publisher_id` | Référence facultative au compte de publication |
| `duration_ms` | Durée facultative, non négative |
| `thumbnail_url` | Miniature facultative |
| `original_audio_language` | Langue audio originale déclarée lorsqu'elle est déterminable |

Le couple `(provider, external_id)` est unique lorsque `external_id` existe. L'identité d'une source ne découle **pas** de son URL. Pour YouTube, `external_id` et `canonical_url` sont obligatoires au niveau applicatif. `provider` sert également à sélectionner l'adapter approprié ; il n'impose pas de sous-types SQL.

Un exemple canonique YouTube est :

```text
provider      = youtube
external_id   = IgKU8xCgbjc
canonical_url = https://www.youtube.com/watch?v=IgKU8xCgbjc
```

Les durées et propriétés provenant d'une plateforme sont distinctes des mesures du fichier réellement téléchargé. `VideoSource` ne contient pas les codecs, dimensions, taille ni chemin du `MediaFile`.

Le champ historique `creator` n'existe plus. Le compte de publication est représenté par `publisher_id` ; l'API peut en exposer la projection `{id, name}` ou `null`, sans dupliquer le nom dans la source persistée.

### 3.2 Métadonnées externes

Sillage conserve les champs utiles explicitement normalisés, **pas de `raw_metadata` yt-dlp permanent par défaut**. Une nouvelle extraction peut alimenter de futurs champs, mais aucun rafraîchissement implicite n'accompagne le réajout d'une source existante.

Cette décision ne s'oppose pas à la conservation de documents sources spécifiques tels que le JSON3 d'une transcription : il s'agit alors du contenu acquis, non d'une copie générique de toutes les métadonnées.

### 3.3 Sources multiples et timelines

Conceptuellement : `Video 1:N VideoSource`. Deux sources peuvent représenter le même contenu avec un décalage ou un montage différent. Leurs timestamps ne sont donc **pas automatiquement interchangeables**.

`AddVideo` retrouve une source déjà connue par son identité externe et ne rafraîchit pas au passage titre, description, publisher ou associations explicites. La détection automatique d'une équivalence entre sources de plateformes différentes n'est pas implémentée.

Une véritable `VideoSource(provider=local)` reste à concevoir. Son éventuel chemin, hash ou ID généré ne doit pas être imposé avant le workflow d'import local. Elle ne se confond pas avec un `MediaFile` téléchargé depuis YouTube.

### 3.4 `Publisher` : compte de publication

`Publisher` est un compte identifié sur une plateforme, **pas nécessairement l'auteur, une personne physique ou le titulaire de droits**.

```text
Publisher
  id
  provider
  external_id
  name?
  person_id?
```

- `(provider, external_id)` constitue son identité externe, distincte de celle des vidéos et de leurs sources ; le nom ne sert jamais à fusionner des comptes.
- Le nom est facultatif, partagé entre les sources liées, et peut rester inconnu.
- La personne de référence est facultative ; elle ne signifie ni propriété du compte ni auteur automatique de son contenu.
- Le provider du publisher doit être compatible avec celui de la source liée ; SQLite renforce cette cohérence.
- Une personne peut être référencée par plusieurs publishers ; un publisher peut exister sans vidéo.

Pour YouTube, l'identifiant fiable est le `channel_id`, **jamais** un handle ou un nom de chaîne. `channel`, puis éventuellement `uploader`, ne sont utilisés que comme libellés d'un compte déjà identifié. L'URL d'un compte peut être résolue explicitement par yt-dlp ; sans ID fiable, la résolution échoue sans créer d'entité. Lors d'un import vidéo, l'absence de publisher fiable laisse simplement la source sans publisher.

Un publisher existant n'est pas rafraîchi automatiquement lors de sa réutilisation, même si son nom est absent. L'association source–publisher peut être ajoutée, remplacée ou retirée explicitement. Une collaboration ou un nom crédité par YouTube ne crée automatiquement ni publisher supplémentaire ni personne.

### 3.5 `Person` : personne physique et associations

```text
Person (id, name)
VideoPerson (video_id, person_id)
```

Le nom d'une personne est obligatoire après suppression des espaces aux extrémités, mais **non unique**. Deux homonymes restent deux identités indépendantes. Une personne peut être renommée, exister sans compte ni vidéo, et être liée explicitement à une vidéo.

La relation `VideoPerson` est N:N, avec unicité du couple et **sans rôle**. Aucune importation de métadonnées ne crée automatiquement une personne.

Deux chemins de navigation demeurent distincts :

```text
Direct   : Video → VideoPerson → Person
Indirect : Video → VideoSource → Publisher → Person
```

La navigation peut réunir ces chemins en dédupliquant les vidéos par ID, mais **ne matérialise jamais un lien direct à partir d'un lien indirect**. Les associations de personnes et leurs tags ne se propagent pas non plus aux sources, comptes ou vidéos.

La suppression des publishers/personnes, les rôles, les organisations et la modélisation des collaborateurs restent à cadrer ; ils n'appartiennent pas au modèle actuel.

## 4. `Transcript`

### 4.1 Identité et appartenance

`Transcript` représente un contenu textuel horodaté **effectivement acquis**. Une simple découverte de pistes distantes ne crée aucune transcription en base.

La relation est `VideoSource 1:N Transcript`, **pas** `Video 1:N Transcript` : la transcription conserve la timeline de la source précise dont elle provient. Son identité persistante est :

```text
UNIQUE(video_source_id, language, provenance)
```

Champs persistants :

| Champ | Sens |
| --- | --- |
| `id` | Identité de transcription stable |
| `video_source_id` | Provenance et timeline |
| `language` | Langue du contenu, sans suffixe technique `-orig` |
| `provenance` | Origine de l'acquisition : actuellement `youtube_auto` |
| `local_path` | Chemin nullable du snapshot source |
| `last_fetched_at` | Date de dernière acquisition effectivement publiée |

Une nouvelle acquisition de même identité actualise la ligne existante ; il n'existe pas d'historique métier de versions. Un identifiant de piste propre au provider n'est pas persisté.

Les provenances hypothétiques `youtube_manual` et `local_stt` ne correspondent pas à des fonctions déjà implémentées.

### 4.2 Sélection YouTube et langue

La politique actuelle privilégie les captions automatiques portant `-orig` et disponibles en **JSON3**. `VideoSource.original_audio_language` est une information facultative, alimentée uniquement par un signal original audio suffisamment fiable de yt-dlp ; les captions, les titres et les pistes audio « par défaut » ne prouvent pas l'originalité.

Pour sélectionner une caption admissible :

1. privilégier la clé `*-orig` correspondant exactement à la langue audio originale connue ;
2. sinon, pour une étiquette simple `langue-région` (région de deux lettres ou trois chiffres), essayer la clé originale générique : `en-US` → `en-orig` ;
3. sinon, accepter un **unique** candidat original admissible ; s'il n'y en a aucun, refuser l'acquisition ; s'il en existe plusieurs sans correspondance prioritaire, signaler l'ambiguïté.

Les écritures ou étiquettes complexes ne sont pas simplifiées. Plusieurs formats d'une même clé ne constituent pas plusieurs candidats. Une piste admissible exige une langue exploitable et une URL HTTPS JSON3 valide ; aucune traduction ni piste manuelle n'est demandée. Une redétection audio au cours de l'acquisition ne départage pas les candidats.

**Limite acceptée :** `-orig` peut aussi décrire les captions d'un doublage. Une piste unique de langue différente peut être choisie. La langue audio originale et celle de la transcription demeurent distinctes ; aucune acquisition de transcript ne modifie `original_audio_language`. L'UI parle de « Transcription automatique », sans affirmer qu'elle reproduit nécessairement l'audio original.

### 4.3 Publication et disponibilité du snapshot

Une acquisition réussie valide le JSON3, publie un fichier unique complet puis met à jour la référence SQLite. Elle remplace le contenu courant sans changer l'identité de transcription. En cas d'échec, l'ancien contenu, son chemin et sa date restent inchangés.

Le snapshot est stocké sous un chemin relatif. Les anciens fichiers peuvent rester pendant une transition ; un crash ou un échec SQL peut laisser un fichier sans référence. Leur rétention à long terme et leur nettoyage ne sont pas encore définis.

`local_path` est nullable au niveau du modèle, mais **le workflow actuel exige un snapshot lisible** après acquisition. Un GET ne recontacte jamais YouTube. Un snapshot absent ou corrompu constitue donc aujourd'hui une anomalie locale, et non une invitation à réacquérir silencieusement le contenu.

Les URL signées des captions, les dumps généraux yt-dlp et un catalogue des pistes ne sont pas persistés comme données durables.

### 4.4 Contenu indépendant du format source

```go
type TranscriptItem struct {
    StartMS int64
    Text    string
}

type TranscriptContent []TranscriptItem
```

Les items sont des fragments **ordonnés**, non nécessairement des mots, sans ID propre, `end_ms` ou interlocuteur. Ils ne sont pas stockés individuellement dans SQLite.

Le parseur JSON3 calcule les positions notamment à partir de `event.tStartMs + seg.tOffsetMs` (offset absent égal à zéro), rejette les valeurs invalides et débordements, ignore les événements sans texte, préserve les blancs et l'ordre des fragments, et encode les séparations nécessaires entre blocs autonomes. Un document sans texte exploitable est refusé.

`TranscriptContent.PlainText()` concatène les textes puis normalise les blancs : il s'agit d'une **représentation dérivée en mémoire**. L'affichage et la recherche peuvent aussi s'appuyer sur la concaténation exacte des fragments pour préserver leurs indices et leurs espaces. Aucun texte intégral ni résultat de regroupement visuel n'est persisté séparément.

### 4.5 Consultation actuelle

La consultation courante sélectionne la transcription `youtube_auto` la plus récemment acquise pour la source, par `last_fetched_at DESC, id DESC`. Il n'existe ni sélection manuelle de piste ni interface multi-transcriptions dans la version actuelle. Les corrections utilisateur et les productions IA devront, si elles sont introduites, rester distinctes du contenu source.

## 5. `Note`

### 5.1 Document principal et persistance

Une `Note` est le document Markdown de travail **de la vidéo**, non d'une de ses sources :

```text
Video 1 → 0..1 Note
```

| Champ | Sens |
| --- | --- |
| `video_id` | Clé primaire et étrangère ; la note n'a pas d'ID autonome |
| `content_md` | Markdown brut enregistré en SQLite `TEXT` |
| `created_at` | Date de première création |
| `updated_at` | Date de la dernière modification effective |
| `revision` | Entier strictement positif utilisé par les écritures conditionnelles |

Aucune note n'est créée lors du seul import ou de l'ouverture d'une vidéo. La première sauvegarde crée la note ; une note vide enregistrée et une note absente sont deux états différents. Une modification des métadonnées, du publisher, des sources ou d'une transcription ne remplace jamais son contenu.

Le service applicatif stocke le Markdown **sans interpréter son contenu** : il ne parse ni les liens temporels ni les images, et ne génère pas de HTML pour la persistance. Les seules transformations sont les fins de ligne `CRLF` et `CR`, normalisées en `LF` lors d'une sauvegarde. Tous les autres caractères et espacements sont conservés.

La lecture d'une ancienne note n'effectue ni normalisation ni écriture. Une sauvegarde ultérieure peut normaliser son texte ; la première normalisation réelle est une modification, tandis qu'une sauvegarde déjà identique au contenu canonique ne change ni la révision ni les dates.

### 5.2 Concurrence et cycle de révision

Chaque écriture exige une **révision attendue** :

- `0` signifie « je m'attends à l'absence de note » ;
- une valeur positive désigne une version déjà lue ;
- une révision périmée est un **conflit**, même si le texte proposé serait identique après normalisation.

La comparaison et l'écriture sont atomiques en persistance, quel que soit le client. Une création commence à la révision `1` ; une modification effective l'incrémente ; un contenu identique avec précondition correcte ne déclenche pas de mise à jour. `created_at` reste stable. Les anciennes notes ont reçu une révision initiale `1` sans modification de leur texte ni de leurs dates lors de l'introduction de ce mécanisme.

La stratégie historique « dernière écriture gagnante » **n'est plus applicable**. Il n'existe actuellement ni suppression explicite, ni ajout partiel, ni historique de versions métier, ni plusieurs notes principales pour une vidéo.

### 5.3 Références temporelles dans le Markdown

Les références temporelles sont du **Markdown source** ; leur présence ne crée ni annotation structurée ni autre entité SQL.

Format canonique actuellement produit :

```markdown
[12:42](sillage://videos/5/sources/5?start_ms=762345)
```

- `videos` est l'autorité logique de l'URI ; `video_id` et `source_id` sont explicites.
- `start_ms` est un entier non négatif ; son unité canonique est la milliseconde.
- Le libellé `12:42` est uniquement une présentation, **pas** la source de la position.
- Les IDs doivent pouvoir être représentés exactement par le frontend pour les références qu'il génère.
- `end_ms` est réservé à une éventuelle plage future, strictement postérieure au début ; les plages ne sont pas implémentées.

Les identifiants sont propres à une base Sillage : copier le Markdown dans une autre note de **la même base** préserve la référence ; une autre installation indépendante ne garantit pas sa résolution. Copier seulement le libellé rendu ne conserve pas nécessairement l'URI.

Les callouts de citation de transcription (`quote:tr`) utilisent la même provenance temporelle sans nouvelle table de citations. Une citation transcrite reste un contenu Markdown que l'utilisateur peut modifier ; elle n'est pas garantie authentique ni synchronisée avec la transcription source.

La représentation enrichie, l'édition et la navigation sont décrites dans [Product & UX](01-product-and-ux.md). Les formats d'export et les liens temporels couvrant plusieurs sources restent des questions ouvertes.

## 6. `Annotation` — concept futur, non implémenté

Une `Annotation` serait une référence temporelle **structurée et identifiable**, distincte du texte libre d'une `Note` : elle pourrait servir des listes, marqueurs de timeline, recherches ciblées, API/MCP et catégories.

L'ancienne esquisse `id`, `video_id`, `timestamp_ms`, `content_md` n'est **pas un schéma acté**. Elle ne résout pas à elle seule la question des sources multiples ni celle des plages début/fin.

Les questions à trancher avant de créer cette entité sont notamment :

- indépendance ou lien explicite avec une référence Markdown ;
- création directe, depuis une sélection de transcription ou depuis une référence existante ;
- source ou timeline à laquelle s'applique la position ;
- éventuelles plages temporelles et types d'annotations ;
- éventuelle représentation et modification depuis la note.

Aucune conversion automatique de `[12:42]` ni analyse systématique du Markdown en entités `Annotation` n'est décidée. Voir [Open questions — notes, annotations et temps](06-open-questions.md).

## 7. `Asset`

### 7.1 Identité, provenance et états

Un `Asset` conserve une donnée visuelle **indépendamment de son éventuelle insertion dans une note**. L'implémentation actuelle ne prend en charge que le type `screenshot` (PNG). L'identité persistante de l'asset est distincte de son chemin physique.

| Champ | Sens actuel |
| --- | --- |
| `id` | Identité persistante, attribuée avant l'extraction |
| `video_id` | Vidéo obligatoire |
| `source_id` | Référence à la `VideoSource` ; obligatoire pour `screenshot` |
| `timestamp_ms` | Position demandée ; obligatoire et non négative pour `screenshot` |
| `type` | Actuellement `screenshot` seulement |
| `status` | `pending`, `available` ou `failed` |
| `path` | Chemin interne du PNG, nullable |
| `size` | Taille des octets, positive lorsque `available` |
| `error_code` | Catégorie d'échec sans diagnostic sensible brut |
| `request_id` | Clé unique d'idempotence de la commande |
| `created_at` | Date de création de l'intention |

Le couple `(source_id, video_id)` est protégé en base : une capture ne peut pas être rattachée à la vidéo d'une autre source. **`source_id` qualifie la timeline demandée, pas nécessairement le flux physique qui a fourni les pixels.** Le service peut extraire depuis le média local de cette source ou depuis la source distante, sans changer cette provenance métier.

### 7.2 Acceptation, génération et conservation

Une demande valide crée un asset `pending` avant l'extraction. La publication d'un PNG complet précède la transition vers `available`. Une extraction refusée, échouée ou interrompue conduit à `failed` ; les anciennes intentions `pending` sont clôturées au redémarrage sans régénération automatique.

- La même `request_id` avec les mêmes paramètres retrouve la même intention/identité ; avec d'autres paramètres, la commande est refusée.
- Deux demandes différentes au même timestamp peuvent créer deux assets : il ne s'agit pas d'une déduplication fonctionnelle.
- Un échec SQL après publication peut laisser des octets non référencés ou un chemin enregistré malgré un statut `failed` ; ce n'est pas une permission de les supprimer automatiquement.
- Un asset `available` ne garantit pas que le fichier soit encore lisible après une suppression ou une corruption extérieure : **identité/état et disponibilité effective sont distincts**.
- Les références Markdown utilisent l'URL publique `/api/v1/assets/{id}/content`, jamais un nom de fichier comme identifiant métier.

Retirer une image d'une note, annuler son insertion ou supprimer son `MediaFile` d'origine **ne supprime pas l'asset**. Les fichiers publiés et orphelins ne sont pas automatiquement nettoyés au démarrage. Le catalogue de la vidéo retrouve aussi les captures non référencées, toutes sources et tous états confondus. Le tri par timestamp puis identité conserve chaque source sans synchroniser ses positions avec celles des autres. Import, suppression explicite et types supplémentaires restent à cadrer ; aucune hiérarchie d'assets futurs n'est anticipée.

## 8. `MediaFile`

### 8.1 Représentation physique locale

`MediaFile` répond à la question « quels octets de cette vidéo sont conservés localement ? » ; `VideoSource` répond à « d'où provient-elle ? ». Télécharger une vidéo ne crée **ni nouvelle `Video` ni nouvelle `VideoSource`**.

Attributs persistants actuels :

| Champ | Sens |
| --- | --- |
| `id` | Identité physique durable du fichier conservé |
| `video_id` | Vidéo propriétaire |
| `origin_source_id` | `VideoSource` d'origine, facultative dans le modèle général |
| `path` | Chemin interne relatif, unique et non exposé dans l'API |
| `format` | Conteneur réel, non limité à MP4/WebM |
| `size` | Taille positive en octets |
| `duration_ms` | Durée mesurée, strictement positive |
| `added_at` | Date de conservation |
| `video_codec`, `audio_codec` | Codecs déclarés par `ffprobe`, nullable |
| `width`, `height` | Dimensions encodées positives, nullable |
| `fps` | Cadence moyenne exploitable, nullable |
| `audio_language` | Langue de la piste audio effectivement choisie, nullable |

Les champs techniques nullable permettent de conserver les médias antérieurs à leur introduction **sans analyse rétroactive implicite**. `fps` est une moyenne ; les dimensions encodées ne garantissent ni rotation, ni ratio de pixels, ni rendu exact dans le navigateur.

Pour les téléchargements YouTube actuels, `audio_language` provient de la représentation sélectionnée par yt-dlp, pas des tags ffprobe ni de `VideoSource.original_audio_language`. Elle peut différer de l'audio original ou de la transcription. Une valeur inconnue reste absente : aucune langue n'est inventée.

### 8.2 Provenance et cardinalité

Le lien général `origin_source_id → VideoSource.id` est facultatif, mais **obligatoire pour les téléchargements YouTube actuels**. La base garantit que le fichier et la source d'origine appartiennent à la même `Video`.

Un index unique partiel impose actuellement **au plus un média conservé par source d'origine**. Plusieurs qualités, représentations parallèles ou audio seul ne sont pas encore implémentés. Cette restriction locale ne doit pas devenir une hypothèse définitive du modèle général.

Une source `local` future pourrait décrire la provenance d'un fichier importé, tandis que `MediaFile` en représenterait les octets ; son identité et son cycle d'import restent à décider. Le stockage du fichier ne détermine pas à lui seul la source ni l'identité de la vidéo.

### 8.3 Publication, suppression et disponibilité

La conservation téléchargée est **volontaire et durable jusqu'à suppression explicite**. Le fichier n'est déclaré disponible qu'après acquisition, validation, publication physique et référence SQLite cohérente. La publication et la suppression utilisent des étapes récupérables ; aucun mécanisme ne les présente comme une transaction unique SQLite + filesystem.

La validation technique du fichier et de sa durée ne constitue pas une preuve d'égalité parfaite image par image avec la source. Le conteneur et les codecs admissibles à la conservation ne garantissent pas la compatibilité de lecture Web. Un échec de décodage navigateur ne supprime pas le `MediaFile` et n'altère pas les connaissances.

Le statut de téléchargement (`not_downloaded`, `downloading`, `available`, `failed`) est **une vue applicative de la disponibilité et de l'activité**, pas un champ durable de `MediaFile`. L'état d'une opération en cours ou de son dernier échec peut être éphémère ; seule la référence publiée et le fichier constituent la conservation durable.

Supprimer un `MediaFile` ne supprime pas sa `Video`, ses `VideoSource`, transcriptions, notes, tags ou `Asset`. Les fichiers complets non référencés, temporaires abandonnés et suppressions interrompues ne sont pas effacés automatiquement lors d'un rapprochement, notamment après restauration d'une ancienne base. Une maintenance future devra être explicite et conservatrice.

La lecture locale réserve temporairement **une requête de fichier**, non une session de lecture persistante : une suppression peut réussir entre deux requêtes Range. Aucun objet « lecture en cours » n'est ajouté au domaine. Les règles de transport, concurrence et récupération relèvent de [l'architecture](03-architecture.md).

## 9. `Tag`

### 9.1 Catalogue partagé et identité

`Tag` appartient à un **catalogue unique**, réutilisable pour vidéos, publishers et personnes. Les associations sont explicites :

```text
Video     N:N Tag  via video_tags
Publisher N:N Tag  via publisher_tags
Person    N:N Tag  via person_tags
```

Le tag possède `id` (identifiant entier stable) et `name` (nom d'affichage). Son identité de comparaison est distincte de sa casse affichée.

Règles contractuelles :

- retirer les espaces en début et fin ; refuser un nom vide et les valeurs non UTF-8 ;
- limiter un nom à 200 points de code Unicode après trim ;
- identifier par **NFC + repli complet de casse Unicode**, indépendant de la locale ;
- conserver les accents et ne pas appliquer NFKC, suppression d'accents ni synonymie ;
- lors d'un ajout, réutiliser un tag équivalent sans modifier sa graphie d'affichage courante.

Exemples :

| Deux saisies | Résultat |
| --- | --- |
| `DevOps` / `devops` | Même tag |
| `École` / `école` | Même tag |
| `Café` (précomposé) / `Café` (accent combinant) | Même tag |
| `Café` / `Cafe` | Tags distincts |
| `Go` / `Golang` | Tags distincts |

La clé normalisée est matérialisée en persistance et protégée par unicité SQL. Changer la stratégie d'identité exige de prévoir les collisions possibles entre tags déjà stockés.

Un renommage explicite conserve l'ID et toutes les associations, actualise le nom et sa clé,
et autorise une correction de graphie à clé identique. Une collision avec un autre ID est refusée,
sans fusion. La dernière écriture réussie prévaut, sans précondition de révision. Un ancien nom
libéré peut ensuite être réutilisé.

La suppression globale retire atomiquement le tag et ses associations aux vidéos, publishers et
personnes, en conservant ces entités. Elle est idempotente et porte sur tous les liens présents
dans la transaction, indépendamment des compteurs précédemment consultés. Les tags inutilisés
restent conservés jusqu'à une suppression explicite. Les compteurs du catalogue dénombrent
chaque type d'association directe, sans héritage.

### 9.2 Associations et absence d'héritage

Un ajout par noms est **additif et atomique**, création de nouveaux tags comprise. Un échec n'autorise ni création ni association partielle ; les doublons de même identité sont fusionnés dans la demande.

Le retrait supprime uniquement une association. Un tag devenu inutilisé reste dans le catalogue ; aucune suppression automatique ou quota métier arbitraire n'est prévu. Les tables associatives possèdent des clés étrangères et une unicité des paires d'IDs : aucune table polymorphe générique n'est introduite.

Les tags **ne sont pas hérités** : taguer une personne ou un publisher ne tague pas ses vidéos. Le filtre vidéo `tag_id` s'applique uniquement aux tags associés directement aux vidéos. Toute extension de recherche traversant ces associations devra le faire explicitement, sans modifier les liens ni hériter de leurs tags.

Fusion, alias, hiérarchie, catégories et couleurs sont des évolutions ouvertes, pas des opérations existantes.

## 10. `AIArtifact` — concept futur, non implémenté

Une sortie IA peut, si le besoin le justifie, être conservée comme artefact dérivé : résumé, chapitres, points clés, tags suggérés, transcription enrichie, etc.

Aucun schéma `AIArtifact`, type de résultat, règle de provenance, modèle de régénération ni fournisseur n'est actuellement acté. Un éventuel artefact pourra être rattaché à une `Video` ou à une autre donnée pertinente après cadrage.

**Invariant à préserver :** une production ou correction IA ne remplace pas silencieusement les données source. Les résultats générés et leur provenance doivent rester identifiables selon la politique future retenue. Voir [Open questions — IA](06-open-questions.md).

## 11. Invariants transversaux

Les invariants suivants s'appliquent à plusieurs entités et servent de garde-fous à toute évolution du modèle.

### 11.1 Identités et provenance

- Une `Video` est indépendante de ses `VideoSource`, `MediaFile`, comptes de publication et chemins locaux.
- `(provider, external_id)` d'une source vidéo et celui d'un publisher appartiennent à **deux espaces d'identité distincts**.
- Une source n'est pas un fichier ; un compte n'est pas une personne ; une association indirecte ne crée pas automatiquement un lien direct.
- Une représentation locale, un chemin ou une URL ne devient pas l'identifiant métier d'une vidéo.
- La présence, l'absence ou l'indisponibilité d'octets locaux ne fait pas disparaître les identités métier.

### 11.2 Données temporelles

Les **positions et durées média** sont des entiers exprimés en millisecondes : `start_ms`, `timestamp_ms`, `duration_ms`, généralement `int64` en Go et `INTEGER` en SQLite.

Les **dates d'événements** utilisent `time.Time` en Go et une chaîne UTC RFC 3339 à précision milliseconde fixe en SQLite, par exemple `2026-10-06T18:00:00.000Z` pour `created_at`, `updated_at`, `last_fetched_at`, `added_at`. Ne pas employer `_ms` pour ces dates.

Les timestamps provenant d'une source ne sont pas automatiquement transposables à une autre source de la même vidéo. `Transcript` et les captures conservent explicitement leur référence à la source. Les annotations futures devront résoudre la même question avant toute implémentation.

### 11.3 Source, dérivé et connaissance utilisateur

- Le JSON de métadonnées yt-dlp et le JSON3 ne définissent pas les entités métier : ils sont interprétés aux frontières techniques.
- Un snapshot JSON3 peut être conservé intégralement, sans persistance mot par mot dans SQLite.
- Le texte continu d'une transcription et son regroupement d'affichage restent des représentations dérivables ; une future indexation peut ajouter une copie dérivée clairement identifiée.
- Les notes, tags, assets, associations de personnes/publishers et futures surcharges utilisateur sont protégés contre les rafraîchissements externes.
- L'existence d'un `Transcript`, `MediaFile` ou `Asset` ne prouve pas, à elle seule, que les octets sont encore disponibles et intègres.

### 11.4 Persistance et effets de bord

Les contraintes de clés étrangères, d'unicité et les transactions SQL renforcent les règles métier : une vérification préalable en mémoire ne les remplace pas.

Les opérations qui associent une source, un publisher ou des tags doivent rester cohérentes et atomiques dans leur périmètre SQL. Une publication filesystem puis SQLite n'est pas une transaction globale ; les fichiers potentiellement orphelins et les résultats incertains exigent une politique **de conservation prudente**, pas un nettoyage silencieux.

## 12. Concepts différés et maintenance du modèle

Ne pas introduire avant besoin concret :

- `Annotation` persistée, plages temporelles et timeline générique ;
- `VideoSource` locale et déduplication inter-providers automatique ;
- clips durables et autres variantes d'assets ;
- plusieurs `MediaFile` par source, stockage multiqualité ou audio seul ;
- `Job` persistant, historique métier complet ou audit log ;
- catalogue de pistes, sous-titres manuels, diarisation, chapitres structurés ou STT ;
- `AIArtifact` défini, embeddings et base vectorielle ;
- collections, playlists, taxonomie de tags complexe et rôles de personnes ;
- permissions multi-utilisateur, organisations et relations de propriété ;
- suppression globale de personnes ou publishers et propagation automatique de tags.

Les raisons et questions encore ouvertes sont rassemblées dans [06-open-questions.md](06-open-questions.md), notamment les [clips vidéo durables](06-open-questions.md#34-clips-vidéo-durables). La planification appartient à [05-roadmap.md](05-roadmap.md). Les détails de transport des `MediaFile`, de récupération après interruption et de publication des captures restent dans [03-architecture.md](03-architecture.md).

**Règle de maintenance :** mettre à jour ici le concept ou l'invariant affecté lorsqu'une décision métier change. Ne pas ajouter de comptes rendus de réalisation ou de validation à la fin du document ; Git et les PR conservent ces traces. Avant de déclarer une nouvelle entité « implémentée », vérifier ses types et migrations effectifs.
