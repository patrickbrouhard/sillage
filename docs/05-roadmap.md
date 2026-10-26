# Roadmap — Sillage

Dernière consolidation : 26 octobre 2026.

Ce document donne **l'état d'avancement et les prochaines directions de développement**. Il ne décrit ni les contrats techniques en vigueur, ni le détail des tests effectués à chaque commit, ni toutes les décisions encore ouvertes.

- **Spécifications actuelles** : [Product & UX](01-product-and-ux.md), [Domain model](02-domain-model.md), [Architecture](03-architecture.md) et [Tech stack & decisions](04-tech-stack-and-decisions.md).
- **Décisions non prises et pistes à étudier** : [Open questions](06-open-questions.md).
- **Validation manuelle du lecteur et du workspace** : [Recette de non-régression](07-local-playback-validation.md).
- **Raisons de certains arbitrages passés** : [Historique d'octobre 2026](history/sillage-decisions-octobre-2026.md).

## 1. État actuel

**Le socle fonctionnel de Sillage est en place.** Il est possible d'ajouter une vidéo YouTube, de la retrouver dans la bibliothèque, de la consulter, de prendre des notes Markdown, de travailler avec sa transcription et ses références temporelles, de conserver son média localement, de produire des captures et de consulter/réinsérer les images de chaque vidéo.

Les dernières tranches ont également apporté la lecture locale, la journalisation structurée et la réorganisation de la fiche vidéo (navigation, en-tête, onglets, panneaux et surfaces de lecture).

**La recherche globale FTS5 (étape 8) et la première tranche MCP locale en lecture seule
sont implémentées.** Les essais MCP avec agents et transcriptions représentatives restent
à compléter, notamment avec un modèle local. L’IA intégrée reste une direction future,
sans calendrier arrêté.

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
| UX 2 — Mise en forme contextuelle | Barre de sélection Markdown, titres ATX et création de lien ; sans Live Preview ni nouveaux raccourcis | Réalisé (V1) |
| 7 — Médias | Téléchargement et conservation des fichiers, captures PNG, consultation et réinsertion par vidéo | Réalisé |
| 8 — Recherche globale | FTS5 transactionnel, notes et métadonnées, API et parcours Web paginés | Réalisé |
| 9 — Première tranche MCP | Quatre lectures locales sur services partagés, transport HTTP stateless optionnel | Implémenté ; validation agents partielle |
| Consolidations postérieures | Journalisation structurée, lecture locale, ergonomie du lecteur et nouvelle disposition du workspace | Réalisé |

Ce tableau résume les capacités livrées ; il ne vaut pas une validation exhaustive de chaque navigateur ou scénario réel. Les contrats actuels se trouvent dans les documents 01 à 04. Les commits, PR et anciennes versions Git conservent le détail des implémentations et de leurs validations.

## 2. Étape 8 — Recherche globale réalisée

La V1 retrouve une vidéo à partir des titres/descriptions de toutes ses sources, publishers, tags directs et texte dérivé de sa note. Elle apporte une projection SQLite FTS5 cohérente avec les écritures, une reconstruction versionnée, un service partagé, REST et un parcours Web paginé avec extraits et explications.

Les contrats actuels figurent dans [Product & UX](01-product-and-ux.md), [Architecture](03-architecture.md) et [Tech stack & decisions](04-tech-stack-and-decisions.md). La recherche de passages de transcription, la navigation temporelle depuis les résultats, les filtres avancés et la recherche sémantique restent des extensions futures, distinctes de cette étape.

## 3. Étape 9 — MCP

La première tranche expose `search_videos`, `get_video`, `get_transcript` et `get_note`
sur le serveur Go existant, en lecture locale stricte, sans accès direct des agents à SQLite
ou aux outils externes. Les contrats et la recette reproductible vivent dans [MCP](mcp.md).

Des parcours réels Codex sur corpus synthétiques et captions publiques préparées, ainsi
qu’un déploiement Docker isolé, ont été vérifiés. Restent les essais
avec un hôte MCP utilisant un modèle local, les autres transcriptions représentatives et une caractérisation plus large des limites
client/contexte. Une troncature client
éventuelle devra être arbitrée avant de changer le contrat.

Suites distinctes, non incluses dans cette livraison :

- sécurité homelab couvrant l’ensemble du serveur et les écritures REST ;
- éventuelles écritures MCP, permissions, confirmations et protection des données utilisateur.

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
- **Médias** : import d'images, gestion et suppression explicite des captures, clips durables, qualités multiples et audio seul. La consultation et la réinsertion par vidéo sont déjà réalisées.
- **Expérience de travail** : panneaux redimensionnables, reprise de lecture entre sessions, notifications et présentation Markdown enrichie.
- **Distribution et intégrations** : extension navigateur, version desktop éventuelle (par exemple avec Wails), import/export et sauvegarde complète.

Ne pas déduire de leur présence ici qu'il faut anticiper leur modèle ou leurs dépendances dès maintenant.

## 6. Définition des jalons MVP

### MVP technique — atteint

Chaîne validée : **URL YouTube → extraction `yt-dlp` → modèle Go → SQLite → API REST → transcription**.

### MVP produit — atteint

Le périmètre initial envisagé comprend : ajout de vidéo, bibliothèque, fiche vidéo, lecteur, notes Markdown, tags, transcription, insertion/navigation par timestamp et **recherche de base**.

Ces capacités, y compris la recherche globale de base, sont en place. Les téléchargements et les captures, envisagés comme extensions possibles, ont déjà été réalisés.

MCP et IA ne conditionnent pas ce jalon.

## 7. Règles de maintenance de cette roadmap

- Mettre à jour en priorité **l'état actuel**, **le prochain jalon** et les **jalons réalisés** à la clôture d'une tranche significative.
- Garder les objectifs et critères des étapes futures, sans y verser les comptes rendus d'implémentation, nombres de tests ou recettes manuelles.
- Reporter les spécifications validées dans les documents 01 à 04 et les décisions non résolues dans `06-open-questions.md`.
- Ne conserver un arbitrage historique dans `history/` que lorsque sa justification reste utile ; Git et les PR documentent les changements ordinaires.
- Privilégier des **vertical slices** petits et validables, sans généralisation anticipée.
