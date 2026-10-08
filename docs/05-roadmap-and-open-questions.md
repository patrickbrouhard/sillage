# Roadmap & open questions

## 1. Principe de développement

Le projet doit avancer par **vertical slices très petits**.

L'objectif est de valider d'abord :

```text
source
  ↓
cœur
  ↓
persistance
  ↓
interface programmable
```

avant d'investir dans une UI complète.

Le logiciel peut donc être fonctionnel très tôt sans interface graphique.

## 2. Étape 0 — Preuve de concept `yt-dlp`

### Objectif

Valider le chemin le plus court entre une URL et un modèle Go.

### Flux validé

```text
URL YouTube
    ↓
yt-dlp
    ↓
JSON externe
    ↓
adapter Go
    ↓
VideoSource normalisée
    ↓
Video
    ↓
sortie JSON
```

### État

Cette étape est terminée.

Les tests couvrent notamment :

- parsing et normalisation ;
- champs optionnels ;
- entrées invalides ;
- erreurs du processus externe ;
- annulation via `context.Context` ;
- arguments transmis à `yt-dlp`.

Les tests de parsing et de processus ne nécessitent ni Internet ni un véritable `yt-dlp`.

Un test réel avec YouTube a également réussi.

### Critère de sortie

Atteint.

Pour une URL YouTube valide, le programme produit un objet Go normalisé correspondant à la vidéo.

## 3. Étape 1 — Modèle + SQLite

### Objectif

Créer la première vraie persistance.

### Flux

```text
URL
 ↓
AddVideo
 ↓
yt-dlp adapter
 ↓
Video + VideoSource
 ↓
SQLite
 ↓
relecture persistante
```

### Décisions prises pour cette tranche

#### Identités internes

`Video` et `VideoSource` utilisent des identifiants internes Sillage :

```sql
INTEGER PRIMARY KEY AUTOINCREMENT
```

Ils ne sont pas dérivés d'un identifiant YouTube ou d'une URL.

#### Identité externe d'une source

Lorsqu'un `external_id` existe, l'identité externe d'une `VideoSource` est :

```text
(provider, external_id)
```

Ce couple est unique en base.

`external_id` et `canonical_url` restent facultatifs dans le modèle générique.

Pour YouTube, ils sont obligatoires au niveau applicatif.

#### Driver SQLite

Utiliser :

```text
database/sql
+
modernc.org/sqlite
```

#### Migrations initiales

Utiliser :

```text
SQL versionné
+
embed.FS
+
PRAGMA user_version
```

avec des migrations forward-only et un petit runner interne.

Goose reste une possibilité à reconsidérer lorsque la base devra être préservée et que les migrations deviendront plus complexes.

#### Schéma initial

La première migration contient uniquement :

```text
videos
video_sources
```

avec :

- contrainte d'unicité sur `(provider, external_id)` lorsque `external_id` existe ;
- index sur `video_sources.video_id` ;
- `duration_ms >= 0` lorsqu'une durée existe ;
- aucune table anticipée pour notes, tags, transcriptions ou médias.

#### `AddVideo`

Le service applicatif :

1. extrait une `VideoSource` normalisée ;
2. cherche une source existante par `(provider, external_id)` ;
3. retourne la `Video` existante lorsqu'elle est déjà enregistrée ;
4. sinon crée `Video` + `VideoSource` dans une transaction.

`AddVideo` ne rafraîchit pas implicitement les métadonnées d'une source existante.

#### Repository

Le port initial est volontairement minimal :

```text
Create
Get
FindBySource
```

Ne pas ajouter `Update`, `Delete` ou `List` avant qu'un cas d'usage concret ne le nécessite.

#### Erreurs

Le repository expose au minimum une erreur stable de type :

```text
ErrVideoNotFound
```

sans exposer directement les détails SQLite au service applicatif.

### Configuration SQLite initiale

- foreign keys activées ;
- `busy_timeout` initial de l'ordre de 5 secondes ;
- WAL laissé ouvert pour plus tard.

### Travail

- ajouter les types d'identité au modèle Go ;
- adapter `Video` et `VideoSource` au modèle persistant ;
- renommer `URL` en `CanonicalURL` ;
- ajouter `modernc.org/sqlite` ;
- créer le premier schéma SQL ;
- implémenter le runner de migrations ;
- implémenter `VideoRepository` ;
- implémenter `AddVideo` ;
- créer une vidéo ;
- détecter une source déjà enregistrée ;
- relire la vidéo depuis la base ;
- tester les contraintes et les cas d'erreur ;
- valider la persistance après réouverture de la base.

### Critère de sortie

Une vidéo ajoutée est persistée et relue après redémarrage.

L'ajout répété de la même source externe retrouve la même `Video`.

## 4. Étape 2 — API HTTP minimale

### État : réalisée

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

## 5. Étape 3 — Transcription YouTube

### État : réalisée

Le flux complet fonctionne via les services applicatifs et REST :

```text
VideoSource
  → découverte de la langue originale et des captions
  → sélection automatique originale
  → JSON3 validé
  → TranscriptContent + snapshot local
  → SQLite
  → POST / GET de la transcription de la source
```

La langue métier (`en`, `pt-BR`) est distincte de la clé yt-dlp (`en-orig`).
`original_audio_language` est facultative sur la source. La sélection refuse
les ambiguïtés et n'introduit aucun fallback.

L'identité est `(video_source_id, language, provenance)`. Une réacquisition
préserve l'ID et actualise le contenu et la date uniquement après succès.
Le POST retourne toujours 200 ; le GET choisit `last_fetched_at DESC, id DESC`
parmi les acquisitions `youtube_auto` et ne contacte jamais YouTube.

Le contenu n'est pas stocké fragment par fragment en base. Le JSON3 est conservé
pour toute cette tranche ; le texte brut est dérivé en mémoire.
La recherche autour d'un timestamp, l'UI multi-transcriptions, le STT et l'IA
restent hors périmètre.

### Validation

Les tests Go déterministes couvrent parser, choix de langue, faux exécutable,
persistance, contraintes, rafraîchissement, concurrence, snapshots et HTTP.
Le faux exécutable reste un helper de test ciblé, pas un simulateur global.
Les essais réels YouTube restent manuels et distincts de la CI.

### Questions ultérieures

- rétention durable, nettoyage des anciens snapshots et des fichiers orphelins ;
- stockage configurable ;
- sélection explicite d'autres pistes ;
- éventuel identifiant de piste provider ;
- évolution du contrat si les snapshots cessent d'être systématiques.

## 6. Étape 4 — Connaissance utilisateur : notes + tags

### État

**Cadrage fonctionnel terminé et validé ; implémentation à réaliser.**
Le code actuel expose les vidéos et les transcriptions, sans notes ni tags.
Les décisions sont réparties entre le [modèle métier](02-domain-model.md),
les [contrats REST et invariants architecturaux](03-architecture.md) et les
[décisions techniques](04-tech-stack-and-decisions.md).

### Objectif

Faire apparaître le vrai produit derrière la bibliothèque vidéo.

### Travail

- zéro ou une note principale par vidéo, identifiée par `video_id`, en Markdown brut ;
- lecture et remplacement par API, création au premier enregistrement, note vide permise ;
- dates UTC à la milliseconde, inchangées lors d'une sauvegarde identique ;
- tags partagés, identité NFC et comparaison Unicode insensible à la casse,
  accents significatifs, sans NFKC ni rapprochement sémantique ;
- ajout additif atomique des tags et associations, retrait de l'association seule ;
- catalogue incluant les tags inutilisés, enveloppe REST `tags`, ordre `id` croissant ;
- tags sur toutes les représentations vidéo et filtre facultatif par un seul `tag_id` ;
- modèle, migrations SQLite, services applicatifs et API REST, sans interface Web.

### Critères de sortie

1. Une note Markdown est récupérable à l'identique après redémarrage, espaces,
   indentation et retours à la ligne compris.
2. Création, modification, sauvegarde identique, note absente et note vide
   respectent le cycle de vie et les dates définis.
3. Les tags sont partagés sans doublons d'identité Unicode ni d'associations,
   y compris en concurrence, et leur casse d'affichage initiale est conservée.
4. L'ajout multiple est atomique, créations de tags comprises ; un échec ne laisse
   aucune création partielle. Le retrait ne détruit pas le tag.
5. Création, réajout, détail et liste des vidéos exposent leurs tags actuels.
   Le filtrage conserve toutes les sources et tous les tags des vidéos sélectionnées,
   ainsi que l'ordre `created_at DESC, id DESC`.
6. Les données utilisateur sont indépendantes de toute acquisition ou actualisation distante.
7. Les opérations traversent les services applicatifs et adapters selon l'architecture existante.

### Compromis et hors périmètre

La dernière écriture gagnante est acceptée provisoirement pour les notes ;
elle devra être réexaminée à l'étape 5, sans mécanisme de conflits dans cette tranche.

Restent hors de l'étape 4 :

- plusieurs notes, suppression explicite, ajout partiel, historique et gestion des conflits ;
- interface Web, éditeur Markdown et autosauvegarde (à étudier à l'étape 5) ;
- parsing/rendu des syntaxes temporelles, timestamps interactifs et annotations structurées (étape 6) ;
- remplacement complet des associations, suppression globale ou renommage des tags ;
- hiérarchies, alias, couleurs et catégories de tags ;
- combinaisons de filtres, recherche textuelle et FTS5 ;
- MCP et génération de tags par IA.

Les limites raisonnables des requêtes et des noms, les validations secondaires
et les détails techniques réversibles seront choisis pendant l'implémentation.

## 7. Étape 5 — UI Web minimale

### Objectif

Créer une interface réellement utilisable sans chercher encore un design avancé.

### Vues minimales

#### Bibliothèque

```text
thumbnail + titre + source + tags
```

#### Page vidéo

```text
player
métadonnées
tags
note Markdown
transcription
```

### Critère de sortie

L'utilisateur peut ajouter, retrouver, ouvrir et travailler sur une vidéo depuis son navigateur.

### Réexamen obligatoire des écritures de notes

Lors des essais de l'interface, réévaluer l'autosauvegarde, les onglets concurrents,
la prévention des pertes de modifications et les éventuels mécanismes de résolution
des conflits. La dernière écriture gagnante de l'étape 4 n'est pas une décision
définitive. La suppression explicite d'une note vidée reste une évolution UX à
évaluer, sans être acquise pour cette étape. Les timestamps interactifs et les
annotations structurées restent réservés à l'étape 6.

## 8. Étape 6 — Workflow temporel

### Objectif

Valider la fonctionnalité différenciante principale.

### Travail

- lire le timestamp courant du player ;
- bouton d'insertion rapide ;
- produire par exemple :

```markdown
[12:42]
```

- reconnaître les timestamps dans les notes ;
- cliquer pour repositionner la vidéo ;
- réfléchir à la première implémentation d'`Annotation`.

### Critère de sortie

Pendant le visionnage, l'utilisateur peut capturer une idée liée au temps sans interrompre son flow.

## 9. Étape 7 — Téléchargement local et screenshots

### Objectif

Permettre un travail plus riche sur le média.

### Modèle à conserver

```text
VideoSource = provenance + métadonnées de source
MediaFile   = représentation physique locale
```

Télécharger une vidéo depuis une source en ligne crée un `MediaFile`, pas une nouvelle `Video`.

Une future source locale pourra coexister avec un `MediaFile`. L'identité exacte d'une source locale reste ouverte.

### Travail

- télécharger une vidéo ou une représentation suffisante ;
- stocker un `MediaFile` ;
- stratégie temporaire ou permanente ;
- appeler `ffmpeg` à un timestamp ;
- créer un `Asset` screenshot ;
- encoder le timestamp dans le nom du fichier ;
- conserver le timestamp canonique en base ;
- insérer le screenshot dans la note ;
- décider si un `MediaFile` doit référencer facultativement la `VideoSource` dont il provient.

### Critère de sortie

Depuis la page vidéo :

```text
Capture
  ↓
image
  ↓
Asset
  ↓
Markdown
```

fonctionne de bout en bout.

## 10. Étape 8 — Recherche

### 10.1 Première version

Recherche simple sur :

- titre ;
- tags ;
- éventuellement notes.

### 10.2 FTS5

Introduire ensuite SQLite FTS5 pour :

- métadonnées ;
- notes ;
- transcription ;
- futurs artefacts textuels.

### Objectif final

Une recherche dans un mot prononcé dans une vidéo doit pouvoir retourner :

```text
Video
+
passage correspondant
+
timestamp
```

et ouvrir le bon passage.
La recherche FTS5 pourra utiliser une représentation textuelle dérivée des transcriptions sans imposer que les fragments temporels soient eux-mêmes des lignes SQLite.

## 11. Étape 9 — MCP

### Objectif

Exposer les cas d'usage métier à des agents externes.

### Outils candidats

```text
search_videos
get_video
get_transcript
get_annotations
add_tags
append_note
```

### Principe

Le serveur MCP appelle les services applicatifs directement.

### Critère de sortie

Un agent externe peut effectuer une requête telle que :

> Trouve mes vidéos sur Proxmox et Tailscale et indique celles dont la transcription parle de subnet routing.

sans accès direct à SQLite ni à `yt-dlp`.

## 12. Étape 10 — IA intégrée

Cette étape est volontairement après les primitives métier et MCP.

Fonctions candidates :

- résumé ;
- tags suggérés ;
- chapitrage ;
- points clés ;
- questions/réponses sur transcription ;
- extraction d'informations.

Les résultats peuvent conduire à une future entité `AIArtifact`.

Le choix du provider reste ouvert.

## 13. Évolutions ultérieures

### Sources vidéo supplémentaires

Le modèle `Video` / `VideoSource` permet d'ajouter :

- Vimeo ;
- autres plateformes ;
- sources Web ;
- fichiers locaux ;
- vidéos déjà téléchargées.

Pour une future source locale, restent notamment à décider :

- son identité ;
- sa stratégie de déduplication ;
- les métadonnées extraites du fichier ;
- la relation exacte avec `MediaFile`.

### STT

Ajouter une transcription à partir de l'audio lorsqu'aucun sous-titre n'est disponible.

Moteur non choisi.

### Extension navigateur

Ajouter une vidéo directement depuis la page source via l'API.

### Desktop

Évaluer une version desktop, potentiellement avec Wails.

### Bibliothèque avancée

Possibilités :

- collections ;
- playlists ;
- favoris ;
- états de lecture ;
- tri avancé ;
- vues sauvegardées.

Aucune de ces fonctions n'est nécessaire au MVP actuel.

## 14. Définition du MVP

Il existe deux jalons utiles.

### 14.1 MVP technique

```text
URL
 ↓
yt-dlp
 ↓
SQLite
 ↓
API
 ↓
transcription
```

Ce jalon valide l'architecture.

### 14.2 MVP produit

Le premier produit réellement utile doit idéalement inclure :

- ajout de vidéo ;
- bibliothèque ;
- page vidéo ;
- lecteur ;
- notes Markdown ;
- tags ;
- transcription ;
- insertion et navigation par timestamp ;
- recherche de base.

Le téléchargement et les screenshots peuvent arriver juste après si leur implémentation ralentit trop ce jalon.

MCP et IA ne conditionnent pas le MVP produit.

## 15. Questions ouvertes — domaine

### 15.1 `Note` vs `Annotation`

Pour l'étape 4, une seule note principale facultative par vidéo est actée.
La concurrence des écritures sera réexaminée à l'étape 5. Les questions suivantes
concernent le workflow temporel de l'étape 6 ou des extensions ultérieures :

- une annotation est-elle toujours distincte du Markdown ?
- peut-on transformer `[12:42]` en annotation forte ?
- comment une annotation apparaît-elle dans la note ?
- un besoin ultérieur justifie-t-il plusieurs notes par vidéo ?
- faut-il des types d'annotations ?

### 15.2 Sources

- comment détecter précisément qu'une nouvelle source d'une autre plateforme correspond à une `Video` existante ?
- quelle politique si une vidéo existe sur plusieurs plateformes ?
- quelle identité et quelle stratégie de déduplication pour une source `local` ?
- faut-il supporter une source `local` dès le MVP produit ou plus tard ?
- faut-il relier un `MediaFile` à sa `VideoSource` d'origine ?

### 15.3 Métadonnées

- liste minimale des futurs champs au-delà de la tranche actuelle ;
- champs rafraîchissables ;
- stratégie de surcharge utilisateur ;
- rafraîchissement manuel ou automatique.

### 15.4 Données temporelles et plusieurs sources

Une même `Video` peut avoir plusieurs `VideoSource` dont les timelines ne sont pas parfaitement synchronisées.

`Transcript` est désormais explicitement rattaché à `VideoSource`.

Pour les autres objets temporels, notamment `Annotation` et certains `Asset`, il reste à déterminer si un rattachement à une source ou à une timeline de référence devient nécessaire lorsque ce scénario sera réellement supporté.

## 16. Questions ouvertes — stockage

Les choix suivants sont désormais actés pour la tranche initiale :

```text
IDs                = INTEGER PRIMARY KEY AUTOINCREMENT
driver SQLite      = modernc.org/sqlite
migrations         = SQL embarqué + PRAGMA user_version
tables initiales   = videos + video_sources
```

Restent ouverts :

- futurs index nécessaires ;
- WAL ;
- politique de sauvegarde ;
- suppression cascade vs soft delete ;
- évolution du runner de migrations vers Goose ou un autre outil ;
- structure des répertoires media/assets ;
- stratégie de migration lorsque la base contiendra des données importantes.
- politique de conservation locale des transcriptions ;
- cache supprimable ou archive durable ;
- emplacement configurable des snapshots, notamment sur un stockage externe ou NAS ;
- comportement lorsqu'un `Transcript` existe en base mais que sa source distante et son snapshot local sont tous deux indisponibles.

## 17. Questions ouvertes — média

- format de téléchargement préféré ;
- qualité par défaut ;
- vidéo complète ou segment temporaire pour screenshot ;
- conservation après travail ;
- audio seul dans certains cas ;
- stratégie de nettoyage ;
- noms de fichiers.

## 18. Questions ouvertes — frontend

- framework ou vanilla ;
- lecteur YouTube ;
- lecteur local ;
- éditeur Markdown ;
- rendu Markdown ;
- layout final de la page de travail ;
- synchronisation player/transcription ;
- comportement des timestamps ;
- timeline d'annotations ;
- raccourcis clavier.

## 19. Questions ouvertes — API

Le contrat de la tranche initiale est arrêté (voir étape 2 et README).
Restent pour des tranches futures : pagination, filtres, tris configurables
et authentification éventuelle.

## 20. Questions ouvertes — MCP

- outils exacts ;
- resources MCP éventuelles ;
- granularité lecture/écriture ;
- permissions ;
- confirmation de certaines actions ;
- mode de transport ;
- mapping entre erreurs métier et erreurs MCP.

## 21. Questions ouvertes — IA

- provider intégré ;
- interface commune aux providers ;
- conservation des prompts ;
- conservation des résultats ;
- versionnement/régénération ;
- provenance ;
- validation des tags générés ;
- embeddings ou non ;
- limites de contexte sur longues transcriptions.

## 22. Questions ouvertes — produit

- identité visuelle ;
- packaging ;
- licences ;
- import/export ;
- stratégie de backup ;
- éventuel support multi-utilisateur.

## 23. Règle de priorité

Quand plusieurs directions sont possibles :

1. privilégier le workflow personnel réel ;
2. implémenter le chemin le plus simple de bout en bout ;
3. mesurer les limites ;
4. seulement ensuite généraliser.

Ne pas construire aujourd'hui une abstraction destinée à une fonctionnalité hypothétique de demain si le modèle actuel permet de l'ajouter plus tard proprement.
