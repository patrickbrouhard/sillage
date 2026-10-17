# Tech stack & decisions

## 1. Objet de ce document

Ce fichier centralise les décisions techniques prises ou fortement privilégiées.

Il doit distinguer :

- **Acté** : décision actuelle à considérer comme référence ;
- **Préféré** : direction choisie, mais encore facile à réviser ;
- **Ouvert** : aucune décision définitive.

Le but est d'éviter que des choix ponctuels discutés dans une conversation deviennent implicitement des contraintes permanentes.

Le statut d'une décision est distinct de son implémentation : une décision actée
peut être différée. Les mentions « implémenté » décrivent le code disponible.

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
| Frontend Web | React, TypeScript et Vite ; SPA sans SSR | Acté pour 5.1 |
| Distribution Web | fichiers statiques servis par Go, avec le binaire dans Docker | Acté |
| Éditeur Markdown | CodeMirror 6 | Intégré directement et testé en 5.2 |
| Références temporelles | début obligatoire, fin facultative, provenance conservée si nécessaire | Orientation actée pour 6 |
| Syntaxe des références | `[12:42](sillage://videos/5/sources/5?start_ms=762345)` | Acté en 6.2 ; `end_ms` réservé |
| Desktop | possibilité future, Wails à évaluer | Ouvert |
| IA intégrée | fournisseur à choisir | Ouvert |
| STT local | moteur à choisir si besoin | Ouvert |
| `raw_metadata` yt-dlp | ne pas conserver par défaut | Acté |
| Jobs persistants | pas dans le modèle initial | Acté pour le MVP |
| PostgreSQL/MySQL | non nécessaires par défaut | Acté tant qu'aucun besoin ne l'impose |
| WAL SQLite | non décidé | Ouvert |
| Logging structuré / niveaux | log/slog, INFO, stdout ; texte/JSON ; rotation Docker local | Acté, implémentation en cours |
| Dates calendaires | `TEXT` UTC RFC 3339 à millisecondes fixes | Acté |
| Note principale | zéro ou une par vidéo, `video_id` clé primaire, Markdown brut en SQLite `TEXT` | Acté et implémenté pour l'étape 4 |
| Identité des tags | NFC + comparaison Unicode insensible à la casse, accents significatifs | Acté pour l'étape 4, mécanisme technique libre |
| REST des tags | enveloppe `tags`, ordre `id` croissant dans toutes les réponses | Acté et implémenté pour l'étape 4 |
| Écritures concurrentes des notes | révision entière et précondition atomique | Acté pour 5.2 ; remplace le compromis de l'étape 4 |
| Publication et personnes | `Publisher`, `Person`, relations explicites sans rôles | Acté et implémenté à l'étape 4 bis |
| Identité des publishers YouTube | `channel_id` obligatoire, nom facultatif | Acté et implémenté |
| Tags universels | catalogue unique, aucune propagation | Acté et implémenté |
| Associations de tags | tables explicites avec clés étrangères | Choix privilégié, implémenté |
| Migration de `creator` | sauvegarde préalable, suppression sans rapprochement par nom | Acté et implémenté |
| Contrat vidéo REST | objet `publisher: {id, name}` nullable et `person_ids` directs | Rupture de `/api/v1` validée et implémentée |

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

Depuis l'étape 4, `Tag` a un identifiant entier stable généré
par SQLite. `Note` n'a pas d'identifiant propre : `video_id` est à la fois
sa clé primaire et sa référence vers `Video`.

Ils pourront être reconsidérés si des contraintes futures d'import/export, synchronisation ou distribution apparaissent.

### 5.3 Schéma SQLite initial

Le SQL ci-dessous décrit la migration historique `0001`, pas le schéma courant.
La migration `0004_publishers_persons.sql` supprime notamment `creator`.

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

La migration `0003_notes_tags.sql` ajoute les notes, tags et associations
sans perte des données existantes. L'étape 4 est implémentée. Ne pas anticiper :

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
sections 5 et 9. Ils sont actés et implémentés.

- Stocker le Markdown dans une colonne `TEXT`, sans parsing ni rendu ; le service
  normalise uniquement CRLF et CR en LF avant sauvegarde. La relecture restitue
  le contenu stocké sans modification, y compris pour les anciennes notes.
- Distinguer note absente et note vide ; conserver les dates lors d'une sauvegarde
  identique et utiliser UTC à précision milliseconde pour les modifications effectives.
- Garantir en persistance l'unicité concurrente des tags selon leur identité
  NFC et insensible à la casse, ainsi que l'unicité des associations.
- Conserver les accents et la casse d'affichage initiale ; exclure NFKC,
  suppression d'accents et rapprochements sémantiques.
- Rendre atomiques les créations de tags et leurs associations pour un ajout multiple.
- Conserver les tags devenus inutilisés ; ne pas introduire de quota métier arbitraire
  de tags par vidéo.

Choix locaux d'implémentation, révisables :

- `golang.org/x/text` fournit NFC et le repli complet de casse Unicode,
  indépendant de la locale ; la clé est `NFC(Fold(NFC(nom sans espaces aux extrémités)))` ;
- la colonne `tags.identity_key` porte une contrainte unique SQL ; le nom affiché
  conserve sa casse et ses caractères après suppression des espaces aux extrémités ;
- ce repli assimile aussi `Straße` et `STRASSE`, ainsi que les variantes du sigma grec ;
  il ne réalise aucune normalisation de compatibilité NFKC ;
- `video_tags` a une clé primaire composée et un index pour le filtre par tag ;
- les transactions immédiates existantes sérialisent les sauvegardes de notes
  et les ajouts/retraits d'associations ; les sauvegardes identiques ne font aucun UPDATE ;
- `note.Service` et `video.TagService` restent indépendants des adapters.

Le contrat et les limites des requêtes sont documentés dans `03-architecture.md`.
Un changement de règle d'identité Unicode devra examiner les collisions entre
tags déjà persistés ; remplacer le mécanisme technique doit préserver cette règle.

La dernière écriture gagnante était le compromis de l'étape 4, remplacé en 5.2
par la révision attendue et sa vérification atomique, y compris à la création.
L'autosauvegarde et la résolution explicite des conflits réutilisent cette garantie.

### 5.7 Publishers, personnes et tags universels — étape 4 bis

Les décisions conceptuelles figurent dans le modèle métier, sections 3.10,
3.11 et 9. Leur implémentation ajoute `publishers`, `persons`, `video_persons`,
`publisher_tags` et `person_tags`. La source conserve uniquement `publisher_id`,
nullable ; le nom appartient à `publishers` et peut être NULL.

Les identités internes utilisent les conventions entières existantes.
`UNIQUE(provider, external_id)` protège les comptes, les clés composées protègent
les associations et les clés étrangères garantissent leurs références. Des triggers
renforcent la cohérence du provider source–publisher et l'immutabilité de l'identité
externe des publishers. Aucune suppression d'entité n'est exposée.

Le catalogue `tags` et sa clé Unicode sont inchangés. Les nouveaux ajouts de tags
sont atomiques, y compris les créations du catalogue, et les retraits conservent
les tags inutilisés. Les services réutilisent la même normalisation.

Avant de migrer une base existante en version 1, 2 ou 3, `Open` crée un snapshot
SQLite complet par `VACUUM INTO`, dans un fichier voisin unique
`<base>.before-publishers-<suffixe>.bak`. Le fichier et son répertoire sont
synchronisés avant migration ; un échec bloque l'ouverture. Les sauvegardes
précédentes ne sont jamais écrasées. Arrêter les anciens processus avant la mise
à niveau : la sauvegarde et les migrations sont deux opérations distinctes.

La migration est locale et transactionnelle. Elle préserve les identifiants et
les autres données, supprime `creator` et laisse les sources existantes sans
publisher. Aucun réseau ni déduction par nom. Les anciens libellés restent dans
la sauvegarde, pas dans la base migrée. Une base neuve n'a pas besoin de sauvegarde.
La réouverture d'une base déjà migrée ne produit pas de nouvelle sauvegarde.

Le rattachement des anciennes sources passe par les mêmes opérations explicites
que les nouvelles. Aucun backfill, rafraîchissement ou rapprochement automatique
n'est inclus. Le runner existant est conservé ; aucune dépendance n'est ajoutée.

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
publisher_id?
duration_ms?
thumbnail_url?
```

`external_id` et `canonical_url` peuvent être facultatifs pour de futures provenances. Pour YouTube, ils sont obligatoires.

L'identité du publisher YouTube est extraite exclusivement de `channel_id`.
Le nom `channel`, ou à défaut `uploader`, n'est utilisé qu'après identification
fiable. L'adapter refuse les handles et les noms comme identifiants ; les
métadonnées de collaborations ne sont pas exploitées.

La résolution d'une URL de chaîne utilise yt-dlp avec `--flat-playlist` et
`--playlist-items 0`, sans téléchargement média ni parcours du catalogue complet.
Les URLs `@handle`, `/channel/…`, `/user/…` et `/c/…` sont normalisées vers la
racine de chaîne. Le résultat doit être une extraction `YoutubeTab` avec un
`channel_id` valide. Sortie limitée à 4 Mio, diagnostic à 16 Kio, contexte HTTP
borné par `SILLAGE_POST_TIMEOUT`. Ces limites et options sont des choix locaux
révisables. Référence technique :
[extracteur YoutubeTab de yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_tab.py).

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
laissent la langue audio inconnue, sans interdire l'acquisition d'une caption.

Les captions ne renseignent jamais la langue audio, à l'import comme à
l'acquisition. La langue audio enregistrée donne priorité à sa clé `*-orig`
exacte admissible, puis à la clé générique pour une forme simple `langue-région`
(région de deux lettres ou trois chiffres). Aucune simplification des écritures,
variantes ou étiquettes complexes. À défaut, un unique candidat `-orig` admissible en JSON3
est accepté, même dans une autre langue. Plusieurs candidats sans correspondance
exacte ou régionale donnent `409 transcript_selection_ambiguous`, aucun candidat donne
`404 transcript_not_available`. La redétection audio ne départage pas les pistes.
Une future évolution de ces conventions doit être vérifiée par des fixtures
et un essai manuel. Aucun changement de schéma ni de l'identité des transcriptions.

Le marqueur `-orig` peut aussi désigner des captions d'un audio doublé.
La politique privilégie donc l'audio original sans en garantir la correspondance,
notamment lors du repli accepté sur une piste unique d'une autre langue.
L'interface emploie « Transcription automatique » plutôt que « Automatique originale ».

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

La conservation complète de 7.1 est volontaire et durable. Une acquisition technique
temporaire pour une capture reste distincte et n’autorise pas une conservation
complète automatique. L’extraction distante demeure une candidate à évaluer.

## 11. Docker

La première forme du produit est un conteneur Docker self-hosted.

Le déploiement doit rester simple.

Les dépendances externes nécessaires telles que :

- `yt-dlp` ;
- `ffmpeg`

devront être incluses ou installées de manière reproductible dans l'image.

Les données persistantes sont externalisées via un bind mount configurable.

## 12. API REST

L'étape 4 bis supprime `creator` de `/api/v1` sans alias de compatibilité et ajoute
un objet `publisher` minimal aux sources ainsi que les `person_ids` directs aux
vidéos. La rupture est explicite. Les nouveaux contrats sont documentés dans
`03-architecture.md`, section « API Publishers + Personnes ».

Le contrat Notes + Tags est implémenté et disponible. Il est décrit
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

### Décisions actées

- React, TypeScript et Vite pour une SPA consommant REST ;
- React Router en mode déclaratif pour les parcours du jalon 2, sans SSR ;
- Go sert les fichiers compilés livrés avec le binaire dans la même image Docker ;
- aucun SSR ni serveur Node.js permanent, accès local par défaut sans auth ;
- note Markdown principale et stable, transcription indépendante du lecteur ;
- lecteur flexible, masquable puis potentiellement redimensionnable/détachable ;
- en 5.3 : IFrame Player API YouTube directe, pause avant masquage, source commune
  lecteur/transcription et regroupement temporel de présentation sans changement REST ;
- stockage Markdown brut, extensions internes autorisées ;
- références temporelles avec début obligatoire et fin facultative, provenance
  conservée lorsque nécessaire ; insertion rapide et citation partagent la notion ;
- copie ordinaire préservant les informations utiles ; copie adaptée et export
  de consultation distincts d'une sauvegarde métier réimportable.

### Références Markdown — décision 6.2

Le format acté est `[12:42](sillage://videos/5/sources/5?start_ms=762345)`.
`videos` est une autorité logique, pas un segment du chemin. Les identifiants
vidéo/source sont toujours explicites pour conserver la provenance après copie
entre notes de la même base. Le format ne dépend pas de l'hôte Web, mais ne résout
pas les identités entre bases indépendantes. Pas de versionnement ni de protocole
système enregistré. `start_ms` conserve les millisecondes ; le libellé `m:ss` ou
`h:mm:ss` reste une présentation. `end_ms` est réservé aux futures plages.

Insertion par transaction CodeMirror isolée dans l'historique, après la sélection
sans remplacement, puis focus rendu. L'autosauvegarde et la persistance opaque
existantes restent seules responsables de l'enregistrement. Aucun changement
REST/SQLite, aucune Annotation ni nouvelle dépendance. Le temps est lu au clic,
sans synchronisation continue et sans commande au lecteur. Seuls lecture, pause
et fin avec position valide sont acceptées ; les états transitoires, non démarré
et cued sont refusés. Le rendu Lecture, initialement inerte, est activable depuis 6.5.

### Préférences révisables

CodeMirror 6 est intégré directement en 5.2, avec lecture react-markdown et remark-gfm.
La première source REST sert provisoirement à présenter les cartes en 5.1,
sans devenir une règle métier de source principale.

### Questions ouvertes

Bibliothèques complémentaires selon les besoins, layout final, rendu enrichi des références,
copie adaptée et formats d'export/sauvegarde. Ces questions ne justifient pas
d'anticiper les étapes 5.2, 5.3 et 6 en 5.1.

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

Après l'étape 4 bis : politique explicite de rafraîchissement des publishers
(y compris compléter un nom absent), suppression des entités et traitement de
leurs références, identification des comptes d'autres providers. Les rôles,
organisations et collaborations détaillées ne sont pas des exigences acquises.

La concurrence et l'autosauvegarde des notes sont traitées en 5.2.
La suppression explicite d'une note reste une évolution UX envisagée, hors de 5.2.

- Goose ou autre outil de migrations dédié ;
- WAL SQLite ;
- stratégie de tests d'intégration avec `yt-dlp` ;
- lecteur vidéo ;
- système de jobs ;
- politique de cache ;
- préférences avancées de téléchargement ; la conservation volontaire de 7.1 est actée ;
- provider IA ;
- moteur STT ;
- authentification ;
- packaging desktop ;
- stratégie de backup SQLite ;
- suppression cascade vs soft delete ;
- identité et déduplication d'une source locale ;
- évolution vers plusieurs représentations d’une source, au-delà de l’unicité de 7.1 ;
- extensions futures de journalisation uniquement selon un besoin concret.
- politique de conservation/cache des transcriptions ;
- stockage configurable des snapshots de transcription ;
- éventuelle sélection manuelle de pistes, au-delà de la sélection automatique originale actuelle ;
- éventuel besoin de persister un identifiant de piste provider distinct de la langue.

## Jalon 3 Web — décisions d'intégration

Les contrats REST existants suffisent : catalogue global, ajout par noms,
retrait par ID et filtre vidéo unique. React Router porte le filtre dans l'URL.
Les mutations sont successives ; le POST fournit les associations à afficher,
le DELETE est suivi d'une relecture. Les réponses tardives doivent être ignorées.
Une erreur de catalogue conserve les données disponibles ; un échec de relecture
après écriture réussie doit être distingué d'un échec d'écriture.

La modale contient un éditeur de tags vidéo indépendant de sa présentation.
L'implémentation utilise un dialogue HTML natif et une combobox locale suivant
le modèle WAI-ARIA (listbox, sélection par flèches, aria-activedescendant,
Entrée et Échap). Aucune dépendance supplémentaire. L'éditeur reste séparé du
conteneur, monté à sa fermeture pour laisser aboutir les mutations en cours.
La recherche des propositions est une comparaison de présentation simple,
sans reproduction de la normalisation métier Go.
Référence : https://www.w3.org/WAI/ARIA/apg/patterns/combobox/.
Les descriptions privilégient les éléments natifs `details` et `summary`.
Le futur volet de gestion et le panneau de métadonnées sont des préférences
révisables, sans architecture anticipée ni synchronisation entre onglets.

## Distribution Docker — décisions du jalon 4

Décisions actées :

- build multi-stage React/Vite et Go, depuis les seules sources du dépôt ;
- image finale Debian slim, Linux AMD64, Go et frontend compilé réunis ;
- yt-dlp autonome officiel `yt-dlp_linux`, version stable explicite, et Deno ;
- téléchargements versionnés vérifiés par SHA-256 ; ffmpeg, ffprobe, CA et
  bibliothèques système nécessaires présents, sans Python système ni Node permanent ;
- `WORKDIR /app`, données dans `/app/data`, bind mount vers un répertoire hôte
  explicite et configurable ; aucune migration automatique des données locales ;
- utilisateur non-root, UID/GID adaptés au propriétaire du bind mount, sans
  modification récursive des permissions au démarrage ;
- écoute interne `0.0.0.0:8080`, publication sur `127.0.0.1` par défaut,
  absence d'authentification ; arrêt gracieux compatible avec les 10 s du serveur ;
- sauvegarde et restauration à froid de tout le répertoire persistant ;
  jamais deux instances Sillage sur la même base ;
- mise à jour de yt-dlp uniquement par reconstruction avec version et empreinte
  explicites, y compris une nightly corrective choisie ; aucun téléchargement
  automatique au démarrage et aucun binaire modifiable par l'application ;
- validation Docker indépendante en CI, données temporaires isolées, vrais outils
  testés séparément du parcours REST déterministe sans YouTube réel.

Question ouverte : un exécutable yt-dlp externe persistant pourrait être sélectionné
explicitement plus tard, éventuellement depuis les paramètres. La préférence est
de garder la version stable intégrée comme repli, avec activation volontaire d'une
autre version. Sélection, vérification, permissions, mises à jour et retour arrière
restent à définir ; aucun mécanisme d'override n'est implémenté au jalon 4.

## Étape 5.2 — décisions et implémentation

Décisions actées : révision entière dans le modèle et JSON, expected_revision
obligatoire (0 = absence attendue), 409 en cas de conflit, sans ETags.
Markdown préservé hors normalisation LF, GFM sécurisé sans HTML brut, bascule source/lecture, sauvegarde
après 2 s d'inactivité et maximum 20 s de saisie continue. Les règles UX et de
réconciliation réseau sont détaillées dans Product & UX et Architecture.

Choix techniques implémentés : CodeMirror 6 intégré directement ; react-markdown
avec remark-gfm et HTML brut ignoré ; data router React Router pour bloquer les
navigations. Le maintien de l'éditeur monté préserve son état entre les modes.
La décision initiale de préserver exactement LF/CRLF est remplacée : LF est
canonique pour les notes. CRLF et CR sont normalisés avant persistance dans le
service applicatif, sans transformation des autres caractères. CodeMirror utilise
son traitement natif des séparateurs, notamment lors des collages Windows.
Pas de migration des notes temporaires existantes ni de modification par GET.
L'ancienne version reste inchangée jusqu'à un enregistrement explicite ou une
édition suivie d'autosauvegarde. La session compare en LF pour éviter toute
écriture due à la seule ouverture ou au départ de la fiche. Révisions, conflits,
réconciliation après réponse perdue et Undo/Redo sont conservés et testés.

Choix locaux révisables : délai réseau de 12 s, deux reprises après 1 puis 3 s,
composants et messages. La vérification automatique locale est réussie ;
le périmètre fonctionnel est également validé manuellement. Les résultats CI
du dernier commit sont consultables dans GitHub Actions.

Aucun historique, File Recovery, brouillon persistant, synchronisation temps réel
ou mécanisme générique documentaire. Le cadrage 5.3 est désormais implémenté
(voir Product & UX et Architecture). Les tranches 6.1 à 6.5 sont implémentées ;
plages et navigation entre vidéos/sources restent futures.

### Recherche locale dans la transcription — tranche 6.3

Décisions implémentées en 6.3 : recherche textuelle insensible à la casse dans le contenu déjà
chargé, sans requête supplémentaire. Le texte continu concatène exactement les
fragments dans l'ordre source, sans séparateur ajouté ni modification des blancs.
Les expressions et mots peuvent traverser plusieurs fragments et blocs visuels.
Champ, compteur, précédent/suivant circulaires, surlignage de toutes les occurrences
avec distinction du résultat actif et défilement vers celui-ci.
Changer de vidéo ou de source réinitialise la recherche.
La navigation des résultats ne commande jamais le lecteur : les timestamps
cliquables restent l'action explicite pour rejoindre un instant.
Le regroupement existant est conservé à 10 secondes fixes, sans sélecteur,
préférence utilisateur ni configuration. Fragments, timestamps et ordre inchangés.
Aucun endpoint, changement du domaine, de la persistance ou moteur global.
Acquisition, actualisation, édition des notes et insertion temporelle conservées.
La segmentation naturelle, la synchronisation continue, les citations (6.4)
et la navigation depuis le Markdown restent hors périmètre.

### Citation 6.4 — décisions du 14 octobre 2026, implémentées

Extraction et copie de texte continu depuis une sélection native de transcription ;
blancs réduits seulement dans l'extrait, timestamps exclus, mark transparents.
Bouton stable, position d'insertion explicitement choisie pour les notes non vides,
transaction CodeMirror isolée et autosauvegarde existante. Citation Markdown littérale,
référence sillage:// avec start_ms du premier fragment retenu, sans end_ms.
Le format initial avec référence séparée est remplacé par l'en-tête quote:tr en UX 1.1,
sans conversion des notes existantes. Aucun objet métier, endpoint, dépendance ou changement de persistance.
Bouton flottant, sélection personnalisée et plages différés. Navigation vers le
lecteur courant livrée en 6.5, sans changement de vidéo/source.

Les copies passent par l'événement natif copy et n'exigent pas de permission
presse-papiers. L'extrait est invalidé quand le rendu change et consommé lors
de l'action. Les gestes explicites dans CodeMirror sont distingués des focus
automatiques ; les séparateurs réutilisent les LF adjacents sans retirer de texte.
Limites acceptées : insertion textuelle dans les contextes Markdown complexes,
autoliens GFM ordinaires, sélection au clavier via les capacités natives du
navigateur. Les retours manuels sont satisfaisants ; l'échappement a été réduit
au contexte Markdown utile et Ctrl+Shift+Z ajouté à la keymap CodeMirror.
Le bilan de clôture et les confirmations clavier par plateforme sont dans la roadmap ;
la présentation plus naturelle du Markdown reste une piste UX, pas un choix technique.


### Navigation 6.5 — terminée, périmètre fonctionnel validé manuellement

Parseur canonique strict, autorisation react-markdown limitée aux href valides,
bouton natif en Lecture et contrôle des identités dans la fiche. Même commande
que la transcription, défilement instantané conditionnel après réaffichage DOM.
Aucun changement d'éditeur, de dépendance, de contrat REST ou de persistance.
Contrat, tests et checklist dans la roadmap ; détails techniques dans Architecture.

Les liens Web externes des notes s'ouvrent désormais dans un nouvel onglet protégé ;
ce dernier correctif est testé automatiquement et attend sa confirmation manuelle.
Le détail des essais et des limites de validation est centralisé dans la roadmap.

### UX 1.1 — Présentation commune et reconnaissance ciblée

Décision validée : extension Remark limitée à quote et quote:tr, composant React
commun de présentation, validation et interactions propres à chaque forme.
Aucun moteur extensible, registre de types, grammaire de paramètres ou nouvelle
dépendance. Les propriétés de rendu ne constituent pas un modèle métier.
Le corps conserve GFM et les définitions partagées ; les en-têtes connus rejetés
restent inertes, les marqueurs inconnus conservent le Markdown normal.
URI canonique et TimeButton/contrôles 6.5 réutilisés. Provenance déclarée seulement,
contenu librement éditable. Les détails du contrat et des replis sont dans Product & UX.
Les décorations CodeMirror font l'objet d'UX 1.2a, distinct d'UX 1.1.

Complément validé le 15 octobre 2026 : quote:tr accepte un titre facultatif en
texte simple après la parenthèse fermante, séparé par espace/tabulation et limité
à l'en-tête. Un titre absent ou blanc affiche « Transcription ». Ceci remplace
l'interdiction initiale de texte supplémentaire. Le titre reste dans le Markdown,
sans objet métier ; l'insertion automatique continue à ne produire aucun titre.
Validation URI, replis, navigation 6.5 et citations ordinaires inchangés.


### UX 1.2a — Décorations CodeMirror, 15 octobre 2026

Choix : ViewPlugin et décorations de ligne/texte fondées sur l'arbre Markdown
natif. Bordure commune des citations et hiérarchie des deux callouts reconnus ;
syntaxe intégralement visible et éditable. Seul le validateur pur d'en-tête est
partagé avec Remark ; rendu Lecture et Édition restent indépendants.
Pas de dépendance ajoutée, Live Preview, widget, modification du document ou
de la persistance. La représentation compacte des références est réservée à
UX 1.2b, pour tous les liens canoniques, après un cadrage spécifique.

### UX 1.2b.1 — Références compactes ciblées

Décision : remplacer uniquement la représentation des liens temporels directs
monolignes à libellé simple dans CodeMirror. Les widgets ne sont pas des objets
atomiques ; révélation par clic, entrée clavier ou sélection et protection de
la suppression aux frontières. Markdown brut conservé pour les autres formes.
Cette tranche étend UX 1.2a par des remplacements ciblés, sans Live Preview général,
dépendance supplémentaire ni modification de persistance.

Les en-têtes quote:tr restent en source. Leurs URI compactes et toutes les
interactions de navigation en Édition étaient réservées à UX 1.2b.2. Le contrat 6.5
n'était donc pas étendu à l'Édition par UX 1.2b.1.


### UX 1.2b.2 — Navigation en Édition et URI des callouts

UX 1.2b.1 est validée manuellement. La tranche suivante compacte l'URI des seuls
en-têtes quote:tr admissibles, parenthèses conservées et timestamp calculé.
Ctrl/Cmd+clic et Mod-Enter délèguent au callback 6.5 existant, en conservant
l'éditeur et sa sélection. Cette décision remplace la restriction historique
« Lecture seulement » pour les formes reconnues en Édition ; elle n'élargit pas
la grammaire des liens ordinaires prise en charge par UX 1.2b.1.
Le pictogramme ◷ reste inchangé. Aucun domaine, REST, stockage ou moteur générique.


## Téléchargement 7.1 — correctif implémenté

Vidéos YouTube terminées, vidéo et audio sans réencodage ni modification volontaire
de timeline. Le correctif validé délègue le classement à yt-dlp avec -S "res:1080",
sans --format-sort-force : préférence 1080 ou moins, repli supérieur possible.
Aucune préférence MP4 propre à Sillage ni liste fermée de codecs/conteneurs.
Le conteneur final peut notamment être MP4, WebM ou MKV ; sa conservation ne
garantit pas sa lecture par un futur lecteur Web.
Sillage accepte la sélection audio native, y compris un doublage ou l'audio
d'un format combiné ; l'identification certaine de l'original n'est plus requise.
La politique des transcriptions et original_audio_language reste inchangée.
ffprobe contrôle le résultat complet avant publication.

Une seule invocation réalise extraction, sélection et acquisition ; les configurations utilisateur sont ignorées.
Aucune playlist, reprise automatique, coupe ou omission de fragment.
Les réessais réseau/fragments restent bornés à 3, l'attente socket à 30s,
et l'ensemble au délai du service. Aucun catalogue de codecs n'est introduit.

Tolérance de durée : max(1 seconde, min(3 secondes, 0,1 % de la référence)).
Comparer durée distante actuelle exploitable et durée stockée si connue, sans rafraîchissement.
La validation n'est ni un checksum, ni une preuve d'identité, ni un décodage intégral.
Les tests locaux génèrent MP4, WebM, MKV et MOV avec ffmpeg, puis les valident
avec ffprobe. Les précédents essais MP4 restent des observations historiques ;
la nouvelle sélection a produit un WebM AV1/Opus dans Docker.

Le rapprochement ne supprime aucun fichier abandonné : médias complets sans référence,
.pending et .deleting non référencés sont conservés et signalés. Une restauration
d'ancienne base ne doit jamais transformer les fichiers récents en données jetables.
Une opération vivante nettoie ses temporaires ; une suppression explicite peut
effacer les octets après confirmation SQL. Aucun effacement compensatoire après
publication. Une anomalie média isolée n'interdit pas l'accès à la connaissance.

### Sélection native et contrôles du correctif

Acquisition simplifiée implémentée : bv*+ba/b, res:1080,
une seule piste audio et vidéo. Le filtrage audio et le JSON réinjecté sont supprimés.
Les filtres natifs vérifient l'identité YouTube attendue et le statut terminé
avant acquisition. Des sorties JSON minimales pre_process et after_move décrivent
le statut, la durée distante éventuelle, la sélection audio et le chemin final.
Aucun catalogue de formats, URL temporaire ou JSON brut n'est persisté.
Une durée distante inconnue est admise ; une durée disponible et la durée stockée
sur VideoSource restent comparées au fichier local. Les autres contrôles temporels
(start_time, durées par flux) et le refus des flux auxiliaires restent inchangés.

audio_language provient exclusivement de la représentation audio sélectionnée
par yt-dlp (membre audio de requested_formats, ou format combiné), jamais de la
langue globale agrégée, de ffprobe ou de VideoSource.original_audio_language.
Les compléments internes de yt-dlp, y compris issus de captions, sont acceptés.
Valeur absente ou inexploitable : NULL. Une différence avec l'original n'est pas
une erreur. Les codecs, dimensions et FPS moyens proviennent de ffprobe.
Aucune égalité technique systématique entre yt-dlp et ffprobe n'est exigée.

ffprobe doit reconnaître le conteneur et exactement une piste vidéo et une audio,
avec codecs identifiés, dimensions positives, taille réelle et durée cohérente.
Il n’y a plus de plafond dimensionnel ni de liste de codecs admis. Des alias de
démuxeurs sont normalisés ; le DocType EBML distingue MKV de WebM.
Une extension de sortie inconnue dont le conteneur ne peut pas être confirmé
échoue explicitement plutôt que d’enregistrer une métadonnée approximative.
Le nom interne garde une extension technique sûre : 1 à 32 caractères ASCII,
premier caractère alphanumérique minuscule, puis lettres minuscules, chiffres,
tiret ou underscore. Cette sécurité de chemin ne définit pas le modèle métier.

Le sélecteur natif peut privilégier ses critères hasvid/ie_pref avant res:1080.
La préférence de résolution ne signifie ni limite de taille, ni essai systématique
de toutes les autres qualités après un échec. La version yt-dlp reste épinglée
dans Docker ; les tests CI installent cette même version et exercent le vrai
sélecteur sur des métadonnées synthétiques, sans accès YouTube.

La cadence moyenne est lue dans avg_frame_rate : rapport numérique fini et positif,
sinon NULL. Les chaînes de codecs sont celles de ffprobe. Les six nouveaux attributs
sont nullable en migration 0008 ; aucun examen des anciens octets au démarrage.
Une langue yt-dlp absente, mal formée ou indéterminée (und, mul, zxx, sans distinction
de casse) devient NULL. Les sous-étiquettes déclarées ne sont pas inventées.
Le téléchargement n'émet plus media_audio_ambiguous ni media_format_unavailable ;
un échec de sélection/acquisition natif devient download_failed, sans analyse de stderr.

## Captures vidéo — étape 7.2 implémentée

- PNG uniquement, sans redimensionnement volontaire ni encodage avec perte
  supplémentaire. La source reste une vidéo généralement déjà compressée.
- Local prioritaire uniquement pour la même VideoSource, avec emprunt protégé
  contre la suppression. Aucun fichier partiel n'est utilisé.
- Distant : résolution yt-dlp fraîche à chaque capture, sélection vidéo `bv*`
  avec classement `res,width,height,proto` et `--format-sort-force`, sans plafond 1080p.
  La résolution puis les dimensions passent avant le protocole : HTTPS gagne à
  dimensions identiques, même si l'extracteur préfère HLS. Ce classement forcé
  est réservé aux captures ; la politique de téléchargement 7.1 reste inchangée. Les en-têtes nécessaires sont
  transmis à ffprobe/ffmpeg ; URL signées et en-têtes ne sont ni persistés ni
  journalisés. Pas de cache vidéo conservé. Selon le protocole/serveur, le trafic
  nécessaire au probe et au seek peut néanmoins être important.
- Seek d'entrée `-ss` avec `-accurate_seek`, décodage réel, une frame PNG.
  Aucun stream copy ni sélection approximative de la seule image clé précédente.
  Les tests sur GOP long vérifient aussi les instants proches d'une transition :
  la première frame à partir de la cible peut être la suivante, donc décaler le
  résultat jusqu'à l'intervalle entre deux frames. Ce n'est pas une garantie
  d'identité avec l'image effectivement affichée par l'iframe YouTube.
- Les timestamps hors durée connue et les positions sans frame échouent
  explicitement ; on ne remplace pas silencieusement la cible par la dernière
  image, notamment en fin de lecture.
- Rotation : autorotation native de ffmpeg. Pixels non carrés : refus explicite,
  car leur correction exigerait un redimensionnement ou une interprétation du
  rapport de pixels que le rendu PNG Web ne garantit pas.
- SDR converti en RGB24. HDR identifié par PQ/HLG : conversion en BT.709 avec
  zscale et tone mapping Hable. Ce choix de rendu n'est pas une conservation HDR
  ni une garantie de reproduction du tone mapping YouTube. Des métadonnées
  absentes/incorrectes ou un ffmpeg sans filtres requis peuvent faire échouer
  l'extraction ; aucun PNG HDR incorrect n'est volontairement publié comme tel.
- Limites de protection : sortie de sous-processus bornée à 64 Mio, validation
  PNG à 100 millions de pixels, durée d'opération de deux minutes. Ces bornes
  provoquent un échec explicite et ne redimensionnent jamais l'image.
- Une capture globale par instance serveur, indépendante du téléchargement,
  sans queue. Les intents et états sont persistants ; aucune infrastructure
  générique de jobs, reprise automatique ou suppression d'orphelins.
- Clé de commande UUID générée au clic : récupération par clé puis éventuel POST
  avec la même clé après réponse incertaine. Aucune clé n'est déduite du timestamp.
- Lecture Markdown : référence interne par ID, suivi toutes les deux secondes
  tant que pending ou en erreur de consultation, partagé entre les occurrences
  montées. L'état de génération reste indépendant de l'accessibilité du fichier.

Les logs distinguent extraction/repli, publication et finalisation. Le détail
stderr des outils n'est pas exposé afin d'éviter la fuite d'URL signées ; il n'y a
pas d'interface de diagnostic. La galerie, les captures concurrentes, les réglages
qualité, les interactions temporelles et les indicateurs globaux restent futurs.

Validation : tests déterministes FFmpeg sur transitions à GOP long, résolution,
PNG, HDR PQ et pixels non carrés ; tests applicatifs de repli sélectif,
interruption, concurrence, conservation après commit SQL incertain ; parcours
navigateur de l'éditeur et de sa session. Le test distant facultatif se lance avec
`SILLAGE_CAPTURE_YOUTUBE_TEST=1 go test ./internal/adapter/ytdlp -run TestCaptureYouTubeIntegration -v`.
Un essai réel a produit un PNG 320 × 240 à 1,5 s en environ 2,3 s.
La CI ne dépend pas de cet essai réseau. La comparaison visuelle avec le lecteur
sur des transitions rapides, la VFR, les longs médias, la rotation, le HLG et la
4K/HDR réelle restent à vérifier manuellement.

Validation de distribution : build Docker et smoke test réussis (outils, Compose,
HTTP/SPA, persistance après recréation et arrêt propre). Les 45 requêtes et
135 assertions Postman déterministes existantes passent également.

### Diagnostic distant après les premiers essais manuels

Les essais sur `uJMjlKksSks` à 120 000 ms reproduisent un échec du seek d'entrée
avec ffmpeg 6.1.1 et le format HLS 616 (VP9, 1920 × 1080) : ffprobe lit le flux,
mais le démuxage après seek ne délivre aucun paquet et ffmpeg sort avec zéro
octet, malgré un code de sortie nul. Les segments inspectés ont des timestamps
cohérents. Un décodage depuis le début atteint la cible ; il n'est pas activé
comme contournement, car son coût croît avec la position demandée.

Sur `CcsgednSRfE` à 301 000 ms, l'échec a été reproduit au probe avec HTTP 403
sur le flux HTTPS 401 (AV1, 3840 × 2160), avant le seek. Une autre résolution
a réussi et produit un PNG 4K à cette même position. Cela ne permet pas
d'attribuer avec certitude le premier log générique au même refus réseau.

Les diagnostics distinguent maintenant résolution, probe et décodage, avec
durée et catégorie d'erreur fermée. Aucun stderr brut, URL, cookie ou en-tête
n'est journalisé. Un HTTP 403 au probe/décodage autorise une seule nouvelle
résolution de l'URL et un nouvel essai, dans le délai global existant. Les autres
échecs et les erreurs de stockage ne déclenchent pas ce renouvellement.

Un test déterministe sert une vidéo synthétique par HTTPS avec Range et vérifie
les couleurs à 120 050 et 301 050 ms après des transitions entre images clés.
Le test YouTube facultatif couvre désormais également les deux vidéos signalées ;
le cas HLS reproduit la sortie vide puis vérifie le repli désormais validé.
Après un échec de commande au probe/décodage HLS ou une sortie PNG vide,
un seul flux HTTPS direct de largeur et hauteur strictement identiques peut être
essayé. Les dimensions doivent être connues ; le sélecteur yt-dlp les impose et
sa réponse est vérifiée. Aucun essai à plus basse résolution ni téléchargement
permanent. Une erreur de stockage, un outil absent ou une annulation ne déclenche
pas ce repli. Un HTTP 403 sur l'alternative peut renouveler son URL si ce budget n'a pas
encore été utilisé. Le sélecteur conserve alors strictement ses dimensions.
Le renouvellement d'une URL refusée reste borné à un essai partagé entre le flux
initial et l'alternative : trois résolutions/extractions au maximum ; toutes
les tentatives partagent le délai global de deux minutes.

Cette substitution peut changer codec/débit : elle ne doit pas être assimilée à
une identité parfaite entre représentations. Le seek précis et le timestamp
restent identiques. Le décodage HLS depuis le début n'est pas ajouté.

Validation réelle après correctif : les trois cas passent, dont 1920 × 1080
à 120 000 ms après repli (environ 6,2 s) et 3840 × 2160 à 301 000 ms (environ
4,5 s). Les tests déterministes couvrent le sélecteur contraint, le refus d'une
résolution différente, l'absence de boucle et la non-divulgation des diagnostics.
Ces résultats ne garantissent pas la disponibilité future des URL YouTube ni
l'identité visuelle avec l'iframe.

### Préférence HTTPS à dimensions identiques

Les essais manuels ont montré 81,3 secondes de décodage HLS sans image sur une
capture à 95 140 ms, puis environ 4,5 secondes pour résoudre et extraire son
alternative HTTPS. La sélection privilégie désormais directement HTTPS lorsque
les dimensions sont identiques. Un HLS de résolution supérieure reste éligible ;
le correctif n'introduit ni plafond ni baisse de résolution.

Le tri natif yt-dlp est forcé uniquement pour les captures afin que les
préférences de l'extracteur ne contredisent pas cette règle. `res` classe la plus
petite dimension ; largeur et hauteur départagent ensuite les formats avant
le protocole. Le sélecteur vidéo `bv*` conserve l'exclusion de l'audio seul.
Les différences possibles de codec, débit, cadence et HDR entre représentations
restent le compromis accepté. Priorité locale, seek précis, repli contraint et
budget partagé de renouvellement 403 sont conservés.

Six tests déterministes utilisent le vrai sélecteur yt-dlp avec les arguments de
production et des métadonnées synthétiques : égalité de dimensions avec préférence
extracteur contraire, résolutions supérieures HTTPS/HLS, HLS seul, portrait et
largeurs différentes. Ils ne nécessitent aucune connexion à YouTube.

Validation réelle : la vidéo du test lent (`G2B0YWuJUgI`) produit désormais un PNG
1920 × 1080 à 95 140 ms en environ 4,3 secondes, avec sélection HTTPS immédiate.
Les autres essais passent également : 320 × 240 à 1,5 s, 1080p à 73,479 s et
120 s, 4K à 301 s. Ces mesures ponctuelles ne constituent pas un engagement de
latence ; un HLS seul à la meilleure résolution et les refus 403 restent possibles.


## Journalisation structurée — décisions approuvées

Utiliser directement log/slog, sans interface de logger ni infrastructure
supplémentaire. DEBUG, INFO, WARN, ERROR ; INFO par défaut. Le format text est
le défaut hors conteneur, json celui de Docker. La sortie applicative est stdout.
SILLAGE_LOG_LEVEL et SILLAGE_LOG_FORMAT sont validés au démarrage ; une erreur
de configuration produit un diagnostic JSON de secours sans reprendre sa valeur.

Les succès répétitifs (GET/HEAD, polling et sauvegarde de note) sont DEBUG.
Les commandes et cycles applicatifs sont INFO ; replis et anomalies récupérables
WARN ; échecs définitifs ERROR. Les refus busy ne sont pas des erreurs serveur.
Le bilan HTTP porte un identifiant généré par le serveur, retourné dans
X-Request-ID ; l'en-tête entrant n'est pas repris. Ne pas journaliser les corps,
queries, chemins arbitraires, en-têtes, sorties brutes ou messages d'erreur non
contrôlés, même en DEBUG. Les diagnostics des outils conservent leurs catégories
fermées et codes de sortie. Cette classification ne change aucun réessai métier.

Trois identités : requête HTTP, opération, clé de commande capture existante.
origin_request_id désigne la requête d'acceptation, pas une quatrième identité.
Pas de stockage des journaux ou des identifiants d'exécution en SQLite.

Docker : nom configurable, sillage par défaut ; les tests surchargent ce nom.
Pilote local avec cinq fichiers de 20 Mio, compression par défaut. Le changement
exige une recréation ; la rétention n'est pas un historique durable des connaissances.
