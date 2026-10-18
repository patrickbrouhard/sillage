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
`original_audio_language` est facultative sur la source et provient uniquement
des signaux audio explicites, jamais des captions. La sélection privilégie la
clé exacte admissible de la langue enregistrée, puis sa clé générique pour une
forme simple langue-région (région de deux lettres ou trois chiffres), puis une unique piste `*-orig`
admissible, même d'une autre langue. Elle distingue absence et ambiguïté.
Les étiquettes complexes ne sont pas simplifiées. Le marqueur peut concerner un
audio doublé : la politique privilégie l'audio original, sans garantie absolue.

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

**Cadrage et implémentation terminés ; étape validée le 9 octobre 2026.**
Notes et tags sont disponibles de bout en bout, des services à SQLite et REST.
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

La dernière écriture gagnante était le compromis de cette tranche ;
la protection par révision et les conflits sont désormais implémentés en 5.2.

Restent hors de l'étape 4 :

- plusieurs notes, suppression explicite, ajout partiel, historique et gestion des conflits ;
- interface Web, éditeur Markdown et autosauvegarde (à étudier à l'étape 5) ;
- parsing/rendu des syntaxes temporelles, timestamps interactifs et annotations structurées (étape 6) ;
- remplacement complet des associations, suppression globale ou renommage des tags ;
- hiérarchies, alias, couleurs et catégories de tags ;
- combinaisons de filtres, recherche textuelle et FTS5 ;
- MCP et génération de tags par IA.

Les choix locaux et limites de validation sont documentés dans l'architecture
et les décisions techniques ; ils ne deviennent pas des contraintes permanentes.

### Validation réalisée

Les tests Go couvrent les migrations depuis le schéma précédent, la réouverture,
les dates et le Markdown (désormais canonique en LF à la sauvegarde), l'identité Unicode, la concurrence, le rollback
des créations et associations, les erreurs REST et les interactions avec vidéos
et transcriptions. Les acquisitions de test sont simulées, sans accès à YouTube.
La collection Postman déterministe complète les validations sur une base vide :
44 requêtes et 132 assertions réussies. Les deux collections passent le lint
sans erreur ni avertissement ; la collection YouTube réelle n'a pas été exécutée.
Les tests, `go test -race ./...`, `go vet ./...` et `go build ./...` passent.

## 6 bis. Étape 4 bis — Publishers, personnes et tags universels

### Position et état

Cette tranche a été décidée avant l'interface Web. Son modèle est validé et son
implémentation est disponible via services applicatifs, SQLite et REST.
L'étape 5 reste la tranche suivante ; aucune interface Web n'est ajoutée ici.

### Périmètre réalisé

- publisher identifié par `(provider, external_id)`, avec nom facultatif ;
- résolution YouTube par `channel_id`, à l'import vidéo ou depuis une URL de chaîne ;
- réutilisation sans rafraîchissement et sources pouvant rester sans publisher ;
- personnes indépendantes, noms obligatoires non uniques, renommage ;
- personne de référence facultative du publisher et liens directs vidéo–personne sans rôles ;
- rattachements explicites modifiables et retirables, sans propagation ;
- catalogue de tags unique et tables d'associations explicites pour les trois entités ;
- navigation par publisher et par personne, chemins direct/indirect et union dédupliquée ;
- migration versionnée avec sauvegarde préalable, suppression de `creator` sans déduction par nom ;
- rupture REST documentée : `publisher: {id, name}` nullable et `person_ids` directs.

### Validation et limites

Les tests couvrent migration et sauvegarde, conservation des données et IDs,
concurrence et rollback, métadonnées absentes, résolution simulée de chaînes,
absence de refresh et de propagation, contrats REST et navigation.
Le 10 octobre 2026, la suite Go, `go test -race ./...`, `go vet ./...` et
`go build ./...` passent. La collection Postman déterministe réussit ses
44 requêtes et 132 assertions ; les deux collections passent le lint.
La résolution réelle de `@LexClips` par yt-dlp a été vérifiée sans téléchargement
ni parcours des vidéos. La collection YouTube complète n'a pas été exécutée.

Restent hors périmètre : suppression des personnes/publishers, actualisation des
noms, reprise automatique des anciennes sources, autres providers, collaborations,
rôles, organisations et interface Web. Les sources anciennes sont rattachables
explicitement ; leurs anciens libellés restent uniquement dans la sauvegarde.

## 7. Étape 5 — Interface Web

React, TypeScript et Vite sont actés pour une SPA consommant REST. Go sert les
fichiers statiques de production, livrés avec le binaire dans Docker.
Le développement avance par commits cohérents, avec validation utilisateur
après chaque jalon fonctionnel. La mise à jour documentaire précède le code.

### 5.1 — Bibliothèque utilisable et distribuable

Périmètre validé : bibliothèque (miniature, titre, source, tags), ajout YouTube
et doublon, fiche dédiée, ajout/retrait des tags vidéo, filtre unique effaçable,
navigation et accès direct, états de chargement/vide/erreur, build Go + frontend,
Docker et vérifications automatisées.

La première source REST présente provisoirement la carte. La gestion complète
des publishers/personnes, la recherche, les filtres combinés et la pagination
sont exclus. Aucun éditeur, lecteur, transcription ou mécanisme temporel ici.

État : étape 5.1 clôturée. Les jalons 1 à 4 sont terminés, testés et validés
manuellement et en CI.
Le jalon 2 est validé manuellement et en CI : navigation, ajout synchrone,
doublon et fiche présentant toutes les sources. Aucun contrat REST ni règle
métier n'est modifié. Les tests couvrent routage, historique, erreurs, accès
directs, réponses tardives et ajout/doublon via Go/SQLite. Le jalon 3 est validé manuellement et en CI :
gestion immédiate des tags en modale, autocomplétion clavier, navigation et
filtrage par tag, descriptions repliables. Le jalon 4 est validé sous WSL2 avec
Docker Compose : construction et démarrage, import YouTube réel, doublon, tags,
accès direct et persistance après recréation du conteneur. Les données Docker
sont séparées des données de développement local. Les trois jobs GitHub Actions
Go/Postman, Web/Playwright et Docker ont réussi.
La modale est provisoire ; un futur volet ou onglet et le panneau de métadonnées
restent des pistes révisables (voir Product & UX).

Jalons terminés et validés :

1. fondations React/Go : liste réellement connectée et production servie par Go ;
2. navigation, ajout et détail vidéo ;
3. classement par tags : navigation par tags, gestion immédiate en modale avec
   autocomplétion, filtre unique dans l’URL et descriptions repliables ;
4. distribution Docker, CI et consolidation.

La chaîne de production doit fonctionner dès le premier jalon. Les tests
préservent Go et Postman et incluent un parcours déterministe via Go et SQLite,
sans dépendance obligatoire à YouTube en CI. Les accès directs SPA ne doivent
pas masquer les erreurs API ou les assets absents.

### 5.2 — Éditeur Markdown et sauvegarde fiable

Les trois jalons sont implémentés et testés localement ; le périmètre fonctionnel
est validé manuellement. La fusion reste soumise à une CI réussie sur le dernier
commit, consultable dans GitHub Actions. Jalons réalisés :

1. première édition protégée : révision atomique, migration, REST conditionnel,
   CodeMirror, sauvegarde explicite et vérification LF/CRLF/mixte ;
2. modes Édition/Lecture GFM sécurisé, autosauvegarde 2 s/20 s, états fiables,
   requêtes successives et réconciliation après réponse perdue ;
3. résolution explicite des conflits, navigation protégée (historique inclus),
   avertissement de fermeture et consolidation des parcours Go/SQLite/Web/Docker.

Aucune note créée à l'ouverture ; note vide conservée. Aucun HTML brut exécuté,
aucune transformation du Markdown hors normalisation des fins de ligne en LF à la sauvegarde.
La précondition attendue est obligatoire pour tous les clients ; une résolution
reste conditionnelle. Les détails sont actés dans Product & UX, Modèle et Architecture.

CodeMirror 6 est intégré ; la normalisation LF/CRLF/CR/mixte est testée. Les choix
locaux de présentation et les deux reprises réseau automatiques sont révisables. Sans brouillon persistant, une perte
après crash brutal reste possible et acceptée. Historique, File Recovery, suppression,
fusion automatique, collaboration, lecteur et fonctions temporelles sont exclus.

### 5.3 — Lecteur et transcription

État : terminée et fusionnée dans `master`, selon la confirmation de l'utilisateur
au démarrage de 6.1, après les retours manuels positifs sur la transcription. Vérification
finale locale : 80 tests navigateur, tests Go complets, vet, build Go et typage
réussis. La CI distante n'est pas revendiquée ici.

Complément régional implémenté : après filtrage, priorité exacte puis générique
pour les seules étiquettes simples langue-région, puis repli unique ou erreurs
existantes. Les doublages limitent la garantie d'originalité ; le libellé affiché
est désormais « Transcription automatique ». Aucun changement REST, SQLite,
d'identité ou de mise à jour de la langue audio.
Validation déterministe : tests Go complets, vet, builds Go/frontend, typage et
13 tests navigateur de transcription réussis. Les fixtures couvrent plusieurs
pistes avec audio `en-US`, régions numériques, priorité exacte, candidats non
admissibles, écritures/étiquettes complexes et erreurs conservées.
Références de validation manuelle : `G2B0YWuJUgI`
(régression de l'acquisition déjà validée) et `LLS-D5bKyEE` (plusieurs pistes
`-orig`, choix attendu `en-orig`, audio conservé `en-US`). L'utilisateur rapporte
un fonctionnement satisfaisant après le correctif régional ; aucun nouvel essai
YouTube indépendant par l'agent n'est revendiqué.

Correctif validé après essai manuel : le cas audio `en-US` / caption `en-orig`
doit être accepté par repli sur une piste originale unique. Les égalités entre
langues audio et transcription sont retirées de la sélection et de la sauvegarde.
Les captions ne renseignent plus la langue audio, même à l'import ; aucune
correction automatique des anciennes valeurs n'est prévue. Correctif implémenté
et validé le 12 octobre 2026 : tests Go avec détection des races, vet, builds,
typage, 76 tests navigateur et Postman (45 requêtes, 135 assertions) réussis.
L'image Docker reconstruite et le smoke test Compose passent également.
Les nouveaux parcours déterministes couvrent `en-US` / `en-orig`, l'ambiguïté,
la conservation du contenu et les acquisitions concurrentes de langues distinctes.
La validation manuelle rapportée par l'utilisateur confirme ensuite l'acquisition
réelle de `G2B0YWuJUgI` : 5 511 fragments en `en`, avec l'audio conservé en `en-US`.

Dernier ajustement UX : paragraphes de transcription fluides via CSS, sans
modifier les fragments ni leur regroupement. Build Go/frontend, typage et les
16 tests navigateur ciblés transcription/workspace passent, dont le rendu à
1440 et 375 px et la conservation des chaînes exactes.

L'utilisateur a également confirmé le bon fonctionnement de l'affichage fluide.
Les scénarios lecteur sont couverts par les tests déterministes et StrictMode
décrits ci-dessous ; aucun nouvel essai manuel indépendant du lecteur n'est revendiqué.

Périmètre validé : workspace desktop note à gauche, lecteur et transcription à
droite, défilements indépendants ; mobile lecteur, note, transcription avec
défilement de page. La note conserve sa session, ses sauvegardes et son historique.
Métadonnées secondaires repliables. Première source YouTube exploitable dans
l'ordre REST, commune aux deux outils et identifiable, sans source principale
persistée ni sélecteur.

IFrame Player API directe et commandes natives, sans lecture automatique.
Masquage avec pause YouTube, conservation de position dans la fiche, réaffichage
sans reprise. États d'erreur indépendants et lien externe lorsque disponible.
GET local à l'ouverture ; acquisition/actualisation par POST explicite uniquement.
Ancien contenu conservé pendant l'actualisation et ses échecs, erreurs distinctes,
relecture possible après résultat incertain sans relance automatique du POST.
Regroupement initial par intervalles 5/10/15/30 s (remplacé en 6.3 par 10 s fixes), ancrés
sur zéro, fragments consécutifs et ordre source conservés, espaces exacts et aucun
bloc visuellement vide. Les timestamps affichent le début réel du premier fragment.

Jalons réalisés : lecture locale et regroupement ; acquisition explicite ; lecteur
et masquage ; disposition et consolidation. Le faux yt-dlp fournit désormais des
captions JSON3 pour les parcours frontend/Go/SQLite ; l'API lecteur est simulée.
Les tests couvrent aussi réponses tardives, résultat POST incertain, pause non
confirmée, reprise inattendue masquée, sélection et Undo/Redo de la note pendant
les interactions, défilements indépendants et ordre mobile jusqu'à 320 px.

Validation initiale locale du 12 octobre 2026 : tests Go, `go test -race ./...`, `go vet ./...`,
builds Go et frontend, typage TypeScript, suite navigateur complète (73 tests)
et collection Postman déterministe (45 requêtes, 135 assertions) réussis.
Les scénarios lecteur passent également
sous Vite/React StrictMode (10 tests ciblés). L'image Docker et le smoke test
Compose passent : outils, HTTP/SPA, permissions, bind mount, persistance après
recréation et arrêt propre. Les captures desktop et mobile des parcours simulés
ont été inspectées. La CI distante n'a pas été lancée depuis cette branche.

Choix locaux documentés dans l'architecture : chargements lecteur bornés à 15 s,
destruction si pause non confirmée après 1 s, GET à 12 s et POST à 90 s côté client.
L'avertissement Vite sur la taille du chunk CodeMirror de 5.2 reste présent ;
aucune refonte de l'éditeur ni optimisation spéculative n'est introduite.

Hors périmètre : interactions temporelles (étape 6), média local, panneaux avancés,
gestion de plusieurs pistes/sources, préférences persistantes (sauf le thème
d'affichage local ajouté pour le confort de développement) et acquisition
automatique. Le schéma de persistance et les identités sont conservés. Les
correctifs ont ajusté la politique de sélection et ajouté l'erreur REST
`409 transcript_selection_ambiguous`, sans changer les payloads de transcription.

## 8. Étape 6 — Interactions temporelles, citations et références enrichies

### 6.1 — Navigation de la transcription vers le lecteur YouTube

Implémentée et validée manuellement par l'utilisateur. L'étape 6 se poursuit sur
la même branche, sans fusion intermédiaire obligatoire dans master.
Les timestamps des blocs sont activables au clavier et transmettent leur début
réel au lecteur de la même source. Lecture et pause sont préservées ; avant le
premier démarrage et après la fin, seul le point de départ est préparé. Le lecteur
masqué est réaffiché sans reprise automatique. Un lecteur non prêt ou indisponible
demande un nouveau clic explicite, sans commande en attente ni faux succès.
Un masquage en cours conserve sa garantie d'arrêt.

La tranche ne modifie ni transcription, ni note, ni contrat REST, ni domaine,
ni SQLite. Tests déterministes avec IFrame API simulée, sans YouTube réel.
La précision effective reste celle du lecteur YouTube et de ses images clés.

Validation locale du 13 octobre 2026 : 91 tests navigateur réussis, tests Go
complets, `go vet ./...`, builds Go/frontend et typage TypeScript réussis.
Aucun essai YouTube réel ni exécution de CI distante revendiqués. L'avertissement
Vite existant sur le chunk CodeMirror supérieur à 500 ko reste présent.

### 6.2 — Insertion du temps courant

Implémentée et validée manuellement par l'utilisateur, sans fusion automatique.
Format acté : `[12:42](sillage://videos/5/sources/5?start_ms=762345)`, autorité logique
`videos`, vidéo et source explicites, millisecondes conservées et `end_ms` réservé.
`+ Temps` insère au curseur ou après la sélection sans l'effacer, ajoute un espace,
rend le focus et forme une action Undo/Redo indépendante. L'autosauvegarde existante
reste utilisée, sans modification REST/SQLite ni création d'Annotation.

Lecture, pause et fin autorisent une position valide ; zéro est accepté. Masqué
en pause, le lecteur reste masqué. Non démarré, cued, buffering, masquage en cours,
chargement, erreur et destruction refusent l'insertion sans action différée.
Le bouton est désactivé en Lecture ; le libellé des liens y reste sans interaction.
La précision effective dépend de YouTube ; la copie du Markdown est autonome
dans la même base, sans garantie de résolution dans une autre base indépendante.

Validation locale du 13 octobre 2026 : 100 tests navigateur réussis, dont 9 nouveaux
parcours d'insertion avec API YouTube contrôlée et persistance Go/SQLite réelle.
Tests Go complets, vet, builds Go/frontend et typage TypeScript réussis. L'avertissement
Vite sur le chunk CodeMirror reste présent. Pas de nouvelle CI distante ni de
reconstruction Docker ; aucun essai YouTube réel de 6.2 revendiqué.

### Correctif de fins de ligne — LF canonique

Décision actée après 6.2 : CRLF et CR deviennent LF à la sauvegarde, les autres
caractères restant inchangés. Elle remplace la conservation exacte des séparateurs
de 5.2. CodeMirror utilise le découpage natif, sans correctif spécial du caret.
Le service applicatif garantit la règle pour tous les clients. Pas de migration,
de normalisation par GET ni d'écriture automatique à la seule ouverture/départ.
Une sauvegarde explicite ou une édition suivie d'autosauvegarde normalise une
ancienne note avec la précondition habituelle. Les variantes de séparateurs sont
ensuite des no-op ; la première normalisation constitue une nouvelle révision.

Validation locale : 104 tests navigateur, tests Go complets, vet, typage et builds
Go/frontend réussis. Collage CRLF/CR/mixte simulé, caret en fin de ligne, Undo/Redo,
autosauvegarde, réconciliation après réponse perdue et insertion temporelle couverts.
Pas de migration ni de modification des notes de développement par ce correctif.
Le correctif LF a été validé manuellement par l'utilisateur ; aucune nouvelle
CI distante ni reconstruction Docker revendiquée.

### 6.3 — Recherche et navigation dans la transcription

Décisions actées : recherche textuelle insensible à la casse dans le contenu déjà
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

Implémentation terminée après ce cadrage. Recherche littérale hors équivalence des blancs, occurrences non
chevauchantes et accents conservés ; compteur 0 / 0 pour une saisie vide ou
sans résultat. Actualisation réussie : requête conservée, résultats recalculés et
premier résultat sélectionné ; échec : contenu et sélection conservés.
Le défilement reste local au texte sur desktop ; sur mobile, il suit la page.
Validation manuelle complète de 6.3 confirmée par l'utilisateur : tous les scénarios
recommandés sont passés. F5 réinitialise normalement la recherche ; le bouton
« Actualiser » de transcription conserve la requête et recalcule ses résultats.
Aucune fusion dans master.

Validation locale du 13 octobre 2026 : 113 tests navigateur réussis, dont 9
nouveaux tests de recherche. Couverture des frontières de fragments et blocs,
des indices Unicode, des espaces exacts, du surlignage, du retour circulaire,
du défilement, des changements vidéo/source, des actualisations et de l'absence
de réseau ou de commande lecteur. Les parcours existants couvrent aussi notes,
Undo/Redo, autosauvegarde, insertion temporelle et normalisation LF.
`make test`, `go test -race ./...`, `make build` et la collection Postman
déterministe (45 requêtes, 135 assertions) réussissent. Aucun Go modifié à formater.
Les captures desktop clair/sombre et mobile ont été inspectées.
Chromium utilise les bibliothèques déjà présentes dans
`/tmp/sillage-browser-libs/usr/lib/x86_64-linux-gnu` via `LD_LIBRARY_PATH`,
sans installation ni changement de configuration du dépôt.
L'avertissement Vite existant sur le chunk CodeMirror supérieur à 500 ko subsiste.
Aucun nouvel essai YouTube réel, CI distante ou build Docker revendiqué.

Vérifications manuelles de 6.3 effectuées et validées par l’utilisateur :
- rechercher une expression traversant deux blocs et un mot coupé entre fragments ;
- parcourir les résultats dans les deux sens, y compris les retours premier/dernier ;
- vérifier les surlignages en clair/sombre et le défilement sur desktop/mobile ;
- confirmer que lecture, pause et lecteur masqué restent inchangés, puis tester un timestamp ;
- actualiser la transcription, changer de vidéo et vérifier l'édition/Undo et `+ Temps`.


### Retour manuel 6.3 — Entrée et blancs de transcription

Entrée dans le champ sélectionne le résultat suivant avec retour circulaire,
sans transfert du focus ni commande lecteur. La validation de composition IME
ne déclenche pas cette navigation.
L'exemple réel `thought about` contient `thought\nabout` dans les fragments :
les suites de blancs de la saisie correspondent désormais aux suites de blancs
sources, sans modifier le contenu ni décaler les surlignages. Cela remplace
l'exigence initiale de blancs identiques pour la recherche uniquement.

Validation : 116 tests navigateur réussis, typage, tests Go, vet et builds réussis.
Vérification en lecture seule sur la transcription locale de la vidéo 1 :
5 occurrences de `stuff` et 1 de `thought about`.
Le serveur Go conserve index.html en mémoire : après reconstruction du frontend,
redémarrer le serveur de développement puis recharger la page pour charger ce build.

### 6.4 — Sélection et citation de transcription

Cadrage consigné avant le code le 14 octobre 2026, puis implémenté et testé
localement. Retours manuels utilisateur satisfaisants, puis correctifs ciblés de clôture
(voir le bilan 6.4 dans la roadmap). Tranche entièrement frontend, sans nouveau contrat REST, migration, entité Annotation ni objet citation
persisté. Aucun end_ms. L'activation en Lecture est désormais fournie par 6.5.

Sélection native à la souris, au clavier avec la navigation au curseur du navigateur,
ou tactile, partielle ou traversant plusieurs fragments/blocs, y compris les mark
de recherche. Aucun système personnalisé de sélection. Les timestamps sont exclus
de la sélection de texte et du texte copié, mais restent des boutons accessibles.
La copie native d'une sélection valide produit seulement du texte continu :
concaténation dans l'ordre source sans séparateur ajouté, suites de blancs réduites
à un espace, blancs de bord retirés. Les copies hors sélection valide ne sont pas
interceptées. Les fragments et timestamps sources restent intacts.

Un bouton stable « Citer dans la note » est activé pour un passage valide.
Le passage est conservé avant le transfert de focus, puis invalidé au changement
de vidéo/source, au remplacement effectif de transcription ou lorsque la recherche
rend la sélection obsolète. Aucune citation différée ou remplacement silencieux
du passage. Un clic ou un transfert de focus vers un autre outil abandonne
l'extrait mémorisé ; le transfert vers « Citer dans la note » le conserve.
L'action consomme la sélection, y compris en cas de refus. Les sélections vides,
composées uniquement de blancs, multiples ou débordant hors de la transcription
ne sont pas acceptées. Aucun bouton flottant dans cette tranche.

Le début vient du premier fragment contenant du texte réellement retenu après
nettoyage, même si ses timestamps ne sont pas monotones. Ni timestamp systématique
du bloc, ni interpolation à l'intérieur d'un fragment. Le texte est échappé pour
rester littéral en Markdown. Format :

```markdown
> They may not agree with those arguments.

— [0:21](sillage://videos/5/sources/5?start_ms=21000)
```

En Édition, une note vide (zéro caractère) accepte l'insertion à zéro. Une note
non vide, y compris seulement des espaces, exige un emplacement choisi explicitement
par l'utilisateur. Un focus automatique ne suffit pas. La position persiste après
perte du focus ; une sélection de note reçoit l'insertion après sa borne supérieure
sans remplacement. En Lecture ou sans emplacement choisi : message explicatif,
sans bascule, insertion automatique ou mise en attente ; recommencer ensuite
la sélection de transcription. Le remplacement de la version éditée invalide
l'emplacement choisi.

Insertion dans la session CodeMirror existante, avec les séparateurs LF nécessaires
pour isoler le bloc, une ligne vide entre citation et référence et un curseur après
la référence et sa ligne vide finale. Les sauts LF déjà présents sont réutilisés ;
aucun caractère existant n’est retiré. Citation, référence et séparateurs constituent un seul Undo/Redo et utilisent
l'autosauvegarde, les révisions et les conflits existants. Aucun ordre au lecteur.
Dans les listes, tableaux ou blocs de code, l'insertion reste textuelle : aucune
restructuration ou recherche automatique d'un autre emplacement. Le rendu peut
donc dépendre du contexte Markdown ; c'est une limite acceptée. L'échappement protège
les syntaxes inline, les entités et les marqueurs de bloc en début de paragraphe,
sans ajouter d'antislashs à la ponctuation ordinaire. Les URL littérales
peuvent toujours être reconnues par les autoliens GFM du mode Lecture, sans changer
leur libellé.

Le bouton flottant et les finitions graphiques sont différés. La navigation au
curseur et les menus tactiles natifs dépendent du navigateur. Le bilan manuel,
les confirmations complémentaires et les pistes UX sont consignés dans la roadmap.

#### Validation automatisée de 6.4 — 14 octobre 2026

- make test-web : 139 tests Playwright réussis, dont 23 nouveaux tests pour 6.4 ;
  build frontend et serveur réussi.
- make test : tests Go complets, go vet, build des packages et typage TypeScript réussis.
- go test -race ./... : réussi.
- Collection Postman déterministe : 45 requêtes et 135 assertions réussies.
- git diff --check : réussi ; captures desktop et écran étroit inspectées.

Les tests couvrent extraits partiels, fragments séparant un mot, blocs multiples,
blancs, timestamps non monotones, recherche active, sélections inversées, bornes
DOM sur éléments, copie native Chromium et absence d'interception hors transcription.
Ils vérifient aussi note absente/vide/non vide/espaces seuls, refus en Lecture,
focus automatique, position explicite et sélection de note, séparateurs existants,
échappement Markdown, Undo/Redo isolé, autosauvegarde, conflits avec conservation
du local ou adoption du serveur, invalidations et absence de commande au lecteur.
La suite existante couvre toujours recherche, navigation temporelle, insertion
+ Temps et garanties de sauvegarde. Le bouton supplémentaire a révélé un écrasement
des barres d'outils sur un panneau court ; le CSS empêche désormais ce chevauchement
et conserve un espace de texte défilable.

L'application n'a pas de nouvelle dépendance. Chromium utilise temporairement
libnspr4/libnss3 extraites sous /tmp pour les tests WSL, sans configuration projet
ou installation système supplémentaire. L'avertissement Vite sur le chunk CodeMirror
supérieur à 500 kB subsiste. Aucun build Docker, CI distante ni nouvel essai YouTube
réel revendiqué. Les sélections sont en majorité construites via les API DOM ;
un glisser de souris et Ctrl+C sont également exercés dans Chromium. L'écran étroit
est un viewport de test, pas une validation tactile sur appareil réel.

#### Clôture de 6.4 après retours manuels

Les tests manuels effectués par l'utilisateur sont satisfaisants. Deux retours
ont motivé un correctif limité : échappements trop envahissants en Édition et
Ctrl+Shift+Z sans effet sous Windows. La tranche 6.4 est achevée dans son périmètre ;
les confirmations ciblées ci-dessous restent à réaliser sur le build corrigé,
sans prétendre que chaque plateforme ou appareil a été validé manuellement.

L'échappement est désormais adapté au paragraphe d'une citation sur une seule
ligne : virgules, points, apostrophes et ponctuation ordinaire restent lisibles.
Les syntaxes inline (emphase, liens/images, code, barré), antislashs, chevrons ouvrants,
entités HTML et débuts pouvant produire titres, listes, séparateurs ou citations
imbriquées restent protégés. Le texte garde son sens littéral dans le rendu GFM ;
ses autoliens ordinaires restent admis. Aucun changement du rendu sécurisé,
du Markdown déjà enregistré ou du modèle de données.

Vérification du code installé : @codemirror/commands 6.11.1 fournit Ctrl+Z pour
Undo et Ctrl+Y pour Redo sur Windows/Linux ; Ctrl+Shift+Z est fourni par défaut
sur Linux seulement (Cmd+Shift+Z sur macOS). L'absence sur Windows correspond
donc à la keymap par défaut, pas à l'historique isolé des citations.
Sillage ajoute Ctrl+Shift+Z directement dans sa keymap CodeMirror avec la commande
redo existante. Ctrl+Y et les raccourcis macOS restent conservés ; aucun gestionnaire
global ni reconstruction de l'éditeur.

Validation du correctif : 142 tests Playwright réussis, dont 26 dans le fichier
citation ; make test, go test -race ./..., typage et builds réussis.
Les nouveaux tests comparent le texte rendu pour les syntaxes Markdown/HTML,
vérifient l'absence d'échappements ordinaires et exercent Ctrl+Z puis les deux Redo
sur texte ordinaire et citation, en conservant deux étapes d'historique distinctes
et la sauvegarde. Les variantes Linux et Win32 de la détection CodeMirror sont
testées dans Chromium Linux : la variante Win32 est une simulation, pas une
validation native Windows. Aucun essai manuel de Ctrl+Y ni du nouveau Ctrl+Shift+Z
sous Windows n'est encore confirmé. Les validations initiales restent ci-dessus.

Après reconstruction, redémarrage du serveur et rechargement, confirmations ciblées :

- Citer une phrase avec ponctuation ordinaire puis du Markdown/HTML ; vérifier
  la lisibilité en Édition et la fidélité en Lecture.
- Sous Windows, saisir du texte ordinaire puis vérifier Ctrl+Z/Ctrl+Y et
  Ctrl+Z/Ctrl+Shift+Z ; répéter avec une citation, qui doit rester une seule étape.
- Confirmer ces raccourcis sur toute autre plateforme réellement utilisée.
  Ne pas déduire une validation tactile ou clavier native des seuls tests automatisés.

Les finitions graphiques et le bouton flottant sont différés ; segmentation
naturelle et plages restent des investigations futures. Le rendu/navigation
des références relève de 6.5 ; l'étude plus large du mode Édition ci-dessous
n'est pas engagée par cette clôture.

### 6.5 — Navigation depuis les références Markdown

Décisions documentées avant le code, puis implémentées et testées localement.
État initial vérifié sur feat/transcript-player-navigation : le commit ed966be
contient l'échappement réduit, la keymap Ctrl+Shift+Z et le bilan de clôture 6.4.
Les confirmations manuelles Windows du correctif restent distinctes des tests simulés.

Le format accepté est exclusivement sillage://videos/{videoID}/sources/{sourceID}?start_ms={milliseconds},
avec identifiants entiers sûrs positifs et temps entier sûr non négatif.
Chiffres décimaux canoniques, sans zéros initiaux sauf zéro pour le temps.
Refus des encodages alternatifs, segments, fragments et paramètres supplémentaires
ou dupliqués, y compris end_ms. Le libellé ne détermine jamais la position.

En Lecture seulement, un lien valide devient un bouton natif discret.
Une référence invalide reste du texte inerte sans alerte à l'ouverture.
L'autorisation ciblée dans react-markdown concerne uniquement le href des liens ;
le filtre par défaut reste appliqué ailleurs, notamment aux images. HTML brut
toujours ignoré. Liens ordinaires et navigation protégée inchangés.

La fiche compare vidéo et source de travail réelles. Autre vidéo/source ou lecteur
indisponible : message accessible près de l'action, sans changement de fiche/source,
ni confusion avec la sauvegarde. La note n'est jamais modifiée ; sélection et
historique CodeMirror restent intacts. Le focus reste sur le bouton activé.

Note et transcription partagent player.navigate : lecture/pause préservées,
départ préparé sans autoplay pour les états non démarré/terminé/cued,
masquage en cours respecté, aucune commande différée. Une commande acceptée
n'est pas une confirmation du timestamp exact par YouTube.
Un lecteur masqué indisponible peut être réaffiché/réinitialisé comme en 6.1,
mais le refus n'entraîne ni défilement volontaire ni navigation ultérieure.

Après commande acceptée et réaffichage DOM effectif seulement, mesurer la zone
vidéo : aucun défilement si visible, déplacement minimal pour la montrer entièrement,
ou alignement du début si trop grande. Défilement instantané de la page, sans
déplacer le focus ni les défilements internes de note/transcription.
Aucune action tardive après changement de fiche.

Frontend uniquement : aucun changement REST/SQLite/domaine. Live Preview,
activation en Édition, plages, changement de source/vidéo et confirmation restent
hors périmètre. Une confirmation future d'ouverture d'une autre fiche/source est
une piste, pas une fonctionnalité actée. Le périmètre fonctionnel de 6.5 est
terminé et validé manuellement ; voir le bilan de clôture ci-dessous.

#### Validation automatisée et limites de 6.5

162 tests Playwright réussis, dont 20 nouveaux scénarios de navigation temporelle ;
make test (tests Go, vet, build et typage), go test -race ./... et build frontend/serveur
réussis. Collection Postman déterministe : 45 requêtes, 135 assertions réussies.
git diff --check réussi. Capture des messages de refus inspectée.
Le test existant de + Temps attend désormais un bouton en Lecture.

Couverture : URI non canoniques, limites numériques et paramètres refusés,
filtrage liens/images/HTML, liens ordinaires, identités distinctes, absence de source,
états du lecteur, masquage en cours, instance masquée conservée ou indisponible,
exception, absence de commande tardive, focus et sélection/Undo de la note.
Un test termine une sauvegarde déjà engagée après activation : bouton et focus
conservés, sans remontage. Les deux origines sont testées pour le défilement,
aux largeurs 1440 et 375, avec zone visible, partiellement visible, hors écran
ou trop grande, et préférence reduced-motion.

Les tests de défilement placent la page explicitement, focalisent sans scroll,
puis activent par click DOM : Playwright ne met pas l'action en visibilité.
Ils mesurent la page et les scrollTop internes avant/après. Ce mécanisme teste
le comportement applicatif, pas la gestuelle tactile réelle. Les commandes
YouTube restent simulées ; aucune précision réelle de seek n'est revendiquée.
Le navigateur peut limiter le déplacement en fin de document. Un échec ne lance
aucun scroll applicatif, mais le réaffichage peut naturellement modifier le layout.
Aucun nouvel essai YouTube réel, build Docker ou CI distante revendiqué.
L'avertissement Vite existant sur le chunk CodeMirror reste présent.

#### Clôture et validation manuelle de 6.5

L'utilisateur confirme des essais satisfaisants : activation des références en
Lecture, cohérence avec la transcription, états lecture/pause/masquage,
défilement conditionnel, préservation de l'édition et de la sauvegarde,
refus de navigation vers d'autres vidéos/sources et fonctionnement des liens ordinaires.

Plusieurs références réelles ont été testées sur /videos/6 : rejet des paramètres
supplémentaires, end_ms, identifiants incorrects, valeurs numériques invalides et
encodages alternatifs, sans problème constaté. Cette validation couvre les essais
rapportés ; aucune confirmation supplémentaire sur appareils tactiles ou autres
environnements n'est revendiquée.

Dernier correctif limité au rendu Markdown des notes : les liens HTTP(S) vers
une origine externe s'ouvrent dans un nouvel onglet avec target="_blank" et
rel="noopener noreferrer", aussi bien les liens explicites que les autoliens GFM.
Les liens de même origine restent dans le même onglet via React Router ;
mailto garde le comportement natif et les références Sillage leur activation locale.
Le filtrage des URL dangereuses et invalides reste inchangé.

Validation automatisée du correctif : suite de 162 tests Playwright réussie,
make test (tests Go, vet, build et typage) et build frontend/serveur réussis.
Le test de rendu couvre HTTP/HTTPS, lien explicite/autolien, même origine absolue,
lien interne relatif et mailto. Il ouvre réellement deux onglets Chromium sur une
destination interceptée localement, vérifie l'absence d'opener et le maintien de
la fiche d'origine. Les scénarios de sécurité et de navigation temporelle restent
dans la suite complète.

6.5 est terminée et validée manuellement pour son périmètre fonctionnel.
Seul le nouveau comportement d'ouverture externe attend une ultime confirmation
utilisateur : après build, redémarrage et rechargement, cliquer dans une note sur
un lien Web explicite puis une URL GFM, vérifier le nouvel onglet et la conservation
de la fiche ; vérifier qu'un lien interne reste dans Sillage et qu'une référence
temporelle continue d'activer le lecteur. Ce correctif n'est pas encore déclaré
validé manuellement. Les confirmations du correctif 6.4 restent consignées plus haut.

Restent des pistes différées, sans décision technique définitive : confirmation
avant ouverture d'une autre vidéo/source, présentation enrichie en Édition
éventuellement inspirée du Live Preview, finitions graphiques des références,
plages début/fin et interactions avancées avec le lecteur.

### Tranches suivantes — à cadrer

- référence avec début obligatoire et fin facultative, bornes ajustables ;
- provenance temporelle conservée lorsque nécessaire ;
- rendu enrichi dans l'éditeur et navigation vers le lecteur.

Le format des liens Markdown `sillage://` est acté en 6.2 ; les plages, leur
interface restent à étudier ; la navigation vers le lecteur courant est implémentée
en 6.5. L'ouverture d'une autre fiche/source reste future.
Insertion rapide et citation enrichie peuvent partager la même référence.
La relation aux annotations structurées reste ouverte.

Le Markdown brut reste stocké sans transformation hors normalisation LF et peut contenir des extensions
internes. La copie ordinaire préserve les informations utiles ; copie adaptée et
export peuvent convertir les références. L'export Markdown de consultation est
distinct d'une sauvegarde réimportable de toutes les données métier.
Aucune de ces capacités ne doit être implémentée artificiellement en 5.1.


## 8 bis. UX 1 — Confort des citations Markdown après l'étape 6

### UX 1.1 — Callouts en Lecture et insertion

Contrat validé le 14 octobre 2026 ; implémentation sur feat/markdown-callouts.
Validation visuelle et fonctionnelle confirmée par l'utilisateur le 15 octobre 2026 ;
UX 1.1, titre facultatif inclus, est clôturée et sa fusion dans master est autorisée. Le contrat détaillé est dans Product & UX, la frontière
des composants dans Architecture et le choix technique dans Tech stack.

Cette tranche remplace le format généré de 6.4 par quote:tr avec URI dans l'en-tête
et timestamp calculé. Les bilans 6.4 ci-dessus décrivent le format historique ;
ses notes restent lisibles et navigables, sans migration ni détection rétroactive.
Lecture : deux formes ciblées, cadre React commun, attribution littérale,
pictogrammes accessibles, navigation 6.5 et replis inertes. Insertion : extraction,
échappement, sélection, Undo/Redo, autosauvegarde et conflits conservés.

Validation automatisée du 14 octobre 2026 :
- make test : tests Go, go vet, build Go et typage TypeScript réussis ;
- make test-web : builds frontend/serveur et 204 tests Playwright réussis,
  dont 42 nouveaux scénarios de callouts ; tests 6.4 adaptés au nouveau format ;
- couverture : syntaxe stricte et replis, échappements, entités, liens traversant
  l'en-tête, GFM partagé, imbrications, continuations paresseuses, ancien format,
  navigation 6.5, focus/messages pendant la sauvegarde, insertion et rechargement
  via Go/SQLite, Undo/Redo et conflits ;
- captures contrôlées en clair/sombre aux largeurs 375 et 1440 px ; pas de
  débordement horizontal dans ces scénarios. Le thème système utilise les mêmes
  couleurs ; les tests de thème existants restent verts.

Environnement WSL : runtimes Linux et bibliothèques Chromium déjà présentes sous
/tmp/sillage-browser-libs/usr/lib/x86_64-linux-gnu via LD_LIBRARY_PATH. Aucun ajout
de dépendance, installation système ou changement de configuration projet.
L'avertissement Vite existant sur le chunk CodeMirror supérieur à 500 ko subsiste.
YouTube est simulé dans les tests navigateur ; aucun essai YouTube réel revendiqué.

Compromis : une analyse supplémentaire de la note contenant un en-tête connu,
avec le même parseur et une copie temporaire pour isoler en-tête et corps. Aucun
second renderer du corps, aucune modification de la note. La validation visuelle
et fonctionnelle par l'utilisateur est confirmée le 15 octobre 2026.

Périmètre des vérifications manuelles proposées, suivi du retour utilisateur satisfaisant :
- examiner les deux cadres, les pictogrammes et les attributions longues en
  Clair/Sombre/Système, sur écran large et étroit ;
- citer une sélection réelle, passer en Lecture, activer le timestamp, puis
  revenir en Édition et vérifier Undo/Redo et sauvegarde ;
- essayer une ancienne citation, une URI invalide et une référence d'autre source ;
- vérifier le focus et le retour près du timestamp avec lecteur masqué ou indisponible.

### Complément UX 1.1 — Titres de transcription, 15 octobre 2026

Titre facultatif en texte simple après l'URI, séparé par espace/tabulation,
limité à la ligne. « Transcription » par défaut si absent ou blanc.
Le titre apparaît près du pictogramme ; le timestamp reste à droite.
L'insertion reste sans titre personnalisé. Aucun changement de validation URI,
de persistance, de navigation ou d'éditeur. Remplace l'interdiction initiale
de tout texte après l'URI.

Validation du 15 octobre 2026 : make test et make test-web réussis (208 tests Web,
tests Go, go vet, typage et builds). Cas couverts : titres absents/blancs, espaces
et tabulations, CR/LF/CRLF, Markdown et HTML littéraux, parenthèses dans les titres,
URI invalides avec titre, imbrications, titre long, navigation et stabilité pendant
la sauvegarde. Captures vérifiées à 375 et 1440 px, en clair et sombre, sans
débordement ni recouvrement du timestamp. Insertion automatique sans titre conservée.
Même environnement WSL que ci-dessus ; avertissement Vite préexistant inchangé.
Le 15 octobre 2026, l'utilisateur confirme que les vérifications visuelles et
fonctionnelles sont satisfaisantes et autorise la fusion d'UX 1.1 dans master.

### UX 1.2a — Présentation de l'éditeur, 15 octobre 2026

Base locale propre vérifiée ; UX 1.1 validée par l'utilisateur et fusionnée dans
master. Implémentation sur feat/markdown-editor-visuals, sans fusion de cette tranche.
Bordure des véritables blockquotes, fond discret et hiérarchie des callouts valides.
URI entièrement visibles ; aucun widget, lien activable ou changement de texte.
ViewPlugin CodeMirror, arbre natif et validation d'en-tête partagée seulement.
Contrat détaillé dans Product & UX ; mécanisme dans Architecture.

Validation du 15 octobre 2026 :
- make test : tests Go, go vet, builds Go et typage TypeScript réussis ;
- make test-web : builds frontend/serveur et 229 tests Web réussis, dont 21 nouveaux
  scénarios de présentation de l'éditeur ;
- couverture : citations réelles et code, listes, imbrications, continuations,
  en-têtes invalides/inconnus/échappés, grand bloc hors écran et analyse incrémentale,
  sélection intégrale, Undo/Redo, sauvegarde et identité de la session ;
- les scénarios existants d'insertion de citations, de navigation, de conflits,
  de thèmes et de stabilité du workspace restent verts ;
- captures vérifiées à 375 et 1440 px en clair/sombre : trait continu, syntaxe et
  URI visibles, aucun débordement horizontal ni écriture provoquée par le rendu.

Aucune dépendance ajoutée. Runtimes Linux et bibliothèques Chromium WSL déjà
présentes réutilisés comme pour UX 1.1. L'avertissement Vite préexistant sur la
taille du chunk CodeMirror subsiste. Aucun essai YouTube réel pour cette tranche.
UX 1.1 est intégrée dans `origin/master` par la fusion GitHub `90bb1a7`.
La branche UX 1.2a est réalignée sur cette base, en conservant la validation
utilisateur d'UX 1.1 et les deux commits d'UX 1.2a. UX 1.2a a ensuite été
fusionnée sur GitHub dans master par le commit e9cbe61 (PR #9).

Vérifications manuelles recommandées avant validation :
- juger bordure, contraste et lisibilité des URI en Clair/Sombre/Système ;
- éditer une citation multiligne, dans une liste ou imbriquée, puis un en-tête
  valide/invalide ; vérifier le trait continu et le retour au style ordinaire ;
- sélectionner/copier une URI complète, citer un extrait de transcription,
  essayer Undo/Redo, sauvegarder et basculer Lecture/Édition ;
- vérifier le confort des retours à la ligne sur écran étroit.

### UX 1.2b.1 — Références compactes en Édition

Implémentation sur feat/compact-temporal-references depuis master propre e9cbe61,
sans fusion. Contrat détaillé dans Product & UX ; mécanismes dans Architecture.

Périmètre : liens directs monolignes de forme [libellé](URI), avec libellé simple
et URI strictement canonique. Horloge et libellé fidèles, sans nouvelle dépendance
ni modification du Markdown. Les autres formes restent en source, notamment
titres de liens, destinations entre chevrons, libellés enrichis/échappés, définitions,
images, code et liens multilignes. Les en-têtes connus de callout, leurs titres
et attributions restent littéraux ; leurs liens de corps peuvent être compactés.

Clic ou entrée clavier : révélation. Sélection traversante : source visible.
Suppression contre une référence compacte : premier appui sans effacement ni
déplacement du curseur, second appui natif. Frontières extérieures éditables,
y compris entre références adjacentes. Pas d'atomicRanges ni d'arrêt Tab ajouté.
La composition IME suspend la compaction. + Temps, espace final, Undo/Redo et
autosauvegarde conservent leurs contrats.

Validation automatisée :
- make test : tests Go, vet, build des packages et contrôle TypeScript réussis ;
- build frontend Vite et binaire serveur réussis ;
- 267 tests Playwright réussis, dont 38 nouveaux scénarios de compaction ;
- reconnaissance/exclusions, sélection partielle et traversante (clavier/souris),
  copie fidèle, frontières adjacentes, suppression protégée puis native, Undo,
  stabilité du DOM pendant sauvegarde, rechargement et grand document vérifiés ;
- insertion + Temps et navigation Lecture couvertes par les suites existantes,
  avec assertions visuelles adaptées et contrôles du Markdown persisté conservés ;
- captures 375 px clair/sombre inspectées : libellé long replié, aucun débordement.
  Le scénario IME automatisé utilise des événements synthétiques, pas un IME système.

Environnement : bibliothèques libnspr4/libnss3 extraites dans /tmp/sillage-browser-libs
pour Chromium WSL, sans installation système ni dépendance projet supplémentaire.
L'avertissement Vite préexistant sur le chunk CodeMirror supérieur à 500 kB demeure.
Aucune navigation YouTube réelle revendiquée pour cette tranche sans commande lecteur.

Validation manuelle attendue avant fusion :
- éprouver le ressenti du clic, des flèches et de la double action de suppression ;
- rédiger avant/après/entre les références, insérer plusieurs + Temps et annuler ;
- sélectionner à la souris et au clavier, copier vers un éditeur de texte brut ;
- vérifier les sauts de lignes lors de la révélation, les libellés longs et les thèmes ;
- essayer une composition IME réelle, le tactile et un lecteur d'écran.

### UX 1.2b.2 — En-têtes et navigation en Édition

UX 1.2b.1 est testée manuellement et validée par l'utilisateur. UX 1.2b.2 est
implémentée sur la même branche feat/compact-temporal-references, sans fusion.

Les en-têtes quote:tr admissibles compactent seulement l'URI, parenthèses visibles
et temps calculé depuis start_ms. Marqueur, titre et décorations UX 1.2a conservés.
Les liens temporels ordinaires gardent le périmètre de reconnaissance de 1.2b.1.
Clic simple et édition inchangés ; Ctrl/Cmd+clic active les formes compactes ou
révélées ; Mod-Enter active depuis un unique curseur intérieur. Les titres et
en-têtes invalides/imbriqués restent inertes. Pas de nouvelle dépendance.

La navigation appelle le callback 6.5 existant : contrôles vidéo/source, protocole
lecteur et défilement conditionnel partagés. Aucun dispatch, changement de sélection,
transfert de focus ou écriture provoqué par l'action. Les refus sont annoncés près
de l'éditeur dans une région status distincte de la sauvegarde.

Validation :
- build frontend, make test (Go, vet, build et TypeScript) réussis ;
- suite complète : 296 tests Playwright réussis, dont 29 nouveaux scénarios ;
- compaction/révélation, copie, suppression et Undo des callouts, clavier et clic,
  sélection et session conservées, états lecteur, refus identité/indisponibilité
  et lecteur masqué couverts ; suites UX 1.2a, 1.2b.1 et 6.5 conservées ;
- Cmd+clic et Cmd+Entrée testés sous Chromium Linux avec plateforme Mac simulée,
  sans prétendre à une validation macOS native ;
- aucun essai YouTube réel ; avertissement Vite préexistant sur le chunk > 500 kB.

Scénarios proposés pour la validation manuelle d'UX 1.2b :
- callouts avec/sans titre, titres longs, thèmes et écran étroit ;
- clic simple puis Ctrl/Cmd+clic sur lien/URI révélée, raccourci dans la source ;
- sélection conservée, saisie après navigation, + Temps et Undo/Redo ;
- lecteur masqué/hors écran, lecture et pause, refus vers une autre vidéo/source ;
- clavier macOS réel, lecteurs d'écran et composition IME.

#### Finition du curseur de navigation

UX 1.2b.1 et UX 1.2b.2 ont été testées manuellement et validées par l'utilisateur.
Dernière finition avant fusion : curseur de texte natif au repos, main avec
Ctrl/Cmd sur les références compactes et révélées, liens et URI de callouts.
Les transitions ne modifient ni la sélection ni le document. Sortie, relâchement,
Shift/Alt et perte de focus de fenêtre restaurent le curseur normal.

Validation : 305 tests Playwright réussis, dont 9 nouveaux scénarios de curseur ;
make test (Go, vet, build et TypeScript) et build frontend réussis. L'avertissement
Vite préexistant sur le chunk CodeMirror demeure.

Les tests macOS simulent navigator.platform et les événements Meta dans Chromium
Linux ; ils ne remplacent pas un essai macOS natif. Le blur de fenêtre est simulé.
Les scénarios proposés pour cette finition comprenaient la souris immobile,
les entrées avec modificateur maintenu et le retour depuis une autre application.

#### Validation complète d'UX 1.2b

L'utilisateur confirme que la finition du curseur fonctionne comme prévu et
valide l'ensemble d'UX 1.2b : compaction des liens ordinaires (1.2b.1),
compaction des URI de callouts et navigation en Édition (1.2b.2), puis retour
visuel du curseur avec Ctrl/Cmd. La validation fonctionnelle et ergonomique
est clôturée ; la branche feat/compact-temporal-references est prête à fusionner.

Cette confirmation globale ne précise pas les plateformes ni chaque scénario
d'accessibilité exercé : les limites des tests simulés documentées ci-dessus
restent explicites. Aucun nouveau résultat de test automatisé n'est revendiqué.

La fusion sera effectuée par l'utilisateur sur GitHub. La branche reste
non fusionnée à ce stade ; aucune fusion locale dans master n'est réalisée.

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

### 7.1 — Télécharger et conserver une vidéo YouTube

7.1a et 7.1b livrés ; correctif de simplification/conservation implémenté.
La CI du commit 2e4b6cc a révélé une incohérence available/activité résiduelle ;
la transition est corrigée et les étapes Postman sont validées localement.
La CI réexécute Go, Postman, le navigateur et le packaging sur les commits poussés.
- 7.1a : service asynchrone, MediaFile avec provenance, validation, stockage,
  suivi REST, suppression et récupération après interruption.
- 7.1b : actions visibles dans le workspace, suivi et confirmation de suppression,
  sans perturbation du lecteur, de la transcription ni de la session de note.

Les deux jalons, les validations et la confrontation finale documentation/code
ont été traités pour la première version. Le correctif remplace ses restrictions
par le classement natif res:1080, sans préférence MP4 ni liste fermée de conteneurs. Voir les contrats dans les documents 01 à 04.

### 7.2 — Captures vidéo implémentées

La base de travail a été vérifiée : master et origin/master à
`2db04de`, fusion de la PR #11 contenant 7.1 et son correctif.
L'implémentation 7.2 reste sur une branche dédiée, sans fusion automatique.

Livré :
- Asset persistant, provenance source–vidéo garantie, états pending/available/failed,
  clé de commande idempotente et référence Markdown stable par identité ;
- extraction locale de la même source puis repli distant sélectif, PNG sans
  redimensionnement, seek décodé et meilleur flux vidéo sans plafond 1080p ;
- acceptation visuelle CodeMirror sans Markdown temporaire, insertion finale
  isolée dans Undo/Redo et autosauvegarde habituelle ;
- maintien du marqueur pendant Undo/Redo ordinaires, abandon définitif lorsque
  son ancrage est traversé ou sa session remplacée ;
- lecture réactive des images, génération serveur après navigation, protection
  habituelle de la note, erreurs de consultation distinctes de la génération ;
- publication sûre, emprunt du média protégé contre la suppression, récupération
  des intentions interrompues et conservation des PNG malgré un incident SQL.

Validation : suite Go, vet et builds, détection de courses sur les services,
adapters et HTTP ; 323 tests Playwright dont 12 parcours captures. Les tests
FFmpeg sont déterministes et ne nécessitent pas YouTube. Un test distant
facultatif a réussi sur une courte vidéo 320 × 240 ; les limites de fidélité et
les vérifications visuelles encore nécessaires sont détaillées dans le document 04.

Les essais manuels ont confirmé les captures locales et distantes après les
correctifs HLS/HTTPS et 403. À dimensions identiques, HTTPS est sélectionné
prioritairement ; le cas lent observé à 95 140 ms est passé d'environ 89 secondes
à 4,3 secondes lors du contrôle réel. Le curseur resté au marqueur se place après
la référence et son espace final, sans déplacer une position choisie ailleurs.
La revue finale a couvert persistance/publication, emprunt du média, idempotence,
réessais bornés et cycle de vie de la note ; aucun autre problème bloquant identifié.
La suite Go, vet, les builds et les 323 tests navigateur passent au contrôle final.
Les limites documentées (HLS seul à meilleure résolution, refus réseau persistants,
fidélité exacte à l'iframe et cas colorimétriques particuliers) restent applicables.

### Incréments ultérieurs

Galerie par vidéo, réinsertion, import d'images externes, suppression explicite,
captures multiples, interactions temporelles/agrandissement et indicateurs
globaux d'activité restent différés. La génération peut déjà continuer après
navigation ; sa gestion dans une galerie n'est pas implémentée.
Lecture locale, import de médias, plusieurs qualités et audio seul restent
également distincts. Aucun nettoyage automatique des assets sans référence.

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
La concurrence des écritures est protégée par révision depuis 5.2. Les questions suivantes
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
- provenance MediaFile : actée en 7.1, facultative en général et obligatoire pour YouTube.

### 15.3 Métadonnées

- liste minimale des futurs champs au-delà de la tranche actuelle ;
- champs rafraîchissables ;
- stratégie de surcharge utilisateur ;
- rafraîchissement manuel ou automatique.

L'identité YouTube du publisher et la nullabilité de son nom sont actées.
Restent à cadrer : rafraîchissement explicite du nom partagé, y compris lorsqu'il
est absent, protection des associations utilisateur et identification des
publishers des futurs providers. Les collaborations YouTube sont différées.

### 15.4 Données temporelles et plusieurs sources

Une même `Video` peut avoir plusieurs `VideoSource` dont les timelines ne sont pas parfaitement synchronisées.

`Transcript` est désormais explicitement rattaché à `VideoSource`.

Pour les screenshots, 7.2 rattache la timeline à `source_id`, avec cohérence source–vidéo. La question reste ouverte pour les annotations et de futurs types d’assets.

## 16. Questions ouvertes — stockage

L'étape 4 bis ajoute les publishers, personnes et associations explicites par
migration avec sauvegarde préalable. La reprise par nom de `creator` est exclue.
La suppression des nouvelles entités et le devenir de leurs références restent
à cadrer avant toute fonctionnalité correspondante.

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
- structure du répertoire assets ; media est fixé par 7.1 ;
- stratégie de migration lorsque la base contiendra des données importantes.
- politique de conservation locale des transcriptions ;
- cache supprimable ou archive durable ;
- emplacement configurable des snapshots, notamment sur un stockage externe ou NAS ;
- comportement lorsqu'un `Transcript` existe en base mais que sa source distante et son snapshot local sont tous deux indisponibles.

## 17. Questions ouvertes — média

Le correctif 7.1 validé conserve la provenance obligatoire YouTube et les noms sûrs,
délègue la qualité à yt-dlp (res:1080) et préserve les fichiers abandonnés.
Maintenance future, explicitement déclenchée : analyse des orphelins, temporaires
et suppressions interrompues ; sélection et confirmation avant effacement.
Étudier aussi la récupération ou le rattachement de médias complets.
Restent ouverts :
- validation de la fidélité des captures selon les sources et les cadences, au-delà du seek précis implémenté en 7.2 ;
- lecture Web locale et compatibilité des profils/codecs selon les navigateurs ;
- préférences avancées, plusieurs qualités et audio seul ;
- quotas, reprise et rétention des éventuels caches de captures.

## 18. Questions ouvertes — frontend

Le thème Clair / Sombre / Système est ajouté avec des variables CSS et un choix
local au navigateur. L'évaluation d'un éventuel framework CSS (par exemple
Tailwind) reste une question ouverte pour un futur travail d'interface ; aucun
framework ni adoption future n'est décidé par cet ajout.

Ajout de confort validé automatiquement : 80 tests navigateur, tests Go, vet,
builds et typage réussis. Les tests couvrent le suivi dynamique du système,
le choix conservé après rechargement, le stockage refusé et la session de note
(sélection, Undo/Redo, sauvegarde) pendant les changements de thème. Captures
sombres de la bibliothèque, du workspace et de l'écran étroit inspectées.

- évolutions du lecteur YouTube au-delà de l'intégration directe réalisée en 5.3 ;
- lecteur local ;
- layout final de la page de travail ;
- synchronisation player/transcription ;
- comportement des références temporelles au-delà du clic transcription → lecteur de 6.1 ;
- possibilité future de sélection manuelle de la piste de transcription, sans
  catalogue ni persistance supplémentaires dans le correctif de 5.3 ;
- timeline d'annotations ;
- raccourcis clavier.

### Présentation Markdown plus naturelle en Édition — piste UX à étudier

Étudier une présentation inspirée, par exemple, du Live Preview d'Obsidian pour
rendre moins envahissants la syntaxe Markdown, les échappements nécessaires,
les longues URI sillage:// et les références temporelles ou autres éléments enrichis.
Des décorations CodeMirror ou une autre solution adaptée pourraient être comparées.

Il s'agit d'une piste UX, sans décision d'architecture ni implémentation actuelle,
et non d'une refonte engagée pour 6.4 ou automatiquement incluse en 6.5.
Toute expérimentation devra préserver le Markdown brut comme source de vérité,
les positions du curseur et sélections, Undo/Redo, l'autosauvegarde et la lisibilité
de l'application sans IA. Évaluer la révélation de la syntaxe pendant l'édition,
l'accessibilité et les interactions de sélection avant de retenir une solution.

### Découpage naturel des transcriptions — investigation future hors 6.3

YouTube affiche des blocs de durées variables, contrairement aux intervalles fixes
de Sillage. Étudier l'influence possible de la ponctuation, des pauses, de la durée
et de la longueur des blocs. La ponctuation paraît importante mais n'explique pas
tous les découpages observés. Aucune hypothèse de reconnaissance des interlocuteurs
n'est démontrée.

Comparer sur des exemples concrets les frontières affichées par YouTube aux
informations JSON3 : `tStartMs`, `dDurationMs`, `tOffsetMs`, événements et fragments.
Déterminer si les blocs correspondent aux segments JSON3 ou à un autre regroupement.
Évaluer ensuite l'intérêt pour Sillage de phrases ou d'unités de sens ; aucune
méthode de segmentation n'est décidée ni implémentée en 6.3.

Référence : [E2E Segmenter: Joint Segmenting and Decoding for Long-Form ASR — Google Research](https://research.google/pubs/e2e-segmenter-joint-segmenting-and-decoding-for-long-form-asr/).
Ce papier est une piste de recherche sur la segmentation de la parole, et non une
explication vérifiée de l'algorithme de l'interface YouTube.

## 19. Questions ouvertes — API

Le contrat de la tranche initiale est arrêté (voir étape 2 et README).
Le contrat de l'étape 4 bis est également arrêté et implémenté, y compris la
rupture `creator` → objet `publisher`, les associations et parcours de navigation
(voir `03-architecture.md`).
Restent pour des tranches futures : pagination, filtres supplémentaires et combinaisons de filtres, tris configurables
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


### Validation de la première version de 7.1 (avant correctif)

Tests Go, vet, builds et TypeScript réussis ; race detector sur serveur, service,
adapters et REST. Tests déterministes de concurrence, provenance, erreurs, publication,
suppression interrompue, fichier disparu, durée et arrêt des processus descendants.
310 tests Playwright réussis, dont 5 nouveaux parcours média ; captures desktop/mobile
inspectées. Les autres fixtures de lecteur/transcription simulent désormais aussi
l'absence de média pour leurs vidéos fictives.

Essais réels : génération MP4/WebM avec ffmpeg et validation ffprobe ; téléchargement
de jNQXAC9IVRw en local et dans Docker (MP4 AV1/AAC, 19,064s, 533916 octets).
Dans Docker, disponibilité après redémarrage, absence de doublon, suppression physique
et préservation de la note vérifiées. Smoke Compose/outils/Deno/EJS réussi.
BaW_jenozKc était indisponible : échec explicite, aucun résultat média revendiqué.
Le runtime WSL utilisé pour cet essai signalait l'absence de runtime JS ; l'image
Docker embarque Deno. Pas de validation réelle revendiquée pour formation longue,
1080p vertical, doublage ambigu ou lecture Web locale. Ces cas de sélection sont
couverts de manière déterministe, la lecture locale reste hors périmètre.
Avertissement Vite préexistant sur le chunk CodeMirror > 500 kB conservé.

### Validation du correctif de simplification/conservation 7.1

Migration réelle v6 -> v7 avec/sans média restant, compteur AUTOINCREMENT historique
préservé. Tests de fichiers orphelins après restauration d’ancienne base, frontières
de suppression, conflits, chemins dangereux et démarrage malgré une racine média
inutilisable. La finalisation est bloquée par une barrière de test : Get/Start restent
downloading, puis DELETE réussit dès available, sans temporisation corrective.
Les erreurs de commit SQL confirmées et non confirmées préservent les octets.

Sélecteur yt-dlp réel hors réseau : préférence 1080, vertical, repli supérieur,
exclusion des doublages combinés et absence de réextraction après original indisponible.
Formats supplémentaires traversants : MKV dans le parcours REST/SQLite/navigateur ;
ffprobe réel sur MP4/WebM/MKV/MOV. Tests audio et validation de durées conservés.
Go, vet, builds, TypeScript et détecteur de courses réussis ; 310 tests navigateur
passent, les 5 parcours média ont aussi été rejoués après normalisation des chemins.
Collections Postman lintées sans erreur/avertissement ; 45 requêtes et 135 assertions
exécutées et réussies. La CI installe désormais yt-dlp épinglé et ffmpeg pour ne pas
ignorer les tests natifs lorsque les outils ne sont pas préinstallés.

Essai réel jNQXAC9IVRw : WebM, 19,028s en WSL ; WebM AV1/Opus, environ 19,021s
dans Docker. Cycle REST, redémarrage, idempotence, effacement explicite et note
préservée vérifiés. Smoke Docker/Compose réussi. Les petites différences de durée
restent dans la tolérance existante. Les formations longues, pistes multilingues
réelles et vidéos verticales réelles restent à éprouver ; la sélection correspondante
est couverte par les scénarios synthétiques. Aucun lecteur local n’est livré.


### Acquisition simplifiée et métadonnées — correctif livré

Correctif livré : acquisition native en un appel, abandon du filtrage
audio strict, métadonnées techniques nullable et affichage du fichier de la source
de travail. La sélection des transcriptions ne change pas. Réanalyse des anciens
fichiers, édition de audio_language, recherche technique et imports restent futurs.

Validation locale du correctif acquisition/métadonnées (2026-10-16) :
- Go complet, vet/build, TypeScript et 311 tests Playwright réussis ;
- race detector sur services média, stockage et SQLite ;
- migrations v6/v7 vers v8, NULL historiques, relations et AUTOINCREMENT préservés ;
- vrai yt-dlp hors YouTube : formats combinés/séparés, préférence 1080,
  vertical/repli supérieur, original préféré à caractéristiques égales et doublage
  admis sans original ; filtres d'identité/statut refusant les transferts média ;
- ffprobe réel MP4/WebM/MKV/MOV, métadonnées mesurées, règles temporelles conservées ;
- Postman déterministe : 45 requêtes, 135 assertions réussies ;
- build Docker et smoke Compose réussis ;
- cycle YouTube réel dans Docker sur jNQXAC9IVRw : WebM AV1/Opus, 320×240,
  15 images/s, 19 021 ms, 474 494 octets, langue audio NULL. Redémarrage,
  idempotence, suppression physique et note préservée vérifiés.

Aucun nouvel essai réel multilingue n'est revendiqué : ce cas est couvert par le
sélecteur natif sur des fixtures déterministes. L'essai multilingue rapporté par
l'utilisateur reste une observation distincte. La sélection native n'est pas une
garantie universelle d'audio original.

CI vérifiée le 2026-10-17 sur le commit a9168f0 :
[API tests](https://github.com/patrickbrouhard/sillage/actions/runs/38943645236)
réussi (Go/Postman et navigateur), et
[Docker distribution](https://github.com/patrickbrouhard/sillage/actions/runs/38943645358)
réussi. Les étapes Postman ont effectivement exécuté 45 requêtes et 135 assertions,
sans échec ; elles n'ont pas été ignorées.

Validation de distribution : build Docker et smoke test réussis (outils, Compose,
HTTP/SPA, persistance après recréation et arrêt propre). Les 45 requêtes et
135 assertions Postman déterministes existantes passent également.

## Journalisation structurée — préparation des diagnostics

Le plan en cinq incréments est approuvé : socle sûr, HTTP corrélé, opérations
asynchrones, couverture ciblée et distribution. Premier jalon : les erreurs
d'exécution yt-dlp conservent catégorie fermée, code de sortie et classifications
Go, sans recopier stderr. Les règles de repli des captures restent inchangées.


Jalon socle/HTTP : configuration slog, logger contextualisé, bilan unique Chi,
identifiant serveur, catégories de routes et diagnostics de panic contrôlés.
Les adaptations HTTP des incréments 1 et 2 sont regroupées pour éviter une
migration intermédiaire. Les tests couvrent niveaux, confidentialité, HEAD,
Range, streaming, hijack, annulation et panic. Migration asynchrone à suivre.


Jalon asynchrone : corrélation serveur indépendante de HTTP, débuts idempotents,
résultats terminaux, replis et étapes techniques contextualisés. Les sorties
historiques log.Printf des services et du rapprochement sont remplacées.
Tests dédiés : poursuite après déconnexion, repli réussi, interruption à l'arrêt
et identités distinctes pour deux acquisitions de la même source.


Jalon couverture ciblée : imports/réutilisations de vidéos, publishers et
transcriptions réussis ; étapes synchrones yt-dlp ; suppression média confirmée
et rapprochement discriminant restauration, indisponibilité et conservation.
Les erreurs synchrones enrichissent le bilan HTTP unique. Les tests vérifient
l'absence de contenu de connaissance et de chemins hôte dans ces événements.


Jalon distribution et consolidation : format JSON dans l'image, variables
Compose et nom configurable (sillage par défaut), pilote local/20m/5. Le smoke
test isole son nom, contrôle les journaux structurés et les surcharges, puis
exerce une rotation avec un seuil réduit. La CI ajoute les tests de concurrence
sur les composants instrumentés.

Les tests couvrent aussi les commits SQL incertains, le bilan HTTP→service→adapter,
les erreurs d'encodage/écriture et les identités internes validées dans le bilan.
Aucun contrat métier, schéma persistant ou budget de réessai n'a été modifié.

Validation finale : suite Go complète, go vet, builds et tests avec détecteur de
concurrence réussis ; 45 requêtes et 135 assertions Postman déterministes ;
323 tests Web réussis. Le build Docker et le smoke test valident les formats,
les surcharges, la consultation par nom et la rotation effective du pilote local.
Chromium a nécessité libnspr4/libnss3 extraites dans un répertoire temporaire,
sans installation système. Aucun nouveau test réseau YouTube réel n'a été lancé.

## Revue du logging — corrections

Incrément 1 : frontières de repli HLS restaurées ; diagnostics sûrs conservés.
Les tests de validation sans nouvelle résolution complètent les scénarios de
repli, renouvellement 403 et capture locale.

Incrément 2 : récupération locale des panics autour du writer Chi. Tests réels
de panic avant réponse, après en-têtes, écriture et flush (y compris sans corps),
avec bilan unique. Les erreurs serveur restent ERROR après annulation HTTP ;
HEAD, Range, streaming ordinaire, hijack et abandon explicite restent couverts.
