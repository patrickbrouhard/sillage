# Tech stack & decisions

## 1. Objet de ce document

Ce fichier centralise les décisions techniques prises ou fortement privilégiées.

Il doit distinguer :

- **Acté** : décision actuelle à considérer comme référence ;
- **Préféré** : direction choisie, mais encore facile à réviser ;
- **Ouvert** : aucune décision définitive.

Le but est d'éviter que des choix ponctuels discutés dans une conversation deviennent implicitement des contraintes permanentes.

## 2. Tableau synthétique

| Sujet | Choix actuel | Statut |
| --- | --- | --- |
| Langage backend | Go | Acté |
| Forme initiale | Application self-hosted en conteneur Docker | Acté |
| HTTP | `net/http` | Acté |
| Router | Chi | Acté |
| Base de données | SQLite | Acté |
| Driver SQLite Go | `modernc.org/sqlite` via `database/sql` | Acté |
| IDs persistants initiaux | `INTEGER PRIMARY KEY AUTOINCREMENT` | Acté |
| Migrations initiales | SQL embarqué + `embed.FS` + `PRAGMA user_version`, forward-only | Acté pour la phase initiale |
| Outil de migrations externe | aucun pour l'instant ; Goose à reconsidérer si le besoin augmente | Ouvert pour plus tard |
| Recherche avancée | SQLite FTS5 | Préféré pour plus tard |
| Métadonnées vidéo | `yt-dlp` via binaire externe | Acté |
| Sous-titres YouTube | `yt-dlp` + piste automatique originale `*-orig` + `json3` | Acté pour la première implémentation |
| Persistance des fragments de transcription | pas de mots/segments en SQLite | Acté |
| Contenu local des transcriptions | snapshot source facultatif, `local_path` nullable | Acté pour le modèle ; politique de rétention ouverte |
| JSON propriétaire de transcription | aucun pour l'instant | Acté |
| URL directe des captions | résolue à la demande, non persistée comme donnée durable | Acté |
| Traitement média | `ffmpeg` | Préféré / attendu |
| API | REST HTTP | Acté |
| MCP | Serveur MCP Go appelant directement les services applicatifs | Acté architecturalement, implémentation différée |
| SDK MCP | SDK Go officiel | Préféré |
| Frontend Web | à choisir | Ouvert |
| Desktop | possibilité future, Wails à évaluer | Ouvert |
| IA intégrée | fournisseur à choisir | Ouvert |
| STT local | moteur à choisir si besoin | Ouvert |
| `raw_metadata` yt-dlp | ne pas conserver par défaut | Acté |
| Jobs persistants | pas dans le modèle initial | Acté pour le MVP |
| PostgreSQL/MySQL | non nécessaires par défaut | Acté tant qu'aucun besoin ne l'impose |
| WAL SQLite | non décidé | Ouvert |
| Logging structuré / niveaux | à définir plus tard | Ouvert |
| Dates calendaires | `TEXT` UTC RFC 3339 à millisecondes fixes | Acté |
| Note principale | zéro ou une par vidéo, `video_id` clé primaire, Markdown brut en SQLite `TEXT` | Acté pour l'étape 4, non implémenté |
| Identité des tags | NFC + comparaison Unicode insensible à la casse, accents significatifs | Acté pour l'étape 4, mécanisme technique libre |
| REST des tags | enveloppe `tags`, ordre `id` croissant dans toutes les réponses | Acté pour l'étape 4, non implémenté |
| Écritures concurrentes des notes | dernière écriture gagnante | Provisoire pour l'étape 4, à réexaminer à l'étape 5 |

## 3. Go

Go est le langage principal.

Raisons :

- déjà maîtrisé ;
- bon support HTTP ;
- adapté aux services simples et aux outils système ;
- facile à distribuer ;
- bonne intégration avec des binaires externes ;
- compatible avec une future application desktop via des outils comme Wails ;
- SDK MCP Go disponible.

L'application doit rester idiomatique et éviter les frameworks imposant une architecture disproportionnée.

## 4. HTTP : `net/http` + Chi

### Décision

Utiliser la bibliothèque standard `net/http` avec Chi pour le routing.

### Raisons

Chi apporte :

- routing expressif ;
- middlewares ;
- groupes et sous-routes ;
- paramètres de chemin ;
- composition ;
- faible niveau d'abstraction au-dessus de `net/http`.

Il répond au besoin sans imposer un framework Web lourd.

### Conséquence

Ne pas introduire Gin, Fiber, Echo ou autre framework sans besoin concret démontré.

## 5. SQLite

### Décision

SQLite est le SGBD principal.

### Raisons

Le workload initial est celui d'une application personnelle ou à très faible nombre d'utilisateurs :

- lectures fréquentes ;
- écritures modérées ;
- données relationnelles ;
- besoin de transactions ;
- déploiement local simple ;
- un seul fichier de base.

Architecture :

```text
application
    ↓
bibliothèque SQLite
    ↓
sillage.db
```

Pas de serveur de base de données séparé.

### Conséquences

Le conteneur reste simple :

```text
/data/sillage.db
/data/media/
/data/assets/
/data/transcripts/
```

Le passage à PostgreSQL n'est pas interdit, mais ne doit pas être anticipé sans besoin réel.

### 5.1 Driver SQLite : `modernc.org/sqlite`

#### Décision

Utiliser :

```text
database/sql
+
modernc.org/sqlite
```

#### Raisons

Le driver :

- s'intègre à l'API standard `database/sql` ;
- fonctionne sans CGO ;
- évite d'imposer un toolchain C ;
- reste cohérent avec le déploiement Docker ;
- conserve une bonne portabilité pour une éventuelle application desktop ;
- permet de rester sur une couche SQL explicite sans ORM.

Les performances maximales d'un driver SQLite ne constituent pas un critère important pour le workload initial de Sillage.

### 5.2 Identifiants persistants

#### Décision

Les premières entités persistantes utilisent des identifiants entiers générés par SQLite.

Pour `Video` et `VideoSource` :

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
```

Le domaine peut utiliser des types dédiés :

```go
type VideoID int64
type VideoSourceID int64
```

#### Raisons

- simplicité ;
- correspondance naturelle avec SQLite ;
- aucune dépendance supplémentaire ;
- aucune exigence actuelle de génération distribuée ;
- absence de besoin de fusion multi-instance ;
- les identifiants supprimés ne sont pas réattribués.

UUID, ULID ou UUIDv7 ne répondent actuellement à aucun besoin du MVP.

Pour l'étape 4 à implémenter, `Tag` aura un identifiant entier stable généré
par SQLite. `Note` n'aura pas d'identifiant propre : `video_id` sera à la fois
sa clé primaire et sa référence vers `Video`.

Ils pourront être reconsidérés si des contraintes futures d'import/export, synchronisation ou distribution apparaissent.

### 5.3 Schéma SQLite initial

La première migration contient uniquement les tables nécessaires à la tranche de persistance :

```sql
CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL
);

CREATE TABLE video_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),

    provider TEXT NOT NULL,
    external_id TEXT,
    canonical_url TEXT,

    title TEXT NOT NULL,
    description TEXT,
    creator TEXT,
    duration_ms INTEGER,
    thumbnail_url TEXT,

    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE UNIQUE INDEX ux_video_sources_provider_external_id
    ON video_sources(provider, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX ix_video_sources_video_id
    ON video_sources(video_id);
```

Principes :

- `external_id` est facultatif dans le modèle générique ;
- `canonical_url` est facultative dans le modèle générique ;
- pour YouTube, ces deux valeurs sont obligatoires au niveau applicatif ;
- `(provider, external_id)` est unique lorsqu'un `external_id` existe ;
- l'URL ne définit pas l'identité d'une source ;
- `duration_ms`, lorsqu'elle existe, ne peut pas être négative ;
- la création d'une `Video` et de sa première `VideoSource` est transactionnelle.

Les notes et tags seront ajoutés par des migrations de l'étape 4, dont le
cadrage est terminé mais l'implémentation reste à réaliser. Ne pas anticiper :

- `MediaFile` ;
- `title_override` ;
- `updated_at` sans sémantique définie ;
- soft delete ;
- autres colonnes sans besoin concret.

La migration `0002_transcripts.sql` ajoute `original_audio_language` aux sources
et la table `transcripts` décrite dans le modèle métier. Le schéma initial a été
réinitialisé pour les dates TEXT : les anciennes bases en dates entières doivent
être recréées, sans migration historique.

### 5.4 Migrations SQLite

#### Décision initiale

Utiliser des migrations SQL :

- versionnées ;
- embarquées dans le binaire avec `embed.FS` ;
- appliquées dans l'ordre ;
- forward-only ;
- suivies avec `PRAGMA user_version`.

Structure envisagée :

```text
internal/adapter/sqlite/
├── db.go
├── migrations.go
├── video_repository.go
└── migrations/
    └── 0001_initial.sql
```

Flux :

```text
ouvrir la DB
    ↓
lire PRAGMA user_version
    ↓
appliquer les migrations manquantes
    ↓
mettre user_version à jour
    ↓
démarrer l'application
```

Chaque migration doit être appliquée dans une transaction.

Le programme doit refuser d'ouvrir une base dont la version de schéma est supérieure à la version maximale connue du binaire.

#### Pourquoi ne pas utiliser Goose maintenant

À ce stade :

- la base peut encore être détruite et recréée sans coût ;
- le nombre de migrations sera très faible ;
- Sillage ne nécessite pas encore un framework de migrations plus riche.

Un petit runner interne est donc suffisant et évite une dépendance supplémentaire.

#### Goose plus tard

Goose reste une option à reconsidérer lorsque :

- la base contiendra des données qu'il faudra préserver ;
- le nombre de migrations augmentera ;
- les migrations deviendront plus complexes ;
- les besoins opérationnels justifieront un outil dédié.

Ce point est volontairement laissé ouvert plutôt que de considérer le runner initial comme une contrainte définitive.

### 5.5 Configuration SQLite initiale

#### Foreign keys

Les clés étrangères doivent être activées pour les connexions SQLite :

```text
foreign_keys = ON
```

Cette configuration relève de l'adapter SQLite.

#### Busy timeout

Configurer un délai d'attente initial de l'ordre de :

```text
5000 ms
```

afin qu'une courte contention ne provoque pas immédiatement une erreur `SQLITE_BUSY`.

La valeur exacte pourra être ajustée si le comportement réel le justifie.

#### WAL

Le mode WAL n'est pas activé par décision architecturale à ce stade.

Il reste ouvert et pourra être évalué lorsque l'API introduira de vraies lectures et écritures concurrentes.

### 5.6 Persistance Notes + Tags — décisions de l'étape 4

Les invariants fonctionnels sont définis dans [le modèle métier](02-domain-model.md),
sections 5 et 9. Ils sont actés, mais aucun schéma Notes + Tags n'est encore implémenté.

- Stocker le Markdown directement dans une colonne `TEXT`, sans transformation,
  parsing ni rendu ; préserver exactement le contenu après relecture et redémarrage.
- Distinguer note absente et note vide ; conserver les dates lors d'une sauvegarde
  identique et utiliser UTC à précision milliseconde pour les modifications effectives.
- Garantir en persistance l'unicité concurrente des tags selon leur identité
  NFC et insensible à la casse, ainsi que l'unicité des associations.
- Conserver les accents et la casse d'affichage initiale ; exclure NFKC,
  suppression d'accents et rapprochements sémantiques.
- Rendre atomiques les créations de tags et leurs associations pour un ajout multiple.
- Conserver les tags devenus inutilisés ; ne pas introduire de quota métier arbitraire
  de tags par vidéo.

La bibliothèque Unicode éventuelle, le mécanisme d'unicité SQL, les index,
l'organisation interne des services et repositories, les limites raisonnables
des requêtes et des noms et les validations secondaires restent des choix locaux
d'implémentation. Aucune solution technique particulière n'est imposée ici.

La dernière écriture gagnante des notes est un compromis limité à l'étape 4.
L'étape 5 devra réexaminer l'autosauvegarde, les onglets concurrents, la prévention
des pertes de modifications et les éventuels mécanismes de résolution des conflits.

## 6. SQLite FTS5

FTS5 est la technologie privilégiée pour une future recherche plein texte.

Contenus potentiellement indexés :

- titre ;
- description ;
- notes ;
- transcription ;
- résumés IA ;
- autres contenus textuels.

L'intégration ne fait pas partie des premières étapes obligatoires.

Une recherche simple peut précéder FTS5.

## 7. `yt-dlp`

### Décision

Utiliser le binaire `yt-dlp` depuis Go.

### Raisons

Une implémentation antérieure en Go/CLI a déjà validé cette approche.

L'appel externe permet :

- de conserver le backend en Go ;
- de bénéficier directement des capacités de `yt-dlp` ;
- de garder `yt-dlp` derrière un adapter ;
- d'éviter un couplage au code Python interne.

### Règle

Le domaine ne connaît pas les options CLI `yt-dlp`.

L'adapter transforme une demande métier en commande externe, puis normalise le résultat.

## 8. Métadonnées

Les métadonnées nécessaires sont extraites et stockées explicitement.

Décision :

```text
pas de raw_metadata permanent par défaut
```

Raisonnement :

- les besoins réels doivent être modélisés ;
- conserver toutes les données « au cas où » n'apporte pas assez de valeur ;
- la source peut être réinterrogée si le modèle évolue ;
- le modèle sera de toute façon affiné pendant le développement.

Un cache brut temporaire ou un mode debug reste possible plus tard.

Les champs génériques actuels de `VideoSource` utilisent notamment :

```text
provider
external_id?
canonical_url?
title
description?
creator?
duration_ms?
thumbnail_url?
```

`external_id` et `canonical_url` peuvent être facultatifs pour de futures provenances. Pour YouTube, ils sont obligatoires.

## 9. Sous-titres YouTube et JSON3

### Implémentation actuelle

Voir le contrat REST du README et le modèle dans `02-domain-model.md`.

- captions automatiques originales uniquement, JSON3 obligatoire ;
- langue métier sans suffixe `-orig`, sous-étiquettes conservées ;
- langue audio originale facultative sur `VideoSource` ;
- identité `(video_source_id, language, provenance)`, provenance `youtube_auto` ;
- aucun catalogue de pistes ni fragment en SQLite ;
- snapshot JSON3 obligatoire à chaque acquisition réussie de cette tranche ;
- aucun texte brut persisté ni format propriétaire ;
- GET strictement local, POST synchrone toujours en 200 ;
- pas de sélection manuelle, de STT ni de recherche temporelle.

### Signaux de langue

Dans la sortie structurée YouTube de yt-dlp, les formats audio marqués
`language_preference = 10` identifient l'original ; la valeur `5` désigne
seulement le défaut et n'est pas utilisée comme preuve. Plusieurs formats
de même langue sont regroupés. Des signaux audio originaux contradictoires
ne permettent pas l'acquisition.

À défaut de signal audio explicite, une seule clé `*-orig` peut renseigner
la langue. Une langue connue cible sa clé ; sinon un unique candidat original
admissible en JSON3 est accepté. Une contradiction avec une langue connue
est refusée. Une future évolution de ces conventions doit être vérifiée par
des fixtures et un essai manuel.

Référence : [extracteur YouTube de yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py),
notamment `get_language_code_and_preference` et la construction de
`automatic_captions`.

### Acquisition et stockage

L'adapter utilise un dump de découverte temporaire puis `--load-info-json`
pour télécharger la piste sélectionnée sans seconde découverte.
Les options ignorent la configuration locale, évitent le média et imposent
JSON3. Le répertoire temporaire est supprimé à la sortie.

Le JSON3 récupéré est borné à 16 Mio ; les sorties de découverte et diagnostic
sont bornées en mémoire. Le parser valide le document entier avant publication.
Les snapshots complets sont publiés sous des noms uniques, puis référencés
par SQLite. Les anciens fichiers et les éventuels orphelins restent sur disque
pendant cette phase ; aucune API d'historique n'est exposée.

La politique durable archive/cache/récupération à la demande, la configuration
du stockage et le nettoyage restent ouverts. Arrêter de conserver les snapshots
nécessitera de revoir explicitement le contrat de lecture.

## 10. `ffmpeg`

`ffmpeg` est attendu pour les opérations média.

Usage principal identifié :

```text
MediaFile + timestamp
        ↓
      ffmpeg
        ↓
    screenshot
```

Il peut aussi être utilisé par `yt-dlp`.

Le téléchargement local peut être temporaire si cela simplifie le travail sur la vidéo.

## 11. Docker

La première forme du produit est un conteneur Docker self-hosted.

Le déploiement doit rester simple.

Les dépendances externes nécessaires telles que :

- `yt-dlp` ;
- `ffmpeg`

devront être incluses ou installées de manière reproductible dans l'image.

Les données persistantes sont externalisées via volume.

## 12. API REST

Le contrat Notes + Tags est validé mais non encore disponible. Il est décrit
dans [l'architecture](03-architecture.md), section « API Notes + Tags » :
lecture/enregistrement de la note, catalogue et associations de tags,
enveloppe `tags`, ordre `id` croissant, tags dans les réponses vidéo et filtre
facultatif `tag_id`. Les points suivants décrivent la tranche vidéo existante.

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

## 13. MCP

### Décision architecturale

MCP est une interface vers les services applicatifs.

Le serveur MCP ne doit pas effectuer des appels HTTP vers sa propre API lorsqu'il tourne dans le même processus.

Architecture :

```text
REST ───┐
        ├──► Application Services
MCP ────┘
```

### SDK

Le SDK Go officiel est le choix privilégié.

### Timing

L'implémentation MCP peut venir après la stabilisation des cas d'usage principaux.

## 14. IA

### Principe

L'application est conçue pour être IA-native.

Cela signifie :

- données structurées ;
- outils métier ;
- API ;
- MCP ;
- possibilité de lire et d'agir.

Cela ne signifie pas que toutes les fonctionnalités appellent un LLM.

### Fournisseurs

Aucun fournisseur n'est encore décidé.

L'architecture doit éviter de dépendre directement d'OpenAI, Ollama ou d'un autre fournisseur dans le domaine.

## 15. Frontend

Le frontend n'est pas encore choisi.

Contraintes connues :

- interface Web dans la première version ;
- page vidéo orientée travail ;
- interaction étroite avec un player ;
- éditeur Markdown ;
- timestamps interactifs ;
- bibliothèque visuelle ;
- API REST comme backend.

Le MVP n'exige pas un design sophistiqué.

Ne pas considérer React comme acté tant qu'une décision explicite n'a pas été prise.

## 16. Desktop

La version desktop n'est pas prioritaire.

Wails est une piste naturelle à étudier car le backend est en Go et l'UI peut utiliser des technologies Web.

Aucune décision n'est prise.

L'architecture actuelle doit seulement conserver cette option ouverte.

## 17. Stockage filesystem

Organisation conceptuelle :

```text
/data/
├── sillage.db
├── media/
├── assets/
└── transcripts/
```

Principes :

- SQLite contient les entités, relations et métadonnées structurées nécessaires ;
- les médias et assets restent sur le filesystem ;
- une transcription peut posséder facultativement un snapshot source sur le filesystem ;
- la BDD conserve alors son chemin ;
- l'absence de fichier local ne supprime pas l'identité du `Transcript` ;
- le nom de fichier n'est jamais la seule source d'une information métier importante.

## 18. Données temporelles

Sillage distingue les positions temporelles dans un média des dates calendaires.

### Positions et durées dans un média

Décision :

```text
stockage canonique = INTEGER en millisecondes
```

Exemples :

```text
start_ms
timestamp_ms
duration_ms
```

Raisons :

- représentation simple ;
- précision suffisante ;
- comparaison facile ;
- indépendante du format d'affichage.

Exemples d'affichage :

```text
12:42
18:43.456
01:18:43
```

### Dates calendaires et événements

Les dates telles que :

```text
created_at
updated_at
last_fetched_at
added_at
```

sont stockées dans SQLite sous forme de `TEXT` UTC RFC 3339 à précision milliseconde fixe
(`YYYY-MM-DDTHH:MM:SS.mmmZ`). Le service fournit les dates, sans défaut SQL.

Exemple :

```text
2026-10-06T18:00:00.000Z
```

Dans le domaine Go, elles sont représentées par `time.Time`.

Cette distinction évite de confondre une position dans un média avec la date à laquelle un événement applicatif s'est produit.

## 19. Choix explicitement évités pour le moment

Ne pas introduire sans besoin :

- gros framework backend ;
- microservices ;
- queue distribuée ;
- PostgreSQL ;
- Redis ;
- vector database ;
- ORM lourd ;
- système de plugins complexe ;
- dump brut permanent des métadonnées générales de chaque VideoSource ;
- format JSON propriétaire de transcription sans besoin démontré ;
- persistance relationnelle mot-à-mot des transcriptions ;
- couche repository générique abstraite à l'excès ;
- hiérarchie de sous-types `VideoSource` online/offline ;
- framework de migrations plus riche sans besoin concret.

Le JSON3 de transcription peut en revanche être conservé comme snapshot du contenu source.

## 20. Décisions à revisiter lorsque le besoin apparaît

Rendez-vous explicite à l'étape 5 : réexaminer les écritures concurrentes des
notes avec l'autosauvegarde, les onglets concurrents, la prévention des pertes
de modifications et les éventuels mécanismes de résolution des conflits.
La suppression explicite d'une note reste une évolution UX envisagée,
hors de l'étape 4.

- Goose ou autre outil de migrations dédié ;
- WAL SQLite ;
- stratégie de tests d'intégration avec `yt-dlp` ;
- framework frontend ;
- lecteur vidéo ;
- éditeur Markdown ;
- système de jobs ;
- politique de cache ;
- politique de téléchargement/rétention ;
- provider IA ;
- moteur STT ;
- authentification ;
- packaging desktop ;
- stratégie de backup SQLite ;
- suppression cascade vs soft delete ;
- identité et déduplication d'une source locale ;
- éventuelle relation entre `MediaFile` et sa `VideoSource` d'origine ;
- logging structuré, niveaux et politique de journalisation.
- politique de conservation/cache des transcriptions ;
- stockage configurable des snapshots de transcription ;
- éventuelle sélection explicite d'autres pistes (aucun fallback actuel) ;
- éventuel besoin de persister un identifiant de piste provider distinct de la langue.
