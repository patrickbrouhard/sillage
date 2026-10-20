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

L'en-tête de la fiche est compact : bandeau Sillage réduit sans slogan, titre
puis tags et action de classement sur une même ligne lorsque la largeur le permet.
La date d'ajout est consultable dans « Métadonnées et sources ». La provenance
YouTube figure discrètement dans la barre du lecteur ; la source de travail et son identifiant
externe sont détaillés dans les métadonnées, sans répéter le titre au-dessus du
workspace. La bibliothèque et la page d'ajout conservent leur bandeau habituel.

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
Le lecteur Local suit désormais la même règle de pause au masquage. La lecture audio en arrière-plan reste différée.
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
reste en pause. Avant la première lecture, depuis cued ou après la fin, le clic
demande maintenant la lecture au passage ; la préparation sans démarrage reste
réservée aux bascules. Un lecteur masqué est réaffiché.
Pendant un masquage en cours, la garantie d'arrêt reste prioritaire : un message
invite à renouveler l'action après l'arrêt. Si le lecteur est indisponible ou pas
encore prêt, le message explique que la navigation n'a pas eu lieu ; le timestamp
doit être activé à nouveau une fois le lecteur prêt. Aucune commande n'est différée.
La commande envoyée n'est pas présentée comme une position confirmée par YouTube.
La note conserve sa session, sa sélection, son historique et son autosauvegarde.
Le clic ne déclenche ni acquisition de transcription ni insertion dans la note.
La recherche locale est implémentée en 6.3 ci-dessous ; l'insertion du temps est
implémentée en 6.2 et les citations en 6.4. La synchronisation continue reste future.

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
actif et le total ; il reste vide sans requête et indique « Aucun résultat » sans
correspondance. Les deux commandes sont désactivées sans résultat.
Entrée dans le champ passe au résultat suivant avec retour circulaire, sans déplacer
le focus ni commander le lecteur ; la validation IME est ignorée.
Les blancs sources restent exacts, même si CSS les réduit visuellement dans les
paragraphes. Une actualisation réussie conserve la requête, recalcule les occurrences
et sélectionne la première ; pendant l'opération ou après un échec, le contenu
conservé reste consultable avec la sélection courante.
Sur desktop, seul le texte de la transcription défile ; sur mobile, les résultats
participent au défilement normal de la page. La recherche n'est pas persistée.

### 6.4 — Sélection et citation de transcription

Cadrage consigné avant le code le 14 octobre 2026, puis implémenté et testé
localement. Retours manuels utilisateur satisfaisants, puis correctifs ciblés de clôture
(voir le bilan 6.4 dans la roadmap). Tranche entièrement frontend, sans nouveau contrat REST, migration, entité Annotation ni objet citation
persisté. Aucun end_ms. Les références sont activables en Lecture depuis 6.5.

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
rester littéral en Markdown. Format généré depuis UX 1.1 :

```markdown
> [!quote:tr](sillage://videos/5/sources/5?start_ms=21000)
> They may not agree with those arguments.
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
pour isoler le bloc et un curseur après la citation et sa ligne vide finale.
La référence figure dans l'en-tête depuis UX 1.1. Les sauts LF déjà présents sont réutilisés ;
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

### Navigation depuis la note — tranche 6.5, implémentée

En Lecture, les références temporelles canoniques deviennent des boutons natifs ;
en Édition, elles restent du Markdown brut. Le temps vient uniquement de start_ms.
Seule l'identité vidéo/source du lecteur courant autorise une commande. Les autres
identités donnent un message non bloquant, sans changer de fiche ni de source.
Les références invalides restent inertes. L'activation préserve la note et le focus.

La navigation partage les garanties des timestamps de transcription. Les deux
actions ramènent la zone vidéo à l'écran seulement après commande acceptée,
par défilement instantané minimal et sans toucher aux défilements internes.
Le réaffichage d'un lecteur indisponible ne constitue pas un succès.
Dans les notes, les liens Web HTTP(S) d'origine externe, explicites ou reconnus
par GFM, ouvrent un nouvel onglet protégé. Les liens internes gardent la navigation
React Router dans le même onglet, mailto son comportement natif et les références
temporelles leur activation locale. Les URL dangereuses restent filtrées.
Contrat détaillé, exclusions et validations dans la tranche 6.5 de la roadmap.

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

### 9.2 Acquisition implémentée en 7.2

Le bouton `+ Capture`, voisin de `+ Temps`, lit immédiatement le timestamp du
lecteur, selon les mêmes règles temporelles. Il est réservé au mode Édition.
Aucune commande ni bascule du lecteur n'est nécessaire.

Un média complet de la source actuellement lue est prioritaire. Une autre source
de la même vidéo n'est jamais substituée. Sans média exploitable (notamment pendant
son téléchargement), l'extraction utilise directement le flux YouTube. Un échec
de lecture/décodage local permet un repli distant ; les erreurs de stockage,
SQLite et d'arrêt ne le permettent pas. Aucun téléchargement complet permanent
n'est déclenché implicitement.

À dimensions identiques, HTTPS direct est préféré à HLS dès la sélection.
Une résolution supérieure reste prioritaire, même disponible uniquement en HLS.
Un échec du flux HLS peut conduire à un unique essai HTTPS de même largeur et
hauteur. Codec et débit peuvent différer ; aucune baisse de résolution n'est
effectuée automatiquement.

Le résultat est un PNG à la résolution du fichier local ou du meilleur flux vidéo
distant sélectionné, sans plafond 1080p ni redimensionnement volontaire. La capture
vise la première image décodable à partir de la cible ; la cadence discrète et
les différences de timeline/rendu YouTube empêchent de promettre une identité
exacte avec l'image de l'iframe. Les limites techniques sont décrites dans le
document 04.

### 9.3 Acceptation et insertion

Au clic, une Decoration CodeMirror affiche « Capture à 12:42 — préparation… »
avec un indicateur d'activité. Elle ne modifie ni le Markdown ni l'autosauvegarde.
Elle suit les modifications et les Undo/Redo ordinaires. Une suppression
traversant son point d'ancrage ou le remplacement de la session invalide
définitivement l'insertion ; une réponse tardive ne la ressuscite pas.

Dès l'acceptation persistée, le marqueur devient une unique insertion Markdown :

```markdown
![Capture à 12:42](/api/v1/assets/123/content)
```

L'insertion se fait au curseur ou après la sélection sans remplacer le texte.
Elle constitue une étape Undo/Redo isolée, sans déplacer le focus à la réponse.
Si le curseur attend encore au marqueur, il est placé après la référence et son
espace final. Une sélection ou un curseur déplacé pendant l'attente est préservé.
Undo ne supprime pas l'Asset ; Redo ne relance pas son extraction.
Le nom physique est technique et unique, par exemple
`capture-123-762345ms-<identifiant-aléatoire>.png` ; le timestamp en base est canonique.

### 9.4 Génération, navigation et erreurs

Une seule capture occupe le serveur à la fois, indépendamment du téléchargement.
Le bouton reste occupé jusqu'à son état terminal. Une autre page peut recevoir
un refus explicite si le serveur est occupé ; il n'existe pas d'indicateur global.
Le suivi local ne vaut jamais confirmation de sauvegarde de la note.

La bascule en Lecture est bloquée uniquement pendant l'acceptation. Après
insertion, la génération continue même si l'utilisateur quitte la page. Partir
pendant l'acceptation abandonne l'insertion locale, sans annuler une demande déjà
acceptée par le serveur. La protection habituelle des modifications non
sauvegardées reste seule applicable.

En Lecture, une référence interne affiche la préparation, le PNG ou l'échec ;
son état est actualisé automatiquement. Une erreur de consultation est distinguée
d'un échec de génération. Le Markdown reste intact en cas d'échec. Les images
ne commandent pas le lecteur. L'Édition reste textuelle, sans Live Preview.

Retirer une référence ne supprime ni l'Asset ni le PNG. Des assets sans référence
peuvent donc rester conservés, notamment après un abandon d'insertion.
La galerie, la réinsertion, l'import, la suppression explicite, plusieurs captures,
l'agrandissement et la navigation temporelle depuis une image restent futurs.

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
(`/?tag_id=7`). Ceux des cartes restent non interactifs. Le bouton précédent
du navigateur retrouve la bibliothèque et son filtre lorsqu'on en vient ; le logo
Sillage ouvre la bibliothèque sans filtre. La fiche ne présente plus de lien
« Revenir à la bibliothèque » dédié.

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

### UX 1.1 — Callouts de citation en Lecture

Contrat validé le 14 octobre 2026, titre facultatif ajouté le 15 octobre 2026.
Deux formes seulement, sans moteur générique :

~~~markdown
> [!quote] Aristote
> L'homme est par nature un animal politique.

> [!quote:tr](sillage://videos/6/sources/6?start_ms=40360)
> decision models. So, when you go to ollama.com
~~~

La réflexion personnelle reste du Markdown ordinaire. Une citation de transcription
déclare une provenance ; son contenu est librement éditable, sans authenticité ni
synchronisation garanties. Note reste le document principal ; aucune Annotation
ou autre entité persistée n'est créée.

Reconnaissance au début de la première ligne de contenu d'un véritable blockquote,
hors code, en minuscules, sans échappement et sans ancêtre blockquote. Une citation
dans une liste est autorisée si Markdown reconnaît cette structure. Un blockquote
classique dans le corps reste ordinaire. Les callouts imbriqués ne sont pas enrichis :
leur en-tête connu reste visible et inerte. Aucun enrichissement dans les blocs de code.

- [!quote] accepte une attribution facultative, séparée par espace ou tabulation,
  rendue littéralement : pas d'emphase, de lien ni d'entité HTML interprétée dans l'attribution.
- [!quote:tr](URI) accepte uniquement la référence directe canonique, validée par
  parseTemporalReference, suivie facultativement d'un titre séparé par espace ou
  tabulation, limité à la ligne d'en-tête. Le titre est du texte simple, comme
  l'attribution : caractères Markdown et HTML littéraux. Sans titre ou avec
  uniquement des blancs, afficher « Transcription ». Cette règle remplace
  l'interdiction initiale de texte après l'URI.
  Aucun titre Markdown à l'intérieur des parenthèses du lien, paramètre end_ms,
  lien par référence ou destination répartie sur plusieurs lignes.
- Les blancs de fin d'en-tête sont tolérés. Une ligne citée vide après l'en-tête
  est facultative ; un corps vide est accepté.
- Le corps conserve le Markdown/GFM : paragraphes, listes, liens, tableaux, code,
  notes de bas de page, citations ordinaires et continuations sans répétition de >.
- En-tête connu mais invalide : blockquote ordinaire, en-tête littéral visible et
  inerte, même pour une destination HTTP(S) ou mailto. Les destinations commencées
  dans l'en-tête et poursuivies dans le corps restent inertes ; les autres liens
  du corps gardent leur traitement habituel.
- Marqueur inconnu (notamment quote:autre), échappé ou hors position de reconnaissance :
  Markdown habituel. La famille [!…] n'est pas réservée.

Les deux formes partagent un cadre, un en-tête et un corps, avec pictogrammes
distincts et désignations accessibles « Citation » / « Citation de transcription ».
Pour quote:tr, le pictogramme est suivi à gauche du titre personnalisé ou de
« Transcription ». Les titres longs reviennent à la ligne, y compris sur écran
étroit. La citation ordinaire garde son attribution facultative, sans libellé ajouté.
Le timestamp est calculé
depuis start_ms et placé en haut à droite ; sa description accessible indique
l'action et le temps. Clair/Sombre/Système et écrans étroits sont pris en charge.

La référence valide d'une autre vidéo/source reste reconnue. Son clic passe par
les contrôles de 6.5 : message accessible, aucune ouverture de fiche/source.
Toutes les garanties de disponibilité, pause, absence de commande différée et
défilement conditionnel de 6.5 sont réutilisées.

« Citer dans la note » génère désormais l'en-tête quote:tr suivi du texte échappé
sur une ligne citée, sans titre personnalisé ni duplication du timestamp en libellé
Markdown. L’utilisateur peut compléter le titre en Édition. Extraction,
premier fragment retenu, choix explicite de la position, sélection préservée, Undo/Redo
isolé, séparateurs extérieurs, autosauvegarde et conflits sont inchangés.
Les anciennes citations ne sont ni migrées ni requalifiées ; leur référence séparée
reste activable. L'insertion temporelle rapide conserve son format 6.2.
Les décorations CodeMirror sont traitées séparément en UX 1.2a ; aucun Live Preview.

Exemple avec titre personnalisé (UX 1.1, 15 octobre 2026) :

~~~markdown
> [!quote:tr](sillage://videos/6/sources/6?start_ms=40360) Les limites des modèles de raisonnement
> decision models. So, when you go to ollama.com.
~~~


### UX 1.2a — Présentation des citations dans l'éditeur Markdown

Une bordure verticale discrète et continue accompagne tous les véritables
blockquotes reconnus par le parseur Markdown de CodeMirror, y compris dans les
listes, leurs continuations sans > et leurs lignes citées vides. Les imbrications
partagent la bordure de citation de la ligne, sans multiplier les traits.
Les exemples de citation dans du code extérieur ne sont pas décorés ; un bloc
de code à l'intérieur d'une citation reste dans la présentation de cette citation.

Les callouts valides quote et quote:tr reçoivent un fond léger, un marqueur
identifiable et une attribution ou un titre mis en valeur. L'URI canonique du
callout de transcription est atténuée mais entièrement visible. Les règles de
reconnaissance restent celles d'UX 1.1 : premier contenu, marqueur non échappé,
pas d'ancêtre blockquote, URI valide. Les formes inconnues ou invalides gardent
seulement la présentation commune du blockquote et la coloration Markdown native.
Aucun libellé par défaut n'est ajouté dans le document édité.

Les décorations n'altèrent ni texte, curseur, sélection, historique, insertion,
sauvegarde ni session. Aucun élément interactif, masquage, remplacement d'URI ou
commande au lecteur en Édition. Clair/Sombre/Système et retours visuels à la ligne
sur écrans étroits utilisent les styles existants.

Orientation initiale UX 1.2b (précisée par UX 1.2b.1 ci-dessous) : représentation compacte de toutes les références
temporelles canoniques, dans les callouts ou le Markdown ordinaire. Cette étape
devra définir révélation, interactions et sélections ; elle n'est pas implémentée.

### UX 1.2b.1 — Références temporelles compactes en Édition

Les liens directs sur une seule ligne source, avec libellé simple non vide et
destination canonique validée, sont affichés avec une horloge et leur libellé.
Le Markdown enregistré reste inchangé. Les liens multilignes, par définition,
avec titre Markdown, libellé enrichi, échappements ou entités, les images, le code
et les URI isolées ou invalides restent visibles en source.

Les en-têtes connus de callout sont exclus, même invalides ou imbriqués :
attributions, titres littéraux et liens traversant l'en-tête ne sont pas enrichis.
Les liens ordinaires du corps restent éligibles. Les décorations UX 1.2a sont conservées.
Une référence valide d'une autre vidéo/source est compacte, sans navigation.

Un clic simple révèle la source et place le curseur au début du libellé.
Les positions exactement avant/après le lien restent extérieures et permettent
d'écrire, y compris entre deux références adjacentes. Les flèches gauche/droite
vers l'intérieur révèlent la source. Retour arrière/Suppr contre le lien compact
révèle sa source sans déplacer le curseur ni supprimer au premier appui ; ensuite l'édition est
ordinaire. Une sélection non vide intersectant le lien, même en l'englobant,
révèle sa source et garde les comportements natifs de copie/suppression.
Quand la sélection quitte son intérieur, le lien redevient compact.
Ces changements de présentation ne modifient ni le document, ni la sauvegarde,
ni l'historique des modifications.

Le widget ne crée aucun arrêt Tab supplémentaire. Son nom accessible indique
l'action de modification ; l'accès clavier passe par le curseur de l'éditeur.
Les libellés longs peuvent se replier. La composition IME suspend temporairement
la compaction pour ne pas remplacer le texte en cours de saisie.
« + Temps » garde son espace final, son curseur après l'espace et son Undo isolé.

UX 1.2b.1 a été validée manuellement par l'utilisateur. Les compléments de
compaction et de navigation sont livrés séparément en UX 1.2b.2 ci-dessous.


### UX 1.2b.2 — Références interactives en Édition

Seule l'URI des en-têtes quote:tr admissibles est compactée, avec ◷ et le
timestamp calculé depuis start_ms. Les parenthèses, le marqueur et le titre
restent visibles. Les règles UX 1.1 (première ligne, véritable blockquote,
hors code, sans ancêtre blockquote, URI canonique, titre littéral) s'appliquent.
Les attributions, titres et en-têtes connus invalides ou imbriqués restent inertes.
Les décorations UX 1.2a et les gestes d'édition UX 1.2b.1 sont conservés.

Clic simple : révéler la source. Ctrl+clic (Cmd+clic sur macOS) : activer une
référence compacte ou révélée sans changer la sélection ou l'état de révélation.
Seule une référence reconnue intercepte ce geste ; ailleurs CodeMirror conserve
ses interactions natives. Les combinaisons avec Shift ou Alt restent natives.
Ctrl/Cmd+Entrée active une référence lorsque l'unique curseur est strictement
à l'intérieur de sa plage (URI pour un callout, lien complet pour un lien ordinaire).
Aux frontières, dans un titre ou avec une sélection non vide/multiple, le raccourci
ne choisit aucune référence implicitement. Aucune activation pendant la composition.

Le callback 6.5 vérifie vidéo/source et appelle le lecteur existant : états,
absence d'autoplay sollicité implicitement, refus sans commande différée et
défilement conditionnel restent identiques. Le focus et la sélection de l'éditeur
sont préservés ; le défilement de la page vers la vidéo peut néanmoins les éloigner
visuellement. Les refus sont annoncés dans une région status près de l'éditeur,
séparée des messages de sauvegarde. Aucun arrêt Tab ni écriture n'est ajouté.

Finition du survol, après validation manuelle d'UX 1.2b.1 et 1.2b.2 :
le curseur reste natif au repos et devient une main lorsque Ctrl (Cmd sur macOS)
est maintenu sur une référence activable, compacte ou révélée. Le relâchement,
la sortie de l'éditeur ou la perte de focus de la fenêtre retire ce retour.
Shift/Alt désactivent la main, comme ils excluent le geste de navigation.
Les titres, en-têtes inadmissibles et liens non temporels gardent leur curseur.
Aucun changement de sélection, de focus, de navigation ou de Markdown.


## Téléchargement volontaire — 7.1 implémentée

L'action Télécharger est visible près des commandes du lecteur, même masqué ou
indisponible, et vise la même source de travail. Elle ne commande pas le lecteur,
ne remonte pas la note et ne modifie ni transcription ni références temporelles.
États : non téléchargé, en cours, disponible, échec. Une erreur de consultation
est distincte de l'absence. Le suivi reprend à l'ouverture/rechargement ; quitter
la page n'annule pas le transfert. Aucun réessai d'acquisition automatique.
La suppression confirmée cible le fichier exact et préserve toutes les connaissances.
La présence du fichier ne provoque aucune bascule vers une lecture locale.


Le bandeau affiche le conteneur, la taille en Mio et la durée lorsqu'un fichier
est disponible. Le dialogue natif de suppression cible l'identité affichée,
avec Annuler comme action initialement focalisée. Un fichier enregistré disparu
reste supprimable explicitement afin de résoudre sa référence cassée.

Le suivi consulte le serveur toutes les deux secondes pendant une acquisition,
à l'ouverture et au retour de visibilité/focus. Une erreur de consultation arrête
le polling jusqu'à actualisation ou retour sur la page ; elle ne propose jamais
Télécharger comme si le serveur avait confirmé l'absence. Une réponse POST perdue
est suivie d'un GET, sans nouveau POST. La saturation du serveur reste visible.
La navigation quitte uniquement le suivi navigateur, pas le travail serveur.
Le bandeau est compact sur desktop ; la hauteur du lecteur est ajustée en conservant
son minimum de 200 px pour préserver l'espace de transcription.

Le correctif conserve cette UX. Un média conservé peut utiliser un conteneur
non lisible par un futur lecteur Web. La maintenance des fichiers abandonnés
sera une action explicite future, jamais un nettoyage silencieux au démarrage.


### Métadonnées du fichier local — correctif livré

La section Métadonnées et sources accueille un bloc distinct Fichier local
pour la source de travail : conteneur, taille, dimensions encodées, FPS moyens,
codecs, langue audio déclarée et durée. Les inconnues sont explicites.
Le bloc partage le suivi existant, sans second polling ni confirmation avant
téléchargement. Il ne représente pas une nouvelle VideoSource.


### Decluttering — partie 1 : commandes du lecteur

Le panneau conserve son nom accessible « Lecteur » sans titre visible. Une
indication YouTube discrète remplace le titre ; le lien externe redondant est
retiré. L'œil barré masque la vidéo après mise en pause, l'œil la réaffiche.
La commande reste présente lorsque la vidéo est masquée. Les boutons à icône
ont un nom accessible, un focus visible et une infobulle au survol et au clavier.
Les commandes de conservation du fichier local restent inchangées à ce stade.


### Decluttering — partie 1 : transcription

L'en-tête regroupe « Transcription · LANGUE · automatique » et trois commandes
à icône : recherche, acquisition/actualisation et citation. La citation est la
dernière action avant le contenu lorsque la recherche est repliée, afin de
conserver le transfert clavier direct de la sélection vers son bouton.
La date d'acquisition figure dans l'infobulle d'actualisation, accessible au
survol et au focus ; Échap ferme les infobulles. Sans transcription, seul le
titre est affiché et le panneau indique comment lancer la récupération.
Les erreurs et opérations en cours restent explicites ; une erreur de lecture
n'est jamais présentée comme une absence de transcription.

La recherche est repliée par défaut. L'ouverture focalise le champ ; un second
clic sur la loupe ou Échap dans la barre replie celle-ci et rend le focus à la
loupe. La requête, les surlignages et le résultat actif sont conservés au repli,
avec un indicateur sur la loupe tant que la requête n'est pas vide. Le compteur
reste vide sans requête et affiche « Aucun résultat » si la recherche échoue.
Une action d'effacement conserve le focus dans le champ. Changer de vidéo ou
de source réinitialise la recherche et replie la barre. Aucune préférence n'est
persistée et aucune commande n'est envoyée au lecteur par la recherche.
Les règles de sélection, citation, Undo et autosauvegarde restent inchangées.


### Decluttering — partie 2 : barre YouTube unique

Le titre visible « YouTube » reprend la présentation de Note et Transcription.
La barre regroupe ensuite le format, la taille et la durée du fichier disponible,
puis une corbeille ; sans fichier, seule l'icône de téléchargement est proposée.
L'œil reste à droite, même lorsque la vidéo est masquée. La seconde ligne et son
séparateur disparaissent. Les informations reviennent à la ligne si nécessaire.
Les opérations et erreurs restent explicites, sans assimiler un état inconnu à
une absence. La confirmation de suppression et le suivi partagé sont conservés.
Il n'y a ni volet intermédiaire, ni sélecteur, ni lecture locale dans cette partie.

Les infobulles se ferment au clic et à la sortie du pointeur, y compris après
un changement de visibilité ou de recherche. Le focus laissé par un clic ne
les maintient pas ouvertes. Un focus clavier les affiche ; Échap les ferme.
Un nouveau survol ou une nouvelle interaction clavier peut les réafficher.


### Typographie des notes — Édition et Lecture

Le texte courant partage la police système de l'application, une taille de
16 px CSS et un interligne relatif de 1,5 (24 px). La largeur utile est plafonnée
à 700 px CSS, hors padding et bordure, et diminue naturellement sur écran étroit.
La colonne de contenu est centrée dans le panneau ; le workspace, les commandes
et les autres panneaux conservent leurs dimensions et leur typographie.
Les retraits internes des listes et citations réduisent leur largeur disponible.

Code inline, blocs clôturés et blocs indentés conservent une même pile monospace
dans les deux modes. L'éditeur utilise l'arbre syntaxique existant pour ces
marques, y compris autour de la coloration imbriquée d'un langage. Le Markdown,
les espaces et les tabulations ne sont pas modifiés. Le retour visuel à la ligne
en Édition et le défilement horizontal des blocs de code en Lecture restent
inchangés. Les alignements manuels en espaces hors code ne forment plus une
grille monospace ; les tableaux rendus restent des tableaux en Lecture.

Titres, emphases, callouts, images et références temporelles gardent leurs
présentations spécifiques. La cohérence typographique ne rend pas les deux modes
identiques : le Markdown source et le rendu produisent des hauteurs différentes.
La bascule conserve la session, l'historique, les sélections et l'autosauvegarde ;
un changement d'affichage seul n'enregistre pas la note.

## Lecture locale — première implémentation et decluttering partie 3

Une seule zone propose le choix YouTube / Local. À chaque ouverture, le lecteur
attend la consultation initiale : Local si le média de la source de travail est
disponible, sinon YouTube, y compris en cas d'échec de consultation. Aucun lecteur
distant n'est monté pendant cette attente. La note et la transcription restent
accessibles. Ce choix n'est calculé qu'une fois par session, sans préférence persistée ;
une actualisation de disponibilité ne change pas le mode sélectionné.

Le contrôle segmenté YouTube / Local conserve le mode réellement sélectionné.
Sans fichier disponible, cliquer Local ouvre une modale de conservation sans changer
le mode actif ; ce comportement remplace la sélection systématique de Local vide.
Après suppression depuis Local, ce mode reste sélectionné et son panneau vide
propose la même modale. Les états vide, acquisition, erreur de consultation et fichier
disponible restent distincts. Informations et œil restent sur la même ligne permanente.
Les métadonnées et commandes de conservation sont accessibles dans les informations
contextuelles ou la modale, avec la consultation partagée existante.

La fin d'une acquisition ne change jamais le mode choisi. Si Local est déjà choisi,
le fichier peut apparaître dans ce panneau, sans lecture automatique. Aucun
transfert de position n'est gardé en attente d'un téléchargement futur.

Une bascule relève la position courante admissible si possible, arrête et décharge
l'ancienne instance puis prépare la nouvelle sans autoplay. Le départ préparé reste
transférable tant qu'aucune activité ne l'a rendu incertain : Local à 0:40,
YouTube préparé sans lecture, puis Local conserve 0:40. Une référence acceptée
depuis YouTube cued abandonne ce départ et demande une navigation avec lecture ;
une commande refusée ne le remplace pas.
Le transfert peut attendre une fois l'initialisation de la nouvelle instance,
sans reporter les navigations ordinaires.
L'absence normale de position avant une première lecture ne produit aucun avertissement.
Une position devenue incertaine (erreur, buffering, seek local en cours) n'est jamais
remplacée par une ancienne position : la bascule sans transfert est signalée.
Cette mémoire est limitée à la fiche et à sa source temporelle pendant la session ;
elle ne constitue pas une reprise de lecture persistée.
YouTube peut afficher une vignette avec départ préparé plutôt qu'une image à
l'instant demandé. La correspondance reste approximative. La position initiale
locale est bornée par la durée décodée ; une navigation ordinaire hors durée est
refusée. Les timestamps sur un lecteur non prêt restent refusés sans mise en attente.

Masquer Local met en pause et conserve normalement sa position ; réafficher ne
relance rien. La note, sa sélection, Undo/Redo, l'autosauvegarde et la transcription
restent montées au changement de mode. Les références vidéo/source existantes
commandent uniquement le lecteur actif de cette même source. + Temps et + Capture
lisent exclusivement sa position courante admissible, y compris masqué en pause, sans commande
de lecture. Un départ préparé ne suffit jamais à ces opérations, même si le
masquage fait passer YouTube à l'état paused. Le local
refuse une position pendant le chargement, le seek ou après une erreur.
Les captures gardent leur extraction serveur et leur repli distant sélectif.

Une erreur de lecture reste en Local, avec un message prudent, un réessai et le
choix manuel YouTube. Elle ne transforme pas le téléchargement en échec et ne
provoque ni conversion ni effacement. Le navigateur et ffmpeg peuvent avoir des
capacités de décodage différentes.

Après confirmation de suppression, le lecteur est arrêté et déchargé avant DELETE.
Une réservation concurrente peut encore provoquer un refus temporaire ; aucun
réessai automatique de suppression. En cas de refus, recharger le lecteur est
une action explicite. Après succès, Local reste sélectionné avec l'état sans fichier.
Les connaissances et captures restent intactes. Un rafraîchissement recommence
le choix initial : YouTube dans cette phase, puis la politique cible après validation.


## Panneau vidéo — phase 1 : barre stable et conservation volontaire

Le panneau et l'en-tête restent montés lors d'une bascule ; seule la surface propre
au lecteur change. Les deux boutons natifs ont aria-pressed et gardent le focus ;
aucun mode n'est annoncé sélectionné pendant la consultation initiale.
Les marges de la vidéo, ratios et limites de hauteur restent inchangés dans cette phase.

Cliquer Local avec un fichier disponible sélectionne le lecteur. Sinon une seule
modale présente l'état courant : confirmation Télécharger si absent, activité sans
POST si téléchargement en cours, erreur et Réessayer si échec, Actualiser l'état
si consultation incertaine. Une référence à un fichier indisponible reste supprimable
après confirmation. Les changements d'état serveur actualisent la fenêtre ouverte.
Annuler/Échap ferme sans acquisition. Pendant une activité, Fermer ferme seulement
la fenêtre et ne prétend pas annuler le travail serveur. Confirmer déclenche un seul POST puis ferme
la fenêtre sans attendre son résultat. YouTube n'est ni arrêté ni remplacé.
Le panneau Local vide après suppression utilise exactement cette même fenêtre.

Un emplacement fixe devant Local accueille un spinner pendant la demande ou
l'activité serveur, une coche verte après conservation confirmée et une croix rouge
après échec d'une activité suivie. Les deux résultats durent cinq secondes.
Les annonces accessibles complètent les symboles, sans dépendre de la couleur.
Une première consultation available/failed reste neutre ; downloading rétablit
le spinner après rafraîchissement. Les résultats ne sont pas persistés.
Après POST perdu, une conservation confirmée peut annoncer le succès ; un ancien
failed sans activité observée ne prouve pas l'échec d'une nouvelle demande.
Une erreur de consultation, de suppression ou de décodage ne produit pas de croix.
Les erreurs importantes restent visibles et leur détail reste consultable.

Informations ouvre un popover non modal, fermé par Échap, clic extérieur, bouton
Fermer ou changement de mode. Il prend le focus à l'ouverture ; Échap rend le
focus à Informations, tandis qu'un clic extérieur garde sa destination.
Les informations YouTube concernent la source de travail : titre, identifiant,
compte de publication, durée, URL et description repliable.
Les informations Local incluent les propriétés techniques et added_at du fichier,
ainsi que sa suppression. La confirmation ferme le popover ; Annuler est focalisé.
Après fermeture de la confirmation, le focus revient à Informations.
Seule une suppression confirmée depuis Local décharge le média ; depuis YouTube,
le lecteur distant reste intact. Une suppression refusée permet de recharger le local.

La section Métadonnées et sources reste intégralement accessible : toutes les sources,
leurs descriptions et les informations internes à Sillage ne sont pas remplacées
par le popover de la source de travail.

### Phase 2 différée : surface bord à bord

Une validation visuelle et fonctionnelle explicite de la phase 1 est obligatoire
avant toute modification des marges de la surface ou de ses dimensions.
Le rendu bord à bord n'est pas réalisé dans cette phase.

### Parcours exploratoire : conserver des clips d'étude

Piste future, sans implémentation ni modèle arrêté : télécharger une vidéo complète,
l'étudier et repérer des plages, produire quelques clips durables, les réutiliser
dans les notes, puis supprimer volontairement le complet en conservant clips, notes,
transcriptions et captures. L'export externe serait une possibilité distincte,
facultative. Voir les questions ouvertes de la roadmap ; aucune option de découpe
ou d'export n'est ajoutée à la barre actuelle.

## Orientation de travail — accès immédiat et étude approfondie

YouTube est le moyen d'accès immédiat à une vidéo ; Local est le mode de travail
privilégié pour l'étudier en profondeur. YouTube permet la consultation, les notes,
les références et les captures sans téléchargement préalable. Local facilite
l'étude prolongée, les navigations répétées et la rédaction structurée.
Cette orientation ne réserve aucune action d'annotation à Local.

Les priorités sont, dans cet ordre, la fiabilité et la fluidité des annotations,
le fonctionnement naturel de la lecture/navigation, puis le confort de continuité
entre lecteurs. La priorité initiale Local lorsque le fichier est disponible reste
inchangée.

Pour YouTube, + Temps et + Capture utilisent le temps réellement annoncé au clic
dans un état admissible, jamais la cible d'une commande. Après un seek vers
80.123 s, un temps annoncé de 80.080 s produit une référence ou une demande de
capture à 80080 ms. Aucun verrou ne dépend de l'égalité avec la cible, d'une
tolérance, d'un délai ou d'une notification de fin de seek.
Une mesure peut rester momentanément ancienne après une commande : cette limite
de fraîcheur de l'API est acceptée, sans promettre une synchronisation image par
image. Les millisecondes des données Sillage restent conservées.

Une référence Markdown ou un timestamp de transcription exprime une intention
explicite : YouTube navigue en conservant la lecture ou la pause ; depuis non
démarré, cued ou terminé, il demande aussi le démarrage. Une bascule vers YouTube
prépare toujours le départ sans lecture. Une préparation seule ne permet pas
d'annoter. Local conserve strictement son comportement de navigation actuel.

Si YouTube signale que le navigateur a bloqué le démarrage, afficher un message
invitant à utiliser Lecture dans le lecteur, sans le détruire ni relancer la
commande. Le message disparaît lorsque la lecture démarre. Le signal n'est pas
garanti après seekTo : aucune absence de lecture n'est diagnostiquée par délai.
L'ouverture d'une fiche et les bascules ne déclenchent jamais de lecture.

### Navigation YouTube — règle actuelle

Cette règle remplace les descriptions antérieures de préparation sans lecture
lors d'un clic temporel avant première lecture : seul le transfert entre lecteurs
prépare désormais un départ. Les commandes refusées avant disponibilité ne sont
toujours pas différées. Masquage en cours, erreurs, identités vidéo/source et
conservation de la session de note restent protégés.

## Panneau vidéo — phase 2 bord à bord

Les surfaces YouTube et Local rejoignent les bords intérieurs gauche, droit et
inférieur du panneau Lecteur. L'en-tête et les messages gardent leur espacement
de 1rem, avec la séparation existante de .75rem avant la surface. Les coins
inférieurs de la vidéo suivent ceux du panneau.

Les ratios, hauteurs minimales, limites de hauteur et seuils responsive restent
inchangés. Une largeur accrue ne garantit pas une image agrandie sur desktop :
les bandes noires restent possibles, sans recadrage. Le popover Informations
peut dépasser le panneau, notamment lorsque le lecteur est masqué.
Les états sans surface retrouvent le padding inférieur normal.
Aucun changement de comportement des lecteurs ou du workspace.
