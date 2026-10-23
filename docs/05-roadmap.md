# Roadmap — Sillage

Dernière consolidation : 22 octobre 2026.

Ce document donne **l'état d'avancement et les prochaines directions de développement**. Il ne décrit ni les contrats techniques en vigueur, ni le détail des tests effectués à chaque commit, ni toutes les décisions encore ouvertes.

- **Spécifications actuelles** : [Product & UX](01-product-and-ux.md), [Domain model](02-domain-model.md), [Architecture](03-architecture.md) et [Tech stack & decisions](04-tech-stack-and-decisions.md).
- **Décisions non prises et pistes à étudier** : [Open questions](06-open-questions.md).
- **Validation manuelle du lecteur et du workspace** : [Recette de non-régression](07-local-playback-validation.md).
- **Raisons de certains arbitrages passés** : [Historique d'octobre 2026](history/sillage-decisions-octobre-2026.md).

## 1. État actuel

**Le socle fonctionnel de Sillage est en place.** Il est possible d'ajouter une vidéo YouTube, de la retrouver dans la bibliothèque, de la consulter, de prendre des notes Markdown, de travailler avec sa transcription et ses références temporelles, de conserver son média localement et de produire des captures.

Les dernières tranches ont également apporté la lecture locale, la journalisation structurée et la réorganisation de la fiche vidéo (navigation, en-tête, onglets, panneaux et surfaces de lecture).

**Prochaine grande étape prévue : étape 8 — recherche globale.** Son périmètre exact doit être cadré avant le développement. Les étapes 9 (MCP) et 10 (IA intégrée) restent prévues ensuite, sans calendrier arrêté. Des améliorations ponctuelles ou des travaux de stabilisation peuvent s'intercaler selon les besoins.

### Jalons réalisés

| Jalon | Résultat principal | État |
| --- | --- | --- |
| 0 — Preuve de concept | Extraction et normalisation des métadonnées YouTube avec `yt-dlp` | Réalisé |
| 1 — Domaine et SQLite | `Video` / `VideoSource`, persistance et migrations | Réalisé |
| 2 — API HTTP | Premiers cas d'usage accessibles par REST | Réalisé |
| 3 — Transcriptions YouTube | Acquisition, snapshot et consultation des transcriptions | Réalisé |
| 4 et 4 bis — Données utilisateur | Notes, tags, publishers, personnes et associations | Réalisé |
| 5 — Interface Web | Bibliothèque, fiche vidéo, lecteur YouTube, éditeur Markdown et sauvegarde fiable | Réalisé |
| 6 — Interactions temporelles | Recherche dans une transcription ouverte, citations, références Markdown et navigation | Réalisé |
| UX 1 — Confort de rédaction | Callouts, présentation de l'éditeur et références compactes/interactives | Réalisé |
| 7 — Médias | Téléchargement et conservation des fichiers, captures PNG | Réalisé |
| Consolidations postérieures | Journalisation structurée, lecture locale, ergonomie du lecteur et nouvelle disposition du workspace | Réalisé |

Ce tableau résume les capacités livrées ; il ne vaut pas une validation exhaustive de chaque navigateur ou scénario réel. Les contrats actuels se trouvent dans les documents 01 à 04. Les commits, PR et anciennes versions Git conservent le détail des implémentations et de leurs validations.

## 2. Prochaine étape prévue — Étape 8 : recherche globale

### Objectif

Retrouver une vidéo et, à terme, un **passage précis** à partir de son contenu textuel, au-delà de la recherche déjà disponible à l'intérieur d'une transcription ouverte.

### 8.1 — Première recherche transversale

**Périmètre candidat à confirmer :**

- recherche sur le titre et les métadonnées utiles ;
- prise en compte des tags ;
- éventuellement, recherche dans les notes ;
- affichage de résultats permettant d'ouvrir directement la vidéo correspondante.

La portée exacte, les filtres et le classement des résultats restent à définir. Privilégier une première tranche simple et fonctionnelle plutôt qu'une abstraction prématurée.

### 8.2 — Recherche plein texte avec SQLite FTS5

**Direction technique privilégiée :** étendre la recherche aux notes, transcriptions et, plus tard, aux autres contenus textuels pertinents.

- Indexer une représentation textuelle dérivée des transcriptions, sans imposer la persistance de chaque fragment temporel comme une ligne SQLite.
- Pouvoir identifier le passage correspondant et retrouver sa source et son timestamp.
- Définir la mise à jour de l'index lors des modifications et acquisitions.
- Faire évoluer la présentation des résultats et la navigation selon les besoins observés.

**Critère de sortie visé :** une recherche sur des mots prononcés dans une vidéo peut retourner la vidéo, le passage pertinent et une position permettant de l'ouvrir au bon endroit.

Les questions de périmètre, d'indexation, de pertinence et de navigation sont recensées dans [Open questions — API et recherche](06-open-questions.md#5-api-et-recherche).

## 3. Étape 9 — MCP

### Objectif

Permettre à des agents externes d'utiliser les capacités métier de Sillage **sans accès direct à SQLite ou à `yt-dlp`**. Le serveur MCP s'appuiera sur les services applicatifs existants.

Outils envisagés, sans contrat encore figé : `search_videos`, `get_video`, `get_transcript`, `get_annotations`, `add_tags`, `append_note`.

**Critère de sortie visé :** un agent peut rechercher des vidéos, retrouver des passages de transcription et exploiter les informations correspondantes via MCP. Les capacités d'écriture nécessiteront un cadrage explicite de leurs permissions et garanties.

Le choix des outils, des ressources éventuelles, du transport et des règles de confirmation demeure ouvert : voir [Open questions — MCP](06-open-questions.md#6-mcp).

## 4. Étape 10 — IA intégrée

### Objectif

Ajouter des fonctions d'assistance exploitant les données déjà disponibles, **sans rendre l'IA obligatoire pour consulter et annoter les vidéos**.

Fonctions candidates : résumés, suggestions de tags, chapitrage, points clés, questions/réponses et extraction d'informations à partir des transcriptions.

L'intégration devra être cadrée en fonction des cas d'usage : fournisseurs, traitement des longues transcriptions, validation des résultats, conservation et provenance. Une éventuelle entité `AIArtifact` reste à décider.

Voir [Open questions — Intelligence artificielle](06-open-questions.md#7-intelligence-artificielle).

## 5. Évolutions possibles, non planifiées

Ces pistes **ne constituent ni des jalons approuvés ni un ordre de priorité**. Elles sont à reconsidérer selon les besoins réels ; les décisions de conception correspondantes se trouvent dans [Open questions](06-open-questions.md).

- **Sources et transcriptions** : import de fichiers locaux, autres plateformes, choix de pistes, STT et enrichissements de transcription.
- **Bibliothèque et connaissance** : annotations structurées, plages temporelles, gestion avancée des tags et des personnes, collections, playlists et vues sauvegardées.
- **Médias** : galerie d'images, réinsertion et gestion des captures, clips durables, qualités multiples et audio seul.
- **Expérience de travail** : panneaux redimensionnables, reprise de lecture entre sessions, notifications et présentation Markdown enrichie.
- **Distribution et intégrations** : extension navigateur, version desktop éventuelle (par exemple avec Wails), import/export et sauvegarde complète.

Ne pas déduire de leur présence ici qu'il faut anticiper leur modèle ou leurs dépendances dès maintenant.

## 6. Définition des jalons MVP

### MVP technique — atteint

Chaîne validée : **URL YouTube → extraction `yt-dlp` → modèle Go → SQLite → API REST → transcription**.

### MVP produit — partiellement atteint

Le périmètre initial envisagé comprend : ajout de vidéo, bibliothèque, fiche vidéo, lecteur, notes Markdown, tags, transcription, insertion/navigation par timestamp et **recherche de base**.

Les capacités précédant la recherche sont en place. **La recherche globale de base reste à livrer** pour atteindre cette définition initiale. Les téléchargements et les captures, envisagés comme extensions possibles, ont déjà été réalisés.

MCP et IA ne conditionnent pas ce jalon.

## 7. Règles de maintenance de cette roadmap

- Mettre à jour en priorité **l'état actuel**, **le prochain jalon** et les **jalons réalisés** à la clôture d'une tranche significative.
- Garder les objectifs et critères des étapes futures, sans y verser les comptes rendus d'implémentation, nombres de tests ou recettes manuelles.
- Reporter les spécifications validées dans les documents 01 à 04 et les décisions non résolues dans `06-open-questions.md`.
- Ne conserver un arbitrage historique dans `history/` que lorsque sa justification reste utile ; Git et les PR documentent les changements ordinaires.
- Privilégier des **vertical slices** petits et validables, sans généralisation anticipée.
