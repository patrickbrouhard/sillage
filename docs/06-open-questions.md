# Open questions

Ce document recense les **décisions non encore prises**, les problèmes à résoudre et les pistes d'évolution de Sillage.

Il ne constitue ni une roadmap ni une liste de fonctionnalités approuvées. La présence d'un sujet ne signifie pas que son implémentation est décidée ou prioritaire.

Les comportements déjà implémentés et les décisions en vigueur sont décrits dans les documents de référence :

- `01-product-and-ux.md` — produit et UX ;
- `02-domain-model.md` — modèle de domaine ;
- `03-architecture.md` — architecture ;
- `04-tech-stack-and-decisions.md` — décisions techniques.

Lorsqu'une question est résolue, reporter la décision dans le document de référence concerné et retirer ou reformuler la question ici.

## 1. Domaine

### 1.1 Notes et annotations

Sillage possède actuellement une note Markdown principale facultative par vidéo, avec sauvegarde et contrôle de révision. Les références temporelles Markdown ne constituent pas des `Annotation` structurées.

Questions ouvertes :

- Une `Annotation` doit-elle toujours être distincte du Markdown ?
- Peut-on transformer explicitement une référence temporelle Markdown en annotation structurée ?
- Comment représenter et modifier une annotation depuis la note ?
- Faut-il permettre la création d'annotations indépendantes de la note ?
- Faut-il prévoir des types d'annotations ou une catégorisation ?
- Dans quels cas plusieurs notes par vidéo seraient-elles utiles ?
- Faut-il permettre la suppression explicite d'une note, avec quelle sémantique pour une note vide ou absente ?
- Un historique des versions de notes apporterait-il une valeur suffisante au-delà du contrôle de révision existant ?

Ne pas introduire de synchronisation automatique entre Markdown et annotations sans avoir défini et testé le workflow correspondant.

### 1.2 Identité et sources vidéo

`Video` représente l'objet métier indépendant de ses `VideoSource`. Un `MediaFile` constitue une représentation physique locale, pas une nouvelle vidéo.

Questions ouvertes :

- Comment identifier qu'une source provenant d'une autre plateforme correspond à une `Video` existante ?
- Faut-il permettre d'associer plusieurs sources externes à une vidéo existante, et selon quelles règles ?
- Comment gérer les métadonnées divergentes entre plusieurs sources d'une même vidéo ?
- Faut-il introduire une source principale persistée, ou conserver un choix dépendant du contexte ?
- Pour une véritable `VideoSource` locale, quelle identité, quelle déduplication et quelles métadonnées retenir ?
- Comment distinguer l'import d'un fichier local de la conservation d'un `MediaFile` téléchargé depuis une source distante ?
- Quelles plateformes ou catégories de sources supplémentaires justifieraient une implémentation ?

Le support des sources locales et des providers supplémentaires reste distinct de la lecture des fichiers déjà téléchargés, qui est implémentée.

### 1.3 Métadonnées et publishers

Questions ouvertes :

- Quels champs de métadonnées supplémentaires sont réellement utiles ?
- Quels champs peuvent être rafraîchis depuis leur source, et selon quelle politique : manuelle, automatique ou périodique ?
- Comment préserver les modifications utilisateur lors d'un rafraîchissement ?
- Faut-il permettre des surcharges utilisateur, notamment pour le titre affiché ?
- Comment choisir le titre représentatif d'une vidéo possédant plusieurs sources ?
- Quelle sémantique attribuer aux futures dates de modification d'une vidéo, en distinguant changements utilisateur et rafraîchissements externes ?
- Comment rafraîchir les métadonnées d'un `Publisher`, notamment lorsque son nom est absent ?
- Comment identifier les publishers des futurs providers ?
- Comment protéger les associations explicites de personnes et de publishers lors des actualisations ?
- Faut-il représenter les collaborations, rôles ou organisations liés aux contenus ?

Ces possibilités ne doivent pas introduire de rapprochement automatique entre personnes et publishers sans règle métier explicite.

### 1.4 Temps, références et provenance

Les références temporelles utilisent actuellement des identités explicites de vidéo et de source, avec un `start_ms`. Les captures sont également rattachées à leur source.

Questions ouvertes :

- Comment représenter une plage temporelle avec début et fin facultative, notamment via le paramètre réservé `end_ms` ?
- Comment ajuster les bornes d'une plage depuis l'interface ?
- Une annotation structurée doit-elle référencer directement une `VideoSource`, une timeline de référence ou une autre abstraction ?
- Comment gérer les références entre sources dont les timelines ne correspondent pas exactement ?
- Faut-il permettre l'ouverture d'une autre fiche vidéo ou d'une autre source depuis une référence temporelle, avec quelles règles de confirmation et de navigation ?
- Comment rattacher temporellement de futurs assets ou clips à leur source d'origine ?
- Dans quels cas une synchronisation ou une conversion entre timelines serait-elle nécessaire ?

Aucun modèle générique de timeline ni mécanisme de synchronisation inter-sources n'est décidé.

## 2. Stockage et persistance

### 2.1 SQLite et migrations

Les identités, le driver SQLite et le système initial de migrations sont déjà choisis et implémentés.

Restent à évaluer :

- Quels index supplémentaires seront nécessaires avec l'augmentation du volume de données ?
- L'activation du mode WAL apporte-t-elle un bénéfice réel pour les usages concurrents de Sillage ?
- À partir de quel niveau de complexité faudrait-il envisager Goose ou un autre outil de migrations ?
- Comment sécuriser les migrations sur une base contenant des données utilisateur importantes ?
- Quelle stratégie de sauvegarde et de restauration de SQLite adopter ?
- Quels tests de restauration et de migration sont nécessaires avant une distribution plus large ?

### 2.2 Cycle de vie et suppression des données

Questions ouvertes :

- Quelle politique de suppression adopter selon les entités : suppression physique, cascade contrôlée ou suppression logique ?
- Comment supprimer une personne ou un publisher sans perdre ou altérer les associations utilisateur encore pertinentes ?
- Quelle politique appliquer aux tags devenus inutilisés ?
- Faut-il permettre le renommage, la fusion ou la suppression globale des tags ?
- Comment distinguer les données utilisateur durables des caches et représentations techniques pouvant être reconstruits ?

Les règles de conservation déjà implémentées ne doivent pas être modifiées implicitement par l'introduction d'une opération de nettoyage.

### 2.3 Transcriptions et snapshots

Les transcriptions sont actuellement persistées avec un snapshot JSON3 local après acquisition réussie. Le GET ne déclenche pas de nouvelle acquisition distante.

Questions ouvertes :

- Les snapshots doivent-ils constituer des archives durables ou des caches supprimables ?
- Quelle politique de rétention appliquer aux anciennes versions et aux fichiers devenus orphelins ?
- Faut-il permettre un emplacement de stockage configurable, notamment sur un NAS ?
- Que faire lorsqu'une transcription existe en base mais que son snapshot local et sa source distante sont indisponibles ?
- Le contrat de consultation doit-il évoluer si les snapshots ne sont plus systématiquement conservés ?
- Une future sélection explicite de pistes nécessite-t-elle la persistance d'un identifiant de piste propre au provider ?
- Faut-il proposer des outils de vérification et de réparation des transcriptions stockées ?

### 2.4 Assets et organisation des fichiers

Questions ouvertes :

- Faut-il permettre de configurer séparément les emplacements des médias, captures, transcriptions et autres données volumineuses ?
- Comment inventorier et retrouver les fichiers sans référence persistante ?
- Quelle politique de sauvegarde et de restauration garantirait la cohérence entre SQLite et les fichiers ?
- Quels outils de maintenance seraient utiles pour identifier des fichiers manquants, abandonnés ou corrompus ?

## 3. Médias et acquisitions

### 3.1 Conservation et maintenance des médias

Le téléchargement volontaire, la conservation d'un `MediaFile`, ses métadonnées techniques, la suppression explicite et la lecture locale sont implémentés.

Questions ouvertes :

- Faut-il permettre de réanalyser les anciens fichiers pour compléter leurs métadonnées techniques ?
- Quelle politique adopter pour la modification ou la correction manuelle de certaines métadonnées, notamment la langue audio ?
- Comment détecter les fichiers orphelins, les temporaires abandonnés et les suppressions interrompues ?
- Comment proposer leur récupération, leur rattachement ou leur suppression après confirmation ?
- Comment importer et rattacher des médias déjà présents sur le disque ?
- Faut-il permettre plusieurs représentations d'une même source : différentes qualités, formats ou pistes audio ?
- Faut-il proposer le téléchargement audio seul ?
- Quelles limites de stockage, de concurrence et de ressources introduire si les besoins augmentent ?
- Un système de jobs persistants, de file d'attente ou de reprise après interruption serait-il justifié pour certaines opérations longues ?

La maintenance ne doit pas entraîner de suppression automatique de données conservées volontairement sans politique explicitement approuvée.

### 3.2 Lecture et compatibilité

La lecture locale repose actuellement sur le lecteur HTML5 natif. Les fichiers téléchargés ne sont pas automatiquement convertis.

Questions ouvertes :

- Quelle politique adopter pour les fichiers dont le conteneur ou les codecs ne sont pas pris en charge par un navigateur ?
- Faut-il proposer une conversion explicite, un format alternatif ou un avertissement de compatibilité ?
- Quels profils et codecs faut-il tester sur les navigateurs cibles ?
- Comment gérer à terme les préférences de qualité, de piste audio et de sous-titres ?
- Faut-il proposer la lecture audio en arrière-plan lorsque le panneau vidéo est masqué ?

Les problèmes éventuels de compatibilité doivent être évalués avant de décider d'introduire une chaîne de transcodage.

### 3.3 Captures et bibliothèque d'images

La génération de captures PNG, leur conservation sous forme d'`Asset`, leur insertion et réinsertion dans la note et le catalogue Images par vidéo avec agrandissement sont implémentés. Les règles actuelles de consultation figurent dans [Product & UX](01-product-and-ux.md#67-images-de-la-vidéo).

Évolutions à étudier :

- Import d'images externes.
- Suppression explicite des assets et gestion de leurs références.
- Sélection et insertion de plusieurs captures.
- Navigation vers le passage vidéo correspondant à une capture.
- Gestion des captures dont la génération continue après navigation.
- Indicateurs d'activité accessibles en dehors de la page d'origine.

Questions techniques :

- Quel degré de fidélité temporelle et visuelle peut être garanti selon les sources, formats et cadences ?
- Quelle politique de quotas, de reprise et de rétention adopter si des caches de captures sont introduits ?
- Comment gérer les références Markdown lorsqu'un asset est explicitement supprimé ?

#### Piste : usages des assets dans les notes (non décidée)

Le compteur actuel d'Images analyse le brouillon Markdown de la note courante tant que le sélecteur est ouvert. Il aide à repérer les captures déjà insérées et suit les modifications non sauvegardées, sans offrir de vue globale sur les usages.

**Orientation à explorer, sans engagement d'implémentation :** envisager une projection SQLite reconstructible des références d'`Asset` dans les notes **enregistrées**, plutôt qu'une association métier modifiable indépendamment du texte.

Le Markdown resterait la source de vérité. Une relation note (identifiée par `video_id`) / asset pourrait conserver le nombre d'occurrences, y compris lorsqu'une note cite un asset d'une autre vidéo.

À l'image de l'index FTS5, cette projection pourrait être recalculée lors d'une sauvegarde acceptée modifiant la note, dans la même transaction, et reconstruite à partir des notes existantes. Elle compléterait le compteur local, qui continuerait à refléter le brouillon en cours d'édition.

Cette projection pourrait alimenter une future galerie globale : nombre d'utilisations, notes et vidéos référençant une image, captures **sans référence dans les notes enregistrées**. Une capture non référencée n'est pas nécessairement inutile, ni un fichier orphelin sur le disque ; cet état n'autoriserait aucune suppression automatique.

**Questions avant décision :**

- Quelle sémantique donner aux occurrences (images réellement rendues, références indirectes, callouts) et comment assurer la cohérence entre les parseurs Markdown Go et React ?
- Une analyse à la demande des notes enregistrées serait-elle suffisante, ou le volume et les usages justifieraient-ils une projection persistée ?
- Quels contrats de consultation, garanties de reconstruction et traitements des conflits de sauvegarde seraient nécessaires ?

Aucune table, API, fonctionnalité de gestion ni échéance ne sont décidées. L'indexation d'autres références Markdown (temps, citations, annotations, clips) reste une piste distincte, sans abstraction générique anticipée.

### 3.4 Clips vidéo durables

**Piste exploratoire, sans modèle ni implémentation décidés.**

Workflow envisagé : conserver un média complet, identifier des passages utiles, produire des clips durables, puis éventuellement supprimer le média complet sans perdre les clips et les connaissances associées.

Questions ouvertes :

- Un clip doit-il être représenté par une extension d'`Asset`, un `MediaFile` ou une nouvelle entité ?
- Quelle identité et quelle provenance conserver ?
- Comment représenter la source d'origine et les bornes temporelles canoniques ?
- Quelle précision de découpe garantir ?
- Dans quels cas un réencodage serait-il nécessaire ou acceptable ?
- Comment insérer, consulter et naviguer vers un clip depuis une note Markdown ?
- Les références doivent-elles utiliser la timeline du clip, celle de la source d'origine ou les deux ?
- Comment conserver un clip indépendamment du fichier complet ayant permis sa génération ?
- Comment gérer sa suppression, ses références et ses éventuels échecs de génération ?
- Comment protéger le média complet pendant une génération concurrente avec sa suppression ?
- L'export d'un clip vers un fichier externe doit-il constituer une fonction distincte de sa conservation interne ?

Aucune migration, API, opération de découpe ou fonction d'export ne découle automatiquement de cette piste.

## 4. Frontend et expérience utilisateur

### 4.1 Workspace et navigation

Le workspace dispose actuellement de panneaux Lecteur, Note et Transcription, d'une lecture YouTube/Local et d'une interface responsive. Les récentes refontes ont également introduit les onglets Note/Informations, la navigation globale, l'en-tête compact et les surfaces vidéo 16:9.

Évolutions à étudier :

- Redimensionnement manuel des panneaux et séparation déplaçable.
- Arbitrage entre largeur du lecteur, ratio vidéo et hauteur disponible lors d'un redimensionnement.
- Possibilité de détacher le lecteur dans une autre fenêtre.
- Préférences de disposition du workspace, si un besoin réel apparaît.
- Système global de notifications temporaires, distinct des messages contextuels existants.
- Raccourcis clavier supplémentaires et éventuelle personnalisation.
- Reprise de la position de lecture entre sessions.
- Suivi de progression ou état de visionnage des vidéos.

Pour une éventuelle reprise de lecture, déterminer notamment la persistance, la fréquence de sauvegarde, le choix de la source et le comportement à la réouverture.

Les validations manuelles non encore réalisées sur certains environnements constituent des tâches de recette, pas des décisions de conception.

### 4.2 Éditeur Markdown et références enrichies

CodeMirror intègre déjà plusieurs améliorations de présentation : callouts, références temporelles compactes, navigation en Édition, Live Preview des titres ATX H1–H6 racine, typographie commune et conservation de la session d'édition.

Questions ouvertes :

- Jusqu'où aller vers une présentation de type Live Preview, inspirée notamment d'Obsidian ?
- Quels éléments Markdown supplémentaires mériteraient une représentation visuelle enrichie ?
- Quelles règles de révélation conviendraient aux futurs éléments, notamment Setext et titres imbriqués, en préservant le curseur, les sélections, Undo/Redo et l'autosauvegarde ?
- Comment présenter et éditer les futures plages temporelles ?
- Faut-il permettre l'insertion rapide de différents objets depuis un menu commun : image, référence temporelle, citation, annotation ou clip ?
- Faut-il enrichir les actions de copie et d'export pour produire un Markdown plus facilement exploitable hors de Sillage ?

Toute évolution doit préserver le Markdown brut comme source de vérité et les garanties actuelles de l'éditeur.

### 4.3 Transcriptions

Sillage propose actuellement la consultation, la recherche locale, la sélection et la citation de transcriptions automatiques YouTube, avec regroupement de présentation fixe.

Questions ouvertes :

- Faut-il permettre la sélection manuelle d'une autre piste de transcription ?
- Comment présenter plusieurs langues ou différentes provenances pour une même vidéo ?
- Faut-il prendre en charge les sous-titres manuels, les traductions ou les transcriptions corrigées ?
- Comment distinguer un contenu source d'une version enrichie ou corrigée ?
- Faut-il introduire une synchronisation automatique entre la position du lecteur et le défilement de la transcription ?
- Les fragments temporels doivent-ils être regroupés en phrases ou en unités de sens plutôt qu'en blocs fixes ?
- Comment identifier les changements d'interlocuteur si le besoin apparaît, sans supposer que JSON3 fournit une diarisation fiable ?

**Investigation sur la segmentation naturelle**

Comparer les frontières affichées par YouTube avec les informations JSON3 (`tStartMs`, `dDurationMs`, `tOffsetMs`, événements et fragments), ainsi qu'avec la ponctuation et les pauses éventuelles.

Aucune explication de l'algorithme de regroupement de YouTube n'est actuellement démontrée. Aucune méthode de segmentation naturelle ni de reconnaissance des interlocuteurs n'est retenue.

Référence de recherche : [E2E Segmenter — Google Research](https://research.google/pubs/e2e-segmenter-joint-segmenting-and-decoding-for-long-form-asr/).

### 4.4 Gestion des entités et classement

Questions ouvertes :

- Comment exposer complètement dans l'interface Web les publishers et personnes déjà disponibles par REST ?
- Comment présenter la distinction entre une personne, ses vidéos directement associées et celles publiées par ses publishers ?
- Faut-il proposer des tags hiérarchiques, des alias, des catégories ou des couleurs individuelles ?
- Quelles fonctions de gestion avancée du catalogue de tags seraient réellement utiles ?
- Comment faire évoluer les filtres et le classement de la bibliothèque sans compliquer les interactions courantes ?

### 4.5 Choix techniques d'interface

- Un framework CSS supplémentaire, comme Tailwind, apporterait-il un avantage suffisant par rapport aux styles existants ?
- Dans quels cas une bibliothèque de composants ou de lecteurs justifierait-elle une nouvelle dépendance ?
- Quels besoins concrets pourraient motiver une évolution de l'architecture frontend actuelle ?

Aucune adoption de framework supplémentaire n'est décidée.

## 5. API et recherche

### 5.1 Évolutions REST

Les contrats REST existants sont implémentés et décrits dans la documentation d'architecture.

Évolutions à étudier :

- Pagination des collections.
- Filtres supplémentaires et combinaisons de filtres.
- Tri configurable.
- Extension de la recherche textuelle et filtres avancés.
- Authentification et autorisations, si l'application évolue au-delà de son usage local actuel.
- Contrats supplémentaires pour les futures annotations, clips, imports et fonctions de gestion.

Éviter d'introduire une infrastructure générique avant qu'un cas d'usage concret ne la nécessite.

### 5.2 Extensions de recherche

La V1 FTS5 recherche les vidéos par leurs sources, publishers, tags directs et notes, avec indexation transactionnelle, reconstruction et pagination. Les décisions applicables sont décrites dans les documents 01 à 04.

Restent à étudier :

- Quelle représentation dérivée des transcriptions permettra la recherche de passages avec provenance et timestamps ?
- Comment naviguer depuis un passage trouvé vers la vidéo, source et position concernées ?
- Quels filtres avancés et tris configurables apporteraient un bénéfice concret ?
- Faut-il proposer correction orthographique, expressions exactes ou recherche instantanée ?
- Quels besoins justifieraient une segmentation linguistique supplémentaire, des alias ou une recherche sémantique ?
- Quand et comment intégrer les futurs artefacts IA aux résultats ?

## 6. MCP

La première tranche de quatre lectures locales et son transport sont définis dans
[MCP](mcp.md). Les futurs arbitrages concernent :

- Quel modèle d’authentification, de permissions et d’exposition homelab retenir pour
  l’ensemble du serveur, y compris les écritures REST ?
- Quelles écritures MCP apportent une valeur suffisante, avec quelles confirmations,
  préconditions de révision et garanties de conservation ?
- Si des clients tronquent les transcriptions représentatives, faut-il agir sur leur
  configuration, les plafonds ou un futur contrat de lecture de contenus longs ?
- Quels besoins concrets justifieraient resources, opérations longues ou autres capacités
  supplémentaires, sans les anticiper dans la V1 ?

## 7. Intelligence artificielle

### 7.1 Intégration et fournisseurs

Questions ouvertes :

- Quel provider ou modèle utiliser en priorité ?
- Faut-il permettre plusieurs providers locaux et distants ?
- Quelle interface commune est nécessaire entre les différents moteurs ?
- Comment gérer la configuration, les identifiants et les éventuelles limites d'utilisation ?
- Quelle place donner aux traitements locaux ou hors ligne ?

### 7.2 Résultats et provenance

Fonctions candidates : résumés, suggestions de tags, chapitrage, questions/réponses, extraction d'informations et enrichissement des transcriptions.

Questions ouvertes :

- Quels résultats doivent être conservés ?
- Une entité `AIArtifact` est-elle justifiée, et sous quelle forme ?
- Comment conserver les prompts, paramètres et modèles utilisés ?
- Comment gérer le versionnement et la régénération ?
- Quelle provenance faut-il conserver ?
- Comment faire valider les tags ou informations générés ?
- Comment distinguer les données source des interprétations et corrections produites par une IA ?

### 7.3 Recherche et traitement de contenus longs

- Comment gérer les limites de contexte sur de longues transcriptions ?
- Faut-il utiliser des embeddings, une recherche hybride ou d'autres mécanismes de récupération ?
- Dans quels cas une base vectorielle serait-elle réellement nécessaire ?
- Comment relier les réponses générées à des passages vérifiables, avec leurs sources et timestamps ?

### 7.4 Reconnaissance vocale

- Quel moteur STT envisager lorsqu'aucune transcription exploitable n'est disponible ?
- Faut-il générer des transcriptions localement, via un service distant ou les deux ?
- Comment représenter leur provenance, leurs langues et leurs éventuelles corrections ?
- La diarisation doit-elle être envisagée comme une fonctionnalité distincte ?

Aucun moteur STT ni modèle de diarisation n'est choisi.

## 8. Produit et distribution

### 8.1 Bibliothèque et organisation

Évolutions à évaluer :

- Collections et playlists.
- Favoris.
- États de lecture et suivi de progression.
- Vues sauvegardées.
- Tri et classement avancés.
- Relations supplémentaires entre vidéos, personnes et publishers.

Le besoin réel doit guider la priorité de ces fonctionnalités.

### 8.2 Import, export et portabilité

Questions ouvertes :

- Quels formats d'import et d'export proposer ?
- Comment exporter les notes en conservant ou en adaptant les références propres à Sillage ?
- Faut-il distinguer un export Markdown de consultation et une sauvegarde complète réimportable ?
- Comment garantir la portabilité des notes, assets, clips et métadonnées ?
- Quelle procédure guidée ou automatisée proposer pour restaurer l'ensemble des données sur une autre installation ? La [restauration manuelle à froid](../README.md#sauvegarde-à-froid-sous-docker) est déjà documentée.
- Faut-il proposer un outil de migration ou d'import depuis d'autres applications ?

### 8.3 Distribution et intégrations

- Quels modes de packaging et d'installation privilégier ?
- Faut-il envisager une application desktop native, éventuellement avec Wails ?
- Une extension navigateur facilitant l'ajout de vidéos serait-elle utile ?
- Quelles intégrations externes mériteraient d'être développées ?
- Quelle politique de licences et de distribution adopter ?

### 8.4 Identité du produit et utilisateurs

- Quels éléments de l'identité visuelle restent à définir ou à stabiliser ?
- Faut-il envisager plusieurs utilisateurs, comptes ou espaces de travail ?
- Quelles exigences d'authentification, d'isolation des données et de permissions en découleraient ?
- Comment préserver la simplicité d'une installation personnelle si ces fonctions apparaissent plus tard ?

Aucune architecture multi-utilisateur n'est actuellement décidée.
