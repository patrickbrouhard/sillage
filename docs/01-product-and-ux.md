# Product & UX

## 1. Objet de ce document

Ce document décrit l'expérience utilisateur visée.

Il ne définit pas le schéma de données ni l'architecture logicielle. Les concepts métier nécessaires à cette UX sont détaillés dans `02-domain-model.md`.

### Confort d'affichage

Un sélecteur dans l'en-tête propose Clair, Sombre et Système (par défaut).
Système suit les changements du système d'exploitation. Le choix est mémorisé
localement dans ce navigateur ; si le stockage est indisponible, le changement
reste utilisable pour la page courante. Cette seule préférence d'affichage fait
exception au report des préférences persistantes : aucun compte ni stockage serveur.
Les panneaux, formulaires, dialogues, états de focus, l'éditeur et la lecture
Markdown suivent le thème sans remonter la session de note. Le contenu intégré
par YouTube conserve son apparence propre.

La réalisation utilise des variables CSS et les contrôles natifs, sans refonte
graphique ni ajout d'un framework CSS.
La palette de confort est bleue : fonds bleu nuit en mode sombre, fonds clairs
bleutés en mode clair, avec icône d'en-tête, accents et sélections assortis.
Les erreurs gardent une couleur chaude distincte. Cette palette reste révisable.

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

Pour 5.1, ajout et retrait des tags vidéo ainsi qu'un filtre par un seul tag
sont retenus. La première source retournée par REST fournit provisoirement
titre, miniature et provenance d'une carte. Ce choix de présentation n'ajoute
aucune notion persistée de source principale. Les tags restent ceux de la vidéo,
sans héritage depuis les publishers ou personnes.

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

La note Markdown constitue la zone principale et stable. Le lecteur est la
partie flexible : masquable à l'étape 5.3, puis potentiellement redimensionnable
ou détachable dans une autre fenêtre. Le détachement n'est pas requis en 5.3.

La transcription est un panneau indépendant, consultable à côté de la note même
quand le lecteur n'est pas visible. Le travail sans affichage vidéo doit rester
possible, notamment pour les contenus principalement audio. Masquer le lecteur
ne doit pas interrompre l'édition de la note.

Pour 5.3, le desktop présente la note à gauche et le lecteur au-dessus de la
transcription à droite. La hauteur du workspace est adaptée à l'espace disponible ;
note et transcription défilent indépendamment. Masquer le lecteur libère la place
pour la transcription. Sur écran étroit, la page défile normalement dans l'ordre
lecteur, note, transcription. Le responsive et les interactions des autres panneaux
ne démontent jamais la session de note. Les métadonnées complètes restent dans une
section secondaire repliable. Aucun panneau redimensionnable ou détachable ici.

La première source YouTube exploitable dans l'ordre REST est la source de travail
commune : identité externe pour le lecteur, ID Sillage pour la transcription.
Elle est identifiée dans l'interface. Ce choix de présentation ne persiste aucune
source principale et ne nécessite pas de sélecteur. Sans source compatible, note
et métadonnées restent accessibles.

### 5.2 Comptes de publication et personnes

Les capacités suivantes sont disponibles par REST depuis l'étape 4 bis ; leur
interface Web complète est différée et reste hors du périmètre 5.1.

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

LF (`\n`) est la convention canonique des notes Markdown : à l'enregistrement,
CRLF et CR deviennent LF, sans modifier les autres caractères, espaces ou indentations.
Cette décision remplace la conservation exacte des séparateurs décidée en 5.2.
Aucune migration ni écriture à la lecture des anciennes notes n'est effectuée.
Leur prochaine sauvegarde explicite, ou une édition suivie d'autosauvegarde,
peut les normaliser. Une sauvegarde identique après normalisation ne change
pas sa date de modification. Les notes appartiennent à la vidéo, indépendamment
des métadonnées et transcriptions de ses sources.

L'étape 4 utilisait provisoirement la dernière écriture gagnante. Pour 5.2,
les décisions suivantes sont actées :

- note principale en Markdown source enrichi, sans WYSIWYG ni Live Preview ;
- bascule Édition/Lecture dans le même espace ; rendu GFM sécurisé sans HTML brut ;
- conservation du Markdown hors normalisation des fins de ligne en LF ; aucune
  écriture lors d'une bascule ; curseur, sélection et Undo/Redo préservés
  autant que possible pendant la session ;
- sauvegarde après 2 s d'inactivité ou 20 s depuis les premières modifications
  non prises en charge ; aucune écriture périodique sans changement ;
- Ctrl+S, une seule écriture en cours, saisie toujours possible ;
- états distincts : en attente, en cours, contenu confirmé, erreur et conflit ;
- réessais réseau bornés ; relecture après résultat incertain avant toute nouvelle
  écriture ; une version distante plus récente n'est jamais écrasée automatiquement ;
- conflit : texte local conservé, autosauvegarde suspendue, consultation des deux
  versions et choix explicite ; garder le local reste une écriture conditionnelle ;
- navigation interne (historique inclus) : tentative de sauvegarde puis choix de
  rester ou quitter si le contenu n'est pas confirmé ; avertissement navigateur
  disponible lors d'une fermeture/recharge, sans présumer une sauvegarde tardive ;
- aucune création à l'ouverture, note vide autorisée, aucune suppression ;
- une erreur de lecture n'est jamais assimilée à une note absente.

CodeMirror 6 est intégré et vérifié automatiquement en 5.2 ; le périmètre
fonctionnel de cette étape est validé manuellement.
Les 20 s sont un objectif de déclenchement, pas une garantie en cas de requête
en cours, onglet suspendu ou serveur indisponible. Sans brouillon persistant,
la perte des dernières modifications après un crash brutal est une limite acceptée.

Sont exclus : historique, File Recovery, brouillons navigateur persistants,
fusion automatique, collaboration temps réel, lecteur et interactions temporelles.
Aucune nouvelle étape de récupération historique n'est prévue.

Le Markdown est choisi parce qu'il est :

- simple ;
- portable ;
- lisible en texte brut ;
- adapté aux liens, images et structures légères ;
- cohérent avec une base de connaissances personnelle.

### Retours de validation 5.2 — pistes UX révisables

Ces observations ne bloquent pas la validation fonctionnelle et ne demandent
aucune modification visuelle immédiate ni nouvelle étape de roadmap :

- le bouton « Enregistrer la note » reste provisoirement disponible ; sa présence
  définitive sera réévaluée avec l'autosauvegarde et Ctrl+S ;
- la révision et l'heure du dernier contenu confirmé sont utiles au développement ;
  un indicateur plus discret et des diagnostics facultatifs ou un mode développement
  sont des pistes non actées ;
- le rendu Édition/Lecture mérite une finition ultérieure : couleurs, espacements,
  blocs de code, coloration syntaxique et présentation générale ;
- la note précède actuellement la vignette et les informations ; la disposition
  sera réexaminée avec l'arrivée du lecteur et de la transcription, sans figer
  maintenant le workspace.

### 6.2 Insertion du temps courant — tranche 6.2

Le bouton `+ Temps` de la barre de note insère une référence en mode Édition,
au curseur ou après le texte sélectionné, quel que soit le sens de sélection.
Aucun texte sélectionné n'est remplacé. Un espace suit la référence ; le curseur
et le focus reviennent après cet espace pour poursuivre immédiatement la rédaction.
L'insertion forme une action Undo/Redo indépendante et suit l'autosauvegarde normale.
Le lecteur et la session d'édition ne sont ni interrompus ni remontés.

Pendant la lecture, l'utilisateur doit pouvoir noter une idée sans quitter mentalement la vidéo.

Action centrale :

```text
[ + Temps ]
```

À l'instant courant, l'application insère par exemple :

```markdown
[12:42](sillage://videos/5/sources/5?start_ms=762345)
```

L'utilisateur écrit immédiatement :

```markdown
[12:42](sillage://videos/5/sources/5?start_ms=762345) Cette distinction pourrait être utile pour le projet X.
```

Cette opération doit être extrêmement rapide.

Pas de modal.
Pas de formulaire obligatoire.
Pas de validation complexe.

Le temps est lu au clic, arrondi à la milliseconde ; le libellé utilise `m:ss`
ou `h:mm:ss` sans afficher la fraction. Lecture, pause et fin de vidéo permettent
l'insertion si la position est valide, y compris zéro. Un lecteur masqué en pause
reste masqué. Avant la première lecture, en état `cued`, en buffering, pendant
le masquage, avant disponibilité ou après erreur/destruction, aucune référence
n'est insérée : un message invite à réessayer. Aucune action n'est différée.
Une exception de lecture du temps n'envoie aucune commande au lecteur.

En mode Lecture, `+ Temps` est désactivé et le libellé reste sans interaction ;
le Markdown source conserve l'URI complète. Le rendu enrichi et la navigation
inverse attendent 6.5. Dans un contexte de code Markdown, l'insertion reste du
texte de code : aucun déplacement automatique ni analyse générale du document.

### 6.3 Références temporelles et citations — orientation pour l'étape 6

Une référence possède un début obligatoire et une fin facultative. L'insertion
rapide pendant la prise de notes et la citation enrichie d'un passage de
transcription sont deux workflows pouvant utiliser cette même notion.
La provenance temporelle doit être conservée lorsque nécessaire pour retrouver
la bonne source ; sa représentation précise reste à expérimenter.

Le format des liens est acté en 6.2 :
`[12:42](sillage://videos/5/sources/5?start_ms=762345)`.
La vidéo et la source sont toujours explicites ; `videos` est l'autorité logique
de l'URI. `end_ms` est réservé aux plages futures, sans être produit ni interprété
en 6.2. Le libellé ne détermine jamais la position structurée.

Le Markdown brut peut contenir des extensions propres à Sillage. La compatibilité
fonctionnelle avec des applications externes n'est pas prioritaire. La copie
ordinaire doit préserver les informations utiles ; des opérations explicites de
copie adaptée et d'export pourront convertir les références.

Un export Markdown destiné à la consultation est distinct d'une sauvegarde
réimportable préservant toutes les données métier. Les formats et mécanismes
de ces opérations restent ouverts. Aucune de ces fonctions n'est requise en 5.1.

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

Le lecteur est une partie active de l'application. Les interactions temporelles
avec la note et la transcription ci-dessous sont réservées à l'étape 6.

Il doit pouvoir fournir au reste de l'UI :

- temps courant ;
- durée ;
- état de lecture ;
- navigation vers un timestamp.

Deux modes sont envisagés :

### 7.1 Source distante

La vidéo est lue directement depuis sa source, par exemple via le lecteur YouTube.

En 5.3, l'IFrame Player API YouTube est intégrée directement, avec ses commandes
natives, sans bibliothèque supplémentaire ni abstraction multi-provider.
L'ouverture et la réapparition du lecteur ne déclenchent aucune lecture automatique.
Masquer le lecteur YouTube interrompt la lecture et laisse un bandeau « Lecteur »
avec une action de réaffichage. La position est conservée lors d'un masquage
ordinaire dans la même fiche, sans garantie après erreur, recharge ou navigation.
Ce comportement est propre à YouTube ; un futur lecteur local pourra garder l'audio.
Chargement, échec d'initialisation, vidéo inaccessible et intégration interdite
restent propres au panneau. Le lien externe reste accessible lorsqu'il est valide.
Les dimensions et la visibilité respectent les exigences du lecteur YouTube.

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

En 5.3, l'ouverture effectue uniquement le GET local. L'absence propose « Récupérer » ;
un contenu disponible propose « Actualiser ». Seule une action explicite lance le
POST sans corps. Le contenu reste affiché pendant l'opération et après son échec.
L'état du contenu et celui de l'opération sont distincts : chargement initial,
absence locale, disponibilité, acquisition, aucune piste originale sélectionnable,
échec distant, délai dépassé, erreur interne ou de lecture locale. Une erreur locale
ne prouve pas une corruption. Une piste non sélectionnable ne prouve pas l'absence
de tous sous-titres. Après résultat POST incertain, une relecture locale peut
retrouver le contenu publié ; aucun POST n'est relancé automatiquement.

Les fragments sont regroupés en présentation par intervalles fixes ancrés sur zéro,
de 10 secondes fixes depuis 6.3, sans sélecteur ni préférence.
Chaque fragment est affecté selon start_ms, sans découpe ; seuls les fragments
consécutifs du même intervalle sont réunis. L'ordre source reste prioritaire, même
en cas de retour temporel : un intervalle peut donc produire plusieurs blocs.
Les textes sont concaténés exactement, sans espace ajouté. Le timestamp est celui
du premier fragment réel du bloc. Aucun bloc visuellement vide ni intervalle sans
texte n'est affiché ; les blancs isolés restent des séparateurs du texte voisin.
Chaque bloc est affiché comme un paragraphe fluide : les espaces et retours à la
ligne sont normalisés visuellement par le navigateur, qui adapte les lignes à
la largeur disponible sur desktop et mobile. Les coupures des sous-titres ne
sont pas reproduites. Les chaînes regroupées, les fragments REST et les données
sources conservent leurs espaces exacts ; aucun espace n'est ajouté entre deux
fragments d'un même mot. Les groupes restent séparés avec leur timestamp.
Les frontières peuvent couper une phrase ou un mot. Aucun traitement linguistique,
changement de modèle ou de persistance n'est introduit.

En 6.1, chaque timestamp est un bouton accessible au clavier (Entrée ou Espace).
Il demande au lecteur YouTube de rejoindre le `start_ms` réel du bloc, sans
arrondir à la seconde affichée. Une lecture en cours continue ; une vidéo en pause
reste en pause. Avant la première lecture ou après la fin, le point de départ est
préparé sans démarrage automatique. Un lecteur masqué est réaffiché.
Pendant un masquage en cours, la garantie d'arrêt reste prioritaire : un message
invite à renouveler l'action après l'arrêt. Si le lecteur est indisponible ou pas
encore prêt, le message explique que la navigation n'a pas eu lieu ; le timestamp
doit être activé à nouveau une fois le lecteur prêt. Aucune commande n'est différée.
La commande envoyée n'est pas présentée comme une position confirmée par YouTube.
La note conserve sa session, sa sélection, son historique et son autosauvegarde.
Le clic ne déclenche ni acquisition de transcription ni insertion dans la note.
La recherche locale est implémentée en 6.3 ci-dessous ; l'insertion du temps est
implémentée en 6.2. Synchronisation continue et citations restent futures.

### Recherche locale dans la transcription — tranche 6.3

Implémentée en 6.3 : recherche textuelle insensible à la casse dans le contenu déjà
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

La recherche est littérale hors équivalence des blancs : pas d'expressions régulières
ni de suppression des accents. Un espace saisi correspond aussi aux sauts de ligne,
tabulations et suites de blancs du texte source, sans modifier ce dernier. Les occurrences sont non chevauchantes, de gauche
à droite. Une saisie vide n'affiche aucun résultat. Le compteur indique le résultat
actif et le total (0 / 0 sans correspondance) ; les deux commandes sont alors désactivées.
Entrée dans le champ passe au résultat suivant avec retour circulaire, sans déplacer
le focus ni commander le lecteur ; la validation IME est ignorée.
Les blancs sources restent exacts, même si CSS les réduit visuellement dans les
paragraphes. Une actualisation réussie conserve la requête, recalcule les occurrences
et sélectionne la première ; pendant l'opération ou après un échec, le contenu
conservé reste consultable avec la sélection courante.
Sur desktop, seul le texte de la transcription défile ; sur mobile, les résultats
participent au défilement normal de la page. La recherche n'est pas persistée.

### 8.3 Stockage et évolutions

La provenance affichée est « Transcription automatique ». La sélection privilégie
la langue audio originale, mais le marqueur `-orig` peut concerner une piste doublée ;
le repli sur une piste unique ne garantit donc pas l'audio original.

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

## Jalon 3 de 5.1 — décisions UX validées

Les tags de la fiche sont visibles et ouvrent la bibliothèque filtrée
(`/?tag_id=7`). Ceux des cartes restent non interactifs. Le retour depuis
une fiche conserve le filtre de la bibliothèque d'origine ; un accès direct
peut revenir à la bibliothèque complète.

Un bouton « Gérer les tags » (ou « Ajouter des tags ») ouvre une modale.
Un champ unique propose les tags existants à la saisie et une action explicite
d'ajout du nom. Flèches, Entrée et Échap permettent son utilisation au clavier.
Les associations sont enregistrées immédiatement, une opération à la fois ;
fermer la modale n'annule pas les modifications réussies. Les ajouts sont
successifs, sans sauvegarde globale. Le retrait concerne uniquement l'association.

Le filtre unique figure dans l'URL et peut être retiré explicitement.
Un catalogue vide, un filtre sans résultat et une erreur sont distincts.
Le catalogue reste global, y compris les tags inutilisés ou employés uniquement
sur d'autres entités. Le backend reste seul responsable de l'identité Unicode ;
l'autocomplétion est une aide de présentation, pas une déduplication métier.

Chaque description de source est intégrale mais repliée initialement, avec
une ouverture indépendante. Une description absente est signalée sans volet vide.
Les retours à la ligne sont conservés, sans état d'ouverture persisté.

### Préférences révisables et questions ouvertes

La modale est provisoire. Un volet ou onglet pourrait accueillir ultérieurement
la gestion des tags ; un panneau « Informations » ou « Métadonnées » pourrait
regrouper les propriétés secondaires. La disposition du workspace reste ouverte.
Séparer simplement l'éditeur de tags de son conteneur suffit pour ce jalon :
aucun système générique de panneaux, modales ou onglets n'est prévu.
