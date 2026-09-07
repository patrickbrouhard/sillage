# Project brief

> **Nom du projet :** à déterminer  
> **Description courte :** base de connaissances personnelle centrée sur la vidéo.

## 1. Vision

L'application permet de transformer le visionnage d'une vidéo en connaissance exploitable et durable.

Elle ne doit pas être pensée comme un simple gestionnaire de liens YouTube ni comme un outil de téléchargement. Son objet principal est la **vidéo en tant que support de connaissance** : on peut l'ajouter à sa bibliothèque, la regarder, l'annoter, prendre des notes, récupérer sa transcription, effectuer des captures, la taguer, la rechercher et l'interroger avec des outils d'IA.

YouTube est la première source prise en charge parce qu'il répond au besoin initial et que `yt-dlp` permet d'en extraire facilement les métadonnées, les sous-titres et les médias. Le modèle doit néanmoins rester suffisamment général pour accueillir plus tard d'autres sources : autre plateforme vidéo, fichier local, vidéo déjà téléchargée, etc.

Le concept central est donc :

```text
Source vidéo
    ↓
   Video
    ↓
métadonnées + transcription + notes + annotations + tags + assets
    ↓
base de connaissances personnelle
```

## 2. Problème utilisateur

Lorsqu'une vidéo contient des informations importantes, le workflow habituel est fragmenté :

- la vidéo reste sur une plateforme externe ;
- les notes vivent ailleurs ;
- les timestamps sont copiés manuellement ;
- les captures sont stockées séparément ;
- la transcription est difficilement exploitable ;
- la recherche porte rarement à la fois sur la vidéo, les notes et le contenu parlé ;
- l'IA ne dispose pas d'une interface propre pour interroger ou enrichir cet ensemble.

L'application doit réunir ces éléments autour d'un objet `Video` stable.

## 3. Scénarios principaux

### 3.1 Ajouter une vidéo

L'utilisateur fournit l'URL d'une vidéo.

L'application :

1. identifie sa source ;
2. utilise l'adapter approprié — `yt-dlp` pour YouTube dans la première version ;
3. récupère les métadonnées nécessaires ;
4. crée ou retrouve l'objet `Video` ;
5. associe la source à cet objet ;
6. rend la vidéo disponible dans la bibliothèque.

Dans une première étape de développement, ce workflow peut fonctionner uniquement via l'API, sans interface graphique.

### 3.2 Travailler sur une vidéo

La page de détail d'une vidéo est un **espace de travail**, pas une simple fenêtre de consultation.

L'utilisateur doit pouvoir notamment :

- lire la vidéo ;
- voir ses métadonnées ;
- ajouter et modifier des tags ;
- prendre des notes en Markdown ;
- insérer rapidement le timestamp courant dans ses notes ;
- naviguer depuis un timestamp vers le passage correspondant ;
- créer des annotations temporelles structurées ;
- récupérer et consulter la transcription ;
- télécharger temporairement ou durablement la vidéo ;
- effectuer des captures à un instant précis ;
- insérer ces captures dans les notes ;
- demander plus tard à une IA de résumer, taguer, extraire ou comparer les informations.

### 3.3 Naviguer et rechercher

La bibliothèque doit permettre :

- un affichage visuel avec miniatures ;
- la navigation par tags ;
- des combinaisons de filtres ;
- une recherche textuelle ;
- à terme, une recherche plein texte dans plusieurs types de contenu :
  - titre ;
  - description ;
  - tags ;
  - notes ;
  - transcription ;
  - résumés ou autres artefacts IA.

## 4. Principes produit

### 4.1 `Video` est l'objet central

`Video` représente l'objet de connaissance interne à l'application.

Une URL YouTube, un fichier local ou une autre plateforme ne sont que des **sources ou représentations** de cette vidéo.

Cette séparation doit éviter d'enfermer le domaine métier dans YouTube.

### 4.2 La dimension temporelle est de premier ordre

Une vidéo est un média temporel. Le modèle doit donc traiter les timestamps comme des données métier importantes.

Les timestamps servent notamment à :

- créer une référence rapide dans une note ;
- créer une annotation forte ;
- indexer une capture ;
- naviguer vers un passage ;
- découper la transcription ;
- interroger précisément une plage temporelle.

### 4.3 Les notes doivent préserver le flow de l'utilisateur

Lors d'une première passe, la prise de notes doit être très rapide.

Exemple :

```markdown
[12:42] Comparer cette approche avec le fonctionnement de SQLite.
```

L'utilisateur ne doit pas devoir remplir un formulaire ou structurer chaque pensée au moment où il regarde la vidéo.

Une référence rapide peut ensuite être enrichie ou transformée en annotation structurée.

### 4.4 L'application est IA-native, mais l'IA n'est pas obligatoire

L'application doit être conçue dès le départ pour être facilement exploitable par des agents ou des LLM :

- données structurées ;
- identifiants stables ;
- actions métier explicites ;
- API ;
- serveur MCP ;
- séparation claire entre lecture et modification.

Cependant, les fonctions essentielles doivent rester utilisables sans fournisseur d'IA configuré.

L'IA est une capacité d'enrichissement et d'interrogation, pas une dépendance fondamentale du produit.

### 4.5 Local-first

Le besoin initial est personnel.

L'application doit fonctionner localement, sous forme de conteneur Docker, avec les données principales stockées localement.

SQLite est le stockage relationnel privilégié.

Les médias, screenshots et autres assets sont stockés sur le système de fichiers.

### 4.6 Architecture modulaire

Le cœur métier ne doit dépendre ni :

- de l'interface Web ;
- de HTTP ;
- de MCP ;
- de SQLite ;
- de `yt-dlp` ;
- d'un fournisseur d'IA particulier.

Les différentes interfaces et dépendances externes sont des adapters autour des services applicatifs.

Cela doit permettre plus tard d'ajouter une version desktop ou un client CLI sans réécrire le cœur.

## 5. Périmètre initial

Le premier produit réellement utilisable doit au minimum permettre :

- l'ajout d'une vidéo YouTube ;
- l'extraction de ses métadonnées ;
- la persistance dans SQLite ;
- une bibliothèque simple ;
- une page de travail dédiée ;
- la lecture de la vidéo ;
- les tags ;
- les notes Markdown ;
- la récupération des sous-titres/transcriptions disponibles ;
- les timestamps cliquables ou insérables rapidement ;
- une recherche de base.

Le téléchargement, les captures, la recherche FTS5 avancée, le MCP, les artefacts IA, le support d'autres plateformes et la version desktop peuvent être ajoutés progressivement.

## 6. Hors périmètre initial

Ne pas considérer comme exigences de départ :

- multi-utilisateur complexe ;
- synchronisation temps réel ;
- gestion fine de permissions ;
- plateforme vidéo publique ;
- remplacement de YouTube ;
- hébergement ou streaming massif ;
- architecture distribuée ;
- PostgreSQL ou autre SGBD serveur sans besoin démontré ;
- vector database ou embeddings par défaut ;
- moteur de transcription local obligatoire ;
- application mobile native.

## 7. Critère directeur

Une fonctionnalité est cohérente avec le projet si elle aide à faire au moins une des choses suivantes :

1. **capturer** une vidéo ou une idée issue d'une vidéo ;
2. **contextualiser** cette information dans le temps ;
3. **structurer** cette information ;
4. **retrouver** cette information ;
5. **réutiliser ou interroger** cette connaissance, manuellement ou avec une IA.
