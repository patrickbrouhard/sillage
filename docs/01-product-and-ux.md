# Product & UX

## 1. Objet de ce document

Ce document décrit l'expérience utilisateur visée.

Il ne définit pas le schéma de données ni l'architecture logicielle. Les concepts métier nécessaires à cette UX sont détaillés dans `02-domain-model.md`.

## 2. Vue d'ensemble du workflow

Le workflow principal est :

```text
Ajouter une vidéo
      ↓
Naviguer dans la bibliothèque
      ↓
Ouvrir la page de travail
      ↓
Regarder + prendre des notes
      ↓
Ajouter timestamps / annotations / captures / tags
      ↓
Relire et structurer
      ↓
Rechercher / exploiter / interroger avec une IA
```

Le produit doit privilégier la continuité entre ces étapes.

## 3. Ajouter une vidéo

### 3.1 Interaction initiale

Dans l'interface Web, l'utilisateur dispose d'un champ permettant de coller une URL.

Exemple :

```text
https://www.youtube.com/watch?v=...
```

Après validation, l'application crée la vidéo ou détecte qu'elle existe déjà.

Pendant le développement initial, la même opération peut être exposée uniquement par API.

### 3.2 Informations récupérées

Pour YouTube, `yt-dlp` fournit les métadonnées nécessaires.

La liste exacte des champs sera affinée au cours du développement, mais elle doit couvrir les besoins d'affichage, d'identification et de recherche de l'application.

L'application ne conserve pas par défaut un dump brut complet des métadonnées `yt-dlp`. Les champs utiles doivent être explicitement modélisés.

Si le modèle évolue, la source peut être réinterrogée.

Depuis l'étape 4 bis, l'import peut créer ou retrouver le compte de publication
YouTube grâce à son `channel_id`. Sans identité fiable, la vidéo reste disponible
sans publisher. Le nom du compte peut être inconnu ; il n'est jamais utilisé pour
fusionner des comptes ou créer une personne.

### 3.3 Évolutions possibles

Plus tard, l'ajout d'une vidéo pourra aussi provenir de :

- extension navigateur ;
- client CLI ;
- MCP ;
- autre application via API ;
- fichier local ;
- autre plateforme vidéo.

Ces entrées doivent toutes aboutir au même cœur métier.

## 4. Bibliothèque

La bibliothèque est la vue de navigation principale.

Elle doit pouvoir rappeler visuellement une bibliothèque vidéo moderne :

```text
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ thumbnail   │ │ thumbnail   │ │ thumbnail   │
│             │ │             │ │             │
├─────────────┤ ├─────────────┤ ├─────────────┤
│ titre       │ │ titre       │ │ titre       │
│ source      │ │ source      │ │ source      │
│ tags        │ │ tags        │ │ tags        │
└─────────────┘ └─────────────┘ └─────────────┘
```

Fonctions attendues progressivement :

- liste/grille ;
- recherche ;
- filtres ;
- sélection par tag ;
- combinaison de tags ;
- tri ;
- accès rapide aux vidéos récemment ajoutées ou travaillées.

L'interface n'a pas besoin d'être sophistiquée au début. La valeur principale se trouve dans le workflow de travail sur une vidéo.

## 5. Page de travail vidéo

### 5.1 Une page pleine, pas une modal

La page de détail d'une vidéo est un **espace de travail durable**.

L'analogie initiale avec Karakeep concerne la disposition générale :

- aperçu/lecteur d'un côté ;
- informations de l'autre.

Mais une modal est inadaptée, car l'utilisateur peut rester longtemps sur cette page et y effectuer un vrai travail.

Une disposition conceptuelle possible :

```text
┌───────────────────────────────────────────────────────────────┐
│ Titre                                             actions     │
├─────────────────────────────────────┬─────────────────────────┤
│                                     │ Métadonnées             │
│                                     │ Source                  │
│              PLAYER                 │ Compte de publication   │
│                                     │ Date                    │
│                                     │ Tags                    │
│                                     │ État local              │
│                                     │ Actions                 │
├─────────────────────────────────────┴─────────────────────────┤
│ Notes | Transcript | Annotations | Assets | AI               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                    zone de travail                            │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Cette disposition n'est pas figée.

### 5.2 Comptes de publication et personnes

Les capacités suivantes sont disponibles par REST depuis l'étape 4 bis ; leur
interface Web reste à développer à l'étape 5.

L'utilisateur peut créer ou retrouver une chaîne depuis son URL. La résolution
peut échouer ; sans identité fiable, aucun publisher n'est créé. Il peut ensuite
associer, remplacer ou retirer ce publisher sur une source vidéo.

Une personne peut être créée indépendamment, renommée, associée directement à
des vidéos et choisie comme personne de référence de plusieurs publishers.
Les homonymes ne sont pas fusionnés.

La navigation distingue les vidéos associées directement à une personne et les
vidéos publiées par ses publishers. L'union des deux chemins ne duplique pas les
vidéos. L'interface devra rendre cette distinction compréhensible et ne pas
présenter automatiquement toutes les vidéos d'une chaîne comme ses œuvres.

Les réponses vidéo fournissent directement `publisher: {id, name}` sur chaque
source, ou `null`. Un compte identifié peut avoir un nom `null`. Le nom n'est
pas dupliqué dans la source persistée.

## 6. Prise de notes

### 6.1 Note principale

Chaque vidéo dispose d'un espace de note Markdown principal. Pour l'étape 4,
le cadrage et l'implémentation sont terminés : une vidéo
possède zéro ou une note persistée, créée au premier enregistrement seulement.
Une note absente et une note enregistrée vide sont deux états distincts.

Le contenu est conservé et restitué sans transformation, y compris ses espaces,
son indentation et ses retours à la ligne. Une sauvegarde identique ne change
pas sa date de modification. Les notes appartiennent à la vidéo, indépendamment
des métadonnées et transcriptions de ses sources.

La dernière écriture gagnante est acceptée provisoirement pour l'étape 4.
Lors des essais de l'interface Web à l'étape 5, il faudra réexaminer
l'autosauvegarde, les onglets concurrents, la prévention des pertes de
modifications et les éventuels mécanismes de résolution des conflits.
La future interface pourra éviter de créer une note vide et envisager une
suppression explicite lorsqu'une note est vidée ; cette suppression ne fait
pas partie de l'étape 4.

Le Markdown est choisi parce qu'il est :

- simple ;
- portable ;
- lisible en texte brut ;
- adapté aux liens, images et structures légères ;
- cohérent avec une base de connaissances personnelle.

### 6.2 Première passe : préserver le flow

Les timestamps interactifs décrits ci-dessous et les annotations structurées
de la section 6.4 sont réservés à l'étape 6. L'étape 4 conserve uniquement
le Markdown brut, sans parsing ni rendu.

Pendant la lecture, l'utilisateur doit pouvoir noter une idée sans quitter mentalement la vidéo.

Action centrale :

```text
[ + timestamp ]
```

À l'instant courant, l'application insère par exemple :

```markdown
[12:42]
```

L'utilisateur écrit immédiatement :

```markdown
[12:42] Cette distinction pourrait être utile pour le projet X.
```

Cette opération doit être extrêmement rapide.

Pas de modal.
Pas de formulaire obligatoire.
Pas de validation complexe.

### 6.3 Références temporelles faibles

Un timestamp inséré dans le Markdown peut être considéré comme une **référence faible**.

Il doit idéalement être reconnu par l'application et devenir interactif.

Exemple :

```markdown
[12:42]
```

Un clic peut repositionner le lecteur à `12:42`.

La référence existe d'abord dans le texte et ne nécessite pas forcément un objet `Annotation`.

### 6.4 Annotations fortes

Une `Annotation` est une référence temporelle structurée et identifiable.

Elle peut être créée :

- directement pendant le visionnage ;
- plus tard à partir d'une référence faible ;
- depuis une sélection de transcription ;
- éventuellement depuis un asset.

L'intérêt d'une annotation structurée est de permettre notamment :

- affichage dans une liste ;
- marqueur sur la timeline ;
- recherche ciblée ;
- requête MCP ;
- navigation entre annotations ;
- future catégorisation.

La relation exacte entre notes et annotations reste volontairement ouverte tant que l'UX n'a pas été testée en pratique.

## 7. Lecture et synchronisation temporelle

Le lecteur est une partie active de l'application.

Il doit pouvoir fournir au reste de l'UI :

- temps courant ;
- durée ;
- état de lecture ;
- navigation vers un timestamp.

Deux modes sont envisagés :

### 7.1 Source distante

La vidéo est lue directement depuis sa source, par exemple via le lecteur YouTube.

### 7.2 Média local

Si la vidéo a été téléchargée, l'application peut utiliser le fichier local.

Le téléchargement ne crée pas une nouvelle `Video`. Il crée une représentation locale supplémentaire de la même vidéo.

## 8. Transcription

### 8.1 Acquisition actuelle

L'utilisateur peut acquérir ou rafraîchir la caption automatique originale
d'une source YouTube. L'application utilise la langue audio originale fiable,
ou une unique piste originale admissible lorsqu'elle est inconnue.
Elle ne choisit implicitement ni une autre langue ni des sous-titres manuels.

La langue affichable dans la réponse est celle du contenu (`en`, `pt-BR`),
sans suffixe technique `-orig`. L'UI de sélection de variantes reste future.

### 8.2 Consultation

Le GET fournit les fragments textuels horodatés de la dernière acquisition
sélectionnée, sans accès réseau. La relecture utilise le snapshot JSON3 local.
Un snapshot absent ou corrompu est une anomalie locale pendant cette tranche.

Les fragments permettent l'affichage et la navigation par instant. Le texte
brut est dérivé en mémoire ; il n'est pas persisté séparément.
La recherche autour d'un timestamp et la synchronisation avancée du lecteur
ne sont pas implémentées dans cette tranche.

### 8.3 Stockage et évolutions

Toute acquisition réussie conserve actuellement son snapshot source.
La politique produit durable (archive, cache ou récupération à la demande)
reste ouverte. Un changement devra aussi préciser le comportement de lecture.

Les sous-titres manuels, les autres langues, le STT et les corrections IA
sont différés. Une correction future devra rester distincte du contenu source.

## 9. Screenshots et assets

### 9.1 Cas d'usage

Pendant le visionnage, l'utilisateur peut vouloir conserver :

- un diagramme ;
- une slide ;
- une démonstration ;
- un écran de code ;
- une image importante.

Action visée :

```text
[ Capture ]
```

L'application extrait l'image correspondant au timestamp courant.

### 9.2 Vidéo locale

Une capture précise nécessite vraisemblablement de disposer localement du média, au moins temporairement.

Le téléchargement temporaire est acceptable pour le besoin initial.

### 9.3 Nom de fichier

Le timestamp doit apparaître dans le nom du fichier afin que l'asset reste lisible hors de la base.

Exemple conceptuel :

```text
<video-id>_00h18m43s456.jpg
```

Cependant, le timestamp enregistré dans la base est la donnée canonique.

### 9.4 Insertion dans la note

Après capture, l'application doit pouvoir insérer immédiatement une référence Markdown :

```markdown
![Capture à 18:43](assets/...)
```

## 10. Tags

Les tags sont des données structurées d'un catalogue unique, associables aux
vidéos, publishers et personnes. L'extension aux deux derniers est disponible
par REST depuis l'étape 4 bis.

L'étape 4 est implémentée et accessible via REST.
Les tags sont partagés entre vidéos. L'ajout par noms est additif, sans doublons,
et un ajout multiple réussit ou échoue intégralement. Retirer un tag d'une vidéo
ne le supprime pas du catalogue, même s'il n'est plus utilisé.

L'identité utilise une normalisation Unicode NFC et une comparaison insensible
à la casse, en conservant les accents significatifs. Les espaces aux extrémités
sont supprimés ; la casse d'affichage initiale est conservée lors des réutilisations.
Ainsi, `DevOps` et `devops` désignent le même tag, mais `Café` et `Cafe`,
ou `Go` et `Golang`, restent distincts. Aucun rapprochement sémantique n'est fait.

L'API expose les tags sur les vidéos et permet un filtre par un seul tag.
Le filtrage conserve la représentation complète de chaque vidéo et l'ordre des
ajouts récents. Les tags sont restitués par identifiant croissant, selon un ordre
stable commun au catalogue et aux vidéos. L'interface Web vient à l'étape 5 ;
les combinaisons de filtres et la recherche textuelle sont différées.

Ils servent à :

- classer ;
- filtrer ;
- rechercher ;
- connecter des contenus ;
- alimenter l'IA.

À terme, ils pourront être :

- ajoutés manuellement ;
- suggérés par une IA ;
- ajoutés par un agent via MCP.

Les suggestions IA ne doivent pas nécessairement être appliquées sans validation selon le workflow choisi plus tard.

Les associations de tags sont indépendantes : le tag DevOps d'une personne
n'est pas attribué à ses vidéos ou à ses publishers. Retirer une association
conserve le tag partagé. Le filtre vidéo actuel reste fondé sur ses tags directs.

## 11. Recherche

### 11.1 Recherche de base

Le MVP peut commencer par une recherche simple sur les métadonnées, les tags ou les notes.

Une recherche future pourra exploiter les liens entre personnes, publishers,
vidéos et tags sans matérialiser d'héritage automatique. Les routes de navigation
directe et indirecte existent déjà ; elles ne constituent pas une recherche plein texte.

### 11.2 Recherche plein texte

À terme, la recherche doit pouvoir couvrir :

- titres ;
- descriptions ;
- notes ;
- transcriptions ;
- tags ;
- résumés ;
- autres artefacts textuels.

SQLite FTS5 est le mécanisme privilégié pour cette évolution.

### 11.3 Résultat temporel

Quand une correspondance provient d'un passage de la transcription, le résultat devrait idéalement pouvoir ouvrir directement la vidéo au bon timestamp.

## 12. IA

Deux usages sont distingués.

### 12.1 IA intégrée

L'application peut appeler directement un fournisseur IA pour :

- résumer ;
- suggérer des tags ;
- générer des chapitres ;
- extraire des points clés ;
- répondre à des questions sur une vidéo.

Cette couche est optionnelle et son fournisseur n'est pas encore choisi.

### 12.2 IA externe via MCP

Un agent externe peut utiliser l'application comme source de connaissance et comme outil d'action.

Exemple :

> Recherche mes vidéos concernant Proxmox et Tailscale, lis leurs transcriptions et indique lesquelles parlent du routage subnet.

L'agent doit pouvoir appeler des outils métier tels que :

```text
search_videos
get_video
get_transcript
get_annotations
add_tags
append_note
```

Il ne doit pas être exposé à des primitives internes inutiles comme `execute_sql`.

## 13. Principes UX à conserver

1. La page vidéo est un espace de travail.
2. La prise de notes doit être plus rapide que la structuration.
3. Les timestamps sont interactifs.
4. La structure ne doit pas interrompre le visionnage.
5. La structuration forte peut intervenir dans une seconde passe.
6. L'interface doit fonctionner sans IA.
7. Le téléchargement est un moyen, pas le cœur du produit.
8. La vidéo locale et la vidéo distante représentent le même objet métier.
9. Le MVP doit privilégier l'utilité avant le raffinement visuel.
