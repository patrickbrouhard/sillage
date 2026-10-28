# Product & UX — Sillage

Ce document décrit **le comportement produit et les contrats UX actuellement applicables** dans Sillage. Il ne
retrace pas les étapes de développement et ne constitue ni une roadmap ni un journal de validation.

- [Vision et principes du projet](00-project-brief.md)
- [Modèle de domaine](02-domain-model.md)
- [Architecture et contrats techniques](03-architecture.md)
- [Choix techniques](04-tech-stack-and-decisions.md)
- [Avancement et étapes prévues](05-roadmap.md)
- [Questions non résolues et pistes futures](06-open-questions.md)
- [Recette manuelle lecteur/workspace](07-local-playback-validation.md)

Les descriptions ci-dessous portent sur l'interface actuelle, sauf lorsqu'un comportement est explicitement
identifié comme **futur**. Les détails de persistance, algorithmes et erreurs REST relèvent prioritairement des
documents 02 à 04.

## 1. Parcours principal

Le parcours central est : **ajouter une vidéo → la retrouver dans la bibliothèque → ouvrir sa fiche → regarder,
annoter et capturer → retrouver les connaissances**.

La fiche vidéo est un espace de travail durable, pas une modale. L'utilisateur doit pouvoir prendre des notes
rapidement, sans devoir d'abord structurer ses connaissances, télécharger le média ou utiliser une IA. La
structure plus forte (annotations, relations, recherche transversale) peut venir dans un second temps.

### 1.1 Ajouter une vidéo

- Un champ accepte une URL YouTube. L'ajout crée une `Video` et sa `VideoSource`, ou retrouve une source déjà
  enregistrée sans dupliquer la vidéo.
- Les états de chargement, succès, doublon et erreur doivent être explicites. Le formulaire n'implique ni
  téléchargement du média ni acquisition de transcription.
- L'import peut rattacher un `Publisher` YouTube identifié par `channel_id`. Une identité non fiable n'empêche
  pas la création de la vidéo ; le nom du publisher peut être absent et n'identifie jamais une `Person`.
- Les champs utiles sont normalisés. L'application ne conserve pas un dump brut intégral de `yt-dlp` par défaut.

Les sources locales, autres plateformes et autres points d'entrée (extension, CLI, MCP) demeurent des évolutions distinctes ; voir [Open questions](06-open-questions.md).

### 1.2 Bibliothèque

- La bibliothèque conserve un `h1` « Bibliothèque » masqué visuellement et le titre de l'onglet, sans surtitre,
  grand titre visible ni accroche. Ses marges sont compactes : 16–20 px au-dessus du contenu, 16 px latéraux sur
  mobile et 32 px sur desktop. Le compteur n'a pas de séparateur supérieur ; aucune action Actualiser.
- Les cartes cliquables vers la fiche, sauf leurs liens de tags, gardent leur grille responsive et leurs
  miniatures 16:9. La provenance apparaît en badge contrasté en haut à droite de la miniature, la durée en bas à droite (zéro reste valide).
  Ce badge est réservé aux cartes de bibliothèque et n'indique ni média local ni mode de lecture.
  Titre, publisher et tags complets se replient ; les métadonnées absentes gardent leurs replis, sauf « Aucun
  tag » qui est supprimé sans espace réservé. Padding de 13 px, grille espacée de 16 px, survol sans mouvement
  et focus clavier visible.
- La bibliothèque présente les vidéos sous forme de cartes avec miniature, titre, provenance et tags. La
  première source retournée par REST fournit actuellement les informations de présentation d'une carte ; ce
  n'est pas une source principale persistée.
- L'utilisateur peut ouvrir une fiche, ajouter une vidéo, gérer les tags des vidéos et filtrer la bibliothèque
  par **un tag**. Le filtre est porté par l'URL (`/?tag_id=7`), réutilisable à la navigation.
- Filtres ouvre un popover natif non modal, vertical, borné au viewport et défilable si nécessaire.
  Un champ avec autocomplétion recherche les tags existants par correspondance partielle, sans distinction
  de casse, sans création de tag. Une saisie vide propose le catalogue ; une saisie sans correspondance
  l'indique sans modifier le filtre. Flèches haut/bas parcourent les suggestions ; Entrée valide la suggestion
  active, un clic la sélectionne aussi. La saisie seule ne déclenche aucune requête de vidéos.
  Le choix d'un seul tag s'applique immédiatement dans l'URL, préserve les autres paramètres et laisse le panneau ouvert ; Réinitialiser apparaît si un filtre existe.
  Aucun état provisoire ni bouton Appliquer. Ouvrir/fermer le panneau n'envoie aucune requête de vidéos.
- Le bouton expose son état et son panneau contrôlé, sans badge au repos, avec un discret « 1 » pour le
  critère tag présent, même inconnu ou invalide. Les répétitions ne comptent pas comme des critères supplémentaires.
  Le tag actif est aussi visible près du compteur, avec retrait direct explicitement nommé, disponible pendant
  le chargement et les erreurs. Le nom complet et sa croix partagent une pilule : le retrait est ainsi associé
  visuellement à ce tag, y compris lorsque son nom se replie. La croix garde une cible de 40 × 40 px et un focus
  visible ; seul son centre de 24 × 24 px se colore au survol. Le retrait direct rend le focus à Filtres ;
  Réinitialiser le rend au champ du panneau. Un ID inconnu reste identifiable et supprimable.
- À l'ouverture le champ reçoit le focus. Un premier Échap replie les suggestions ouvertes ; le suivant
  ferme le panneau et restitue le focus au déclencheur. Second clic et clic extérieur ferment ; le clic extérieur
  garde sa destination de focus. Aucun piège de focus. Navigation hors bibliothèque et ouverture du hamburger
  ferment le panneau ; un défilement extérieur le ferme pour préserver son ancrage. Un changement de filtre
  le conserve.
- Les paramètres invalides restent signalés ; plusieurs `tag_id` constituent une erreur explicite, sans
  normalisation silencieuse. L'échec du catalogue n'empêche ni les vidéos ni le retrait du filtre ; son erreur
  et sa relance restent dans le panneau. Les réponses obsolètes sont annulées ou ignorées. Les erreurs de
  vidéos gardent Réessayer, sans synchronisation automatique.
- Les tags des cartes, des fiches et des résultats de recherche sont des liens natifs vers `/?tag_id=...`.
  Ils remplacent le filtre existant, sans combinaison multitag. Les cartes séparent le lien vers la fiche
  (surface étendue à la carte) et les liens de tags, sans liens imbriqués. Le clavier et les ouvertures dans
  un nouvel onglet conservent les comportements natifs ; un clic sur un tag n'ouvre pas la fiche.
- Le bouton précédent du navigateur conserve l'historique et le filtre d'origine. Le logo Sillage mène à la
  bibliothèque sans filtre. La fiche ne contient pas de lien « Revenir à la bibliothèque » dédié.
- Bibliothèque vide, filtre sans résultat, chargement et erreur sont des états distincts. Une erreur API ne doit
  pas être masquée par un repli SPA.

Les filtres combinés, tris personnalisés et vues enregistrées restent des extensions futures. La recherche globale est un parcours distinct décrit ci-dessous.

### 1.3 Gestion des tags

- Un bouton « Gérer les tags » ou « Ajouter des tags » ouvre la modale existante ; autocomplétion, flèches,
  Entrée et Échap restent accessibles.
- Chaque ajout ou retrait est enregistré immédiatement. Fermer la modale n'annule pas les changements déjà
  confirmés ; il n'existe pas de sauvegarde globale de la modale.
- Retirer un tag d'une vidéo ne supprime ni le tag du catalogue ni ses autres associations.
- Les tags sont un catalogue partagé, associable aussi aux publishers et personnes via REST. Les associations
  sont indépendantes, sans propagation automatique.
- L'identité des tags est gérée par le backend (NFC, comparaison insensible à la casse, accents significatifs),
  et non par l'autocomplétion UI.
- La page `/tags`, accessible dans la navigation générale, administre le catalogue en lignes responsive,
  sans tableau. Chaque ligne affiche le nom et les associations directes par catégorie, par exemple
  « 18 vidéos · 2 publishers · 1 personne » ; les catégories vides sont masquées, ou remplacées par
  « Inutilisé » si aucun lien n'existe.
- La recherche par nom est locale, partielle et insensible à la casse, avec rapprochement NFC des
  graphies canoniquement équivalentes ; les accents restent significatifs. Le tri alphabétique français est
  le défaut ; les tris par utilisations croissantes ou décroissantes additionnent les trois compteurs,
  puis départagent par nom et ID. Recherche et tri ne modifient pas l'identité métier.
- Le crayon ouvre un champ prérempli et sélectionné dans la ligne : Entrée ou Enregistrer valide,
  Échap ou Annuler abandonne le brouillon. Une collision laisse l'édition ouverte avec une erreur.
  Le succès actualise la ligne et son classement, sans confirmation supplémentaire. Le focus revient au
  crayon, ou à la recherche si le nouveau nom sort du filtre, sauf si l'utilisateur l'a déjà déplacé
  pendant la requête. Les brouillons survivent aux tris et filtres.
- La corbeille ouvre une confirmation avec le nom et les associations concernées. Annuler reçoit le
  focus initial ; Échap annule avant soumission. La suppression est possible même pour un tag utilisé,
  conserve les entités associées et retire la ligne sans recharger la page. Le focus revient à la
  recherche après succès, au déclencheur après annulation. Les compteurs ne bloquent pas une suppression
  si d'autres associations sont ajoutées entre-temps. Un échec permet de réessayer dans le dialogue.
- Après une erreur de mutation, « Actualiser le catalogue » relit explicitement le serveur sans rejouer
  l'écriture, y compris depuis la confirmation de suppression. Une erreur réseau ou une réponse invalide
  ne prouve pas l'échec : l'interface signale que la modification a peut-être été enregistrée.
  Une relecture réussie remplace le brouillon de la seule ligne concernée par l'état enregistré, ferme
  son édition ou dialogue et rend le focus à la recherche, sauf si l'utilisateur l'a déplacé pendant
  la lecture. Les autres brouillons sont conservés ;
  une relecture en échec les conserve tous et reste réessayable. La récupération attend la fin des
  mutations en cours ; une nouvelle mutation invalide toute lecture déjà en vol.
- Le catalogue présente ses états de chargement, d'erreur réessayable, de liste vide et de recherche sans
  résultat. Les mutations évitent les doubles soumissions. Cette page ne crée pas de tags et ne propose
  ni fusion, ni opérations en masse, ni filtre dédié aux tags inutilisés.
- La gestion Web complète des publishers et personnes reste future, bien que les capacités métier/REST existent
  déjà. Les homonymes de personnes ne sont pas fusionnés, et une personne associée à un publisher n'est pas
  automatiquement associée à toutes ses vidéos.

### 1.4 Recherche globale

`/search` invite à rechercher ; `/search?q=...&page=...&sort=newest` porte une requête partageable. Entrée ou la loupe soumet la saisie ; aucune requête n'est déclenchée pendant la frappe. Une nouvelle soumission depuis `/search` conserve le tri et revient en première page ; une soumission identique relit les données. Une recherche commencée depuis un autre parcours utilise Pertinence par défaut, sans préférence globale stockée. Rechargement, précédent et suivant restaurent requête, page et tri ; les réponses obsolètes sont annulées ou ignorées, même après des changements rapides de tri.

Un sélecteur natif compact « Trier par », près du compteur, propose exactement « Pertinence » et « Ajout le plus récent ». Pertinence est le défaut : classement BM25 puis ID vidéo croissant. Le second choix utilise la date d'ajout de la vidéo dans Sillage décroissante, puis son ID décroissant à date égale ; il ne s'agit ni de publication ni de modification. Changer de tri conserve la requête soumise sans soumettre le brouillon, retire la page de l'URL et charge la première page. L'URL porte le choix ; revenir à Pertinence supprime `sort`, mais les liens explicites `sort=relevance` sont acceptés. Le sélecteur reste disponible sur les pages vides et monté pendant le chargement pour préserver le focus clavier. Un tri invalide reste une erreur explicite, y compris sans requête, plutôt qu'une invitation à rechercher.

La recherche retourne des vidéos, une fois chacune, à partir des titres et descriptions de toutes leurs sources, noms des publishers, tags directs et texte des notes. Les tags de publishers/personnes et transcriptions ne sont pas hérités ou indexés. Une citation copiée dans une note reste du texte de note.

Tous les termes sont obligatoires, même répartis entre champs ou sources. La casse et les accents latins pris en charge par SQLite sont ignorés. À partir de quatre lettres/chiffres, le préfixe est automatique : `kube` retrouve Kubernetes ; `Go`, `API`, `SQL` et `net` restent entiers. `.NET` peut correspondre à net ; `node.js` donne node en préfixe ET js entier. `C++`, `C#`, `C` restent distincts. Aucune syntaxe FTS ou expression exacte entre guillemets n'est exposée.

Les résultats forment une liste horizontale avec miniature, titre et publisher de la première source REST, tags et ouverture vers la fiche. Leurs tags sont des liens vers la bibliothèque filtrée par l'ID du tag : toutes les vidéos directement associées sont affichées, indépendamment de la recherche précédente. Le retour navigateur restaure la recherche, sa page et son tri. Les résultats sont espacés sans séparateur horizontal. Aucun libellé de plateforme ne précède le titre. La ligne de chaîne affiche aussi la date d'ajout dans Sillage, au format « TechWorld · Ajoutée le 24 oct. 2026 ». Une petite icône d'information après la date ouvre les explications complémentaires existantes (autres sources contributrices et correspondances en description/publisher), après un bref survol (300 ms) ou immédiatement au clic. Elle est absente sans explication complémentaire, notamment pour un titre seul de première source. Le popover natif reste consultable au clavier et au toucher : Entrée ou Espace l'ouvre, Échap et clic extérieur le ferment. Son contenu reste dans le viewport et peut défiler ; le survol peut passer du bouton au panneau sans le refermer. Plusieurs sources peuvent contribuer sans désigner une origine unique. Un extrait apparaît seulement si la note correspond ; ses marques de surlignage portent sur du texte littéral et ne prétendent pas montrer tous les termes. Il est présenté en texte continu et sur deux lignes visuelles au maximum, en conservant une correspondance visible. Le contexte précédent peut être abrégé par une ellipse ; un token exceptionnellement long conserve une portion surlignée visible. Les blancs sont réduits sans fusionner les mots ni déplacer les attributions ou corps de citations.

L’extrait sert à comprendre le contexte de la correspondance pour décider d’ouvrir la fiche vidéo ; il ne remplace pas la lecture de la note. Le contexte disponible est borné côté serveur selon le [contrat technique des extraits](search.md#explications-et-extraits).

« Voir plus » apparaît seulement si l'extrait disponible est abrégé à l'affichage. Il restitue tout l'extrait déjà reçu, sans charger la note ni faire d'appel réseau ; « Réduire » rétablit la fenêtre compacte. Chaque résultat possède son état indépendant, réinitialisé pour une nouvelle recherche ou un extrait remplacé. Le bouton garde le focus et expose son état et son contenu contrôlé aux technologies d'assistance. Le calcul des deux lignes suit la largeur et la taille du texte.

La page affiche le nombre total exact de vidéos correspondantes, indépendamment du tri et du nombre de résultats sur la page courante. Une page vide avec un total positif annonce « Aucun résultat sur cette page », distinct d'une recherche sans correspondance. La pagination propose 20 résultats par page et un lien suivant lorsque d'autres résultats existent, sans garantie d'instantané entre requêtes. La page reste compacte : aucun bandeau visible « Recherche », sous-titre de requête ou séparateur au-dessus du compteur. Un titre principal masqué visuellement conserve le contexte pour les lecteurs d'écran. Invitation, chargement, résultats et erreur avec nouvelle tentative restent annoncés. Les longues chaînes se replient sur petit écran sans débordement.

## Authentification et continuité

La connexion locale donne accès à la bibliothèque unique du propriétaire. L'initialisation
et la récupération sont des commandes administratives interactives, sans inscription publique.
Le [contrat de sécurité](security.md) détaille les cookies, sessions et points d'entrée.

Une expiration ou révocation masque l'application et ouvre une modale de reconnexion,
sans démonter la fiche, CodeMirror ni la session de note. Les temporisations sont suspendues ;
la reconnexion reprend la réconciliation existante sans remplacer le brouillon ni effacer
un conflit. Une déconnexion volontaire demande une confirmation avant d'abandonner un
brouillon non confirmé ; les autres onglets se verrouillent sans perdre leur texte.
Les brouillons restent en mémoire seulement, sans garantie après fermeture ou crash.

## 2. Navigation générale et fiche vidéo

### 2.1 En-tête et volet de navigation

- Le bouton hamburger précède la signature Sillage sur toutes les pages. Il ouvre un **volet gauche superposé**,
  fermé par défaut, sans redimensionner le workspace et sans agir sur les lecteurs.
- Le volet contient Bibliothèque, Rechercher, Tags, Ajouter une vidéo et le choix de thème **Clair / Sombre /
  Système**. La section Session permet de déconnecter ce navigateur ou toutes les sessions. Aucun faux contrôle Paramètres ou Compte.
- L'arrière-plan est rendu inerte pendant l'ouverture ; le focus reste dans le volet. Échap, le bouton Fermer et
  le clic extérieur ferment le volet. Lors d'une navigation, le volet se ferme d'abord pour laisser apparaître
  les éventuelles protections de départ de la note.
- Le choix de thème est local au navigateur ; **Système** est le choix par défaut et suit les changements de
  l'OS. Un refus de stockage n'empêche pas de changer le thème pour la page courante. Les changements de thème
  ne démontent pas la session d'édition.
- La palette actuelle est bleutée (bleu nuit en sombre), avec un signal d'erreur distinct. Le contenu intégré de
  YouTube conserve son propre thème.

L'action Rechercher ferme le volet avant le garde de note. Elle focalise le champ seulement après une navigation autorisée, y compris depuis `/search` lui-même. Ce focus est coordonné avec l'annonce du contenu principal ; réponses et pagination ne le déplacent pas. Ouvrir/fermer le volet conserve lecteur, éditeur, sélection, Undo/Redo, conflit et autosauvegarde.

Le hamburger utilise une cible de 40 × 40 px et une icône 24 px. L'en-tête utilise des marges latérales de 16 px
et ne doit pas créer de débordement horizontal.

### 2.2 En-tête compact de la fiche

La fiche vidéo possède un bandeau transparent, sans séparateur horizontal ni footer, comprenant le hamburger, la
signature Sillage, le titre et les tags. Bibliothèque et recherche partagent ses dimensions compactes, son fond
transparent et son absence de bordure, avec un champ centré par rapport au bandeau entier. Lorsque la place
manque, ce champ occupe une ligne distincte. Dans la bibliothèque, Filtres puis Ajouter une vidéo
occupent la droite ; deux pistes latérales symétriques préservent le centrage réel de la recherche. Sous
1 200 px, la recherche passe sur la seconde ligne ; jusqu'à 600 px, l'ajout devient « + » avec le nom accessible
« Ajouter une vidéo ». Les commandes compactes gardent des cibles de 40 px minimum, sans hauteur fixe.
Ajout/erreur utilisent la coque compacte sans champ. Le footer « Des vidéos aux idées » est supprimé sur toutes
les pages. La fiche ne contient aucun champ de recherche et conserve son portail titre/tags.

- Le titre provient actuellement de la **première source REST**, sans requête supplémentaire ni titre
  personnalisé. Chargement et erreur ont leurs propres libellés. Le titre intégral reste sélectionnable dans
  l'onglet Informations.
- Sur desktop, on privilégie le titre entier. Le groupe titre/tags est centré sur la page seulement lorsque cela
  ne réduit pas l'information visible ; sinon il est aligné à gauche après la signature. Le texte du titre reste
  aligné à gauche.
- Les tags apparaissent en pilules neutres, sans commande de suppression intégrée. Ils conservent leur ordre
  REST ; on affiche le **plus long préfixe qui tient**, sans sauter un tag long pour en montrer un plus court.
- Les tags masqués sont accessibles par **`+n`** et son popover, avec noms complets et liens de filtre. Le
  bouton de gestion suit les tags visibles ou `+n`, sans remplacer la modale d'édition.
- Les interactions du popover sont accessibles au clavier : Tab vers les liens, Échap avec restitution du focus,
  fermeture au clic extérieur et lorsque son contenu affiché devient obsolète. Les redimensionnements ne doivent
  pas produire d'instabilité visible.
- Sous 1 100 px, les tags occupent une ligne séparée. Sur petit mobile (600 px et moins), le titre est limité à
  deux lignes. L'ordre des liens, l'accès à la gestion des tags et les états de focus restent utilisables à
  320/375 px.

Le bandeau desktop a une hauteur minimale de 56 px, susceptible d'augmenter avec le contenu ou le zoom ; ne pas
considérer sa hauteur comme fixe.

### 2.3 Organisation du workspace

Sur desktop, à partir de **1 100 px** :

- **Note** à gauche, **Lecteur** au-dessus de **Transcription** à droite ; rapport de colonnes actuel **1,2 /
  1**, écart horizontal de 16 px.
- Le lecteur et la transcription forment un **cadre visuel droit commun**, tout en restant des composants
  distincts. La note et le texte de transcription défilent indépendamment.
- Le workspace exploite la hauteur sous l'en-tête réel ; sa largeur maximale est de 1 720 px, ses marges
  intérieures latérales de 32 px, avec 8 px au-dessus et 16 px en dessous. La hauteur minimale de 38 rem permet
  le défilement de page sur fenêtre basse.
- Le texte de transcription conserve au moins **12 rem** de hauteur utile hors commandes, recherche et messages,
  lorsque le layout le permet. Les contenus longs ne doivent pas agrandir arbitrairement la grille.
- Masquer la vidéo libère sa hauteur pour la transcription ; les commandes du lecteur restent accessibles. Un
  contenu indisponible ne doit pas imposer artificiellement une surface vidéo noire vide.

Sous **1 100 px**, le flux de page est **Lecteur → Note → Transcription**, dans trois cadres séparés. La page
peut défiler naturellement, sans débordement horizontal ni destruction de la session Note.

Les popovers doivent pouvoir déborder des panneaux. Le redimensionnement manuel des séparateurs et le
détachement du lecteur sont des pistes futures, pas des fonctions existantes.

### 2.4 Onglets Note et Informations

- La zone de rédaction dispose de deux onglets locaux : **Note** (sélectionné initialement) et **Informations**.
  Les tags restent dans l'en-tête global de la fiche.
- Les onglets sont soulignés, avec un focus clavier visible distinct ; gauche/droite, Home et End permettent de
  naviguer entre eux.
- Les bascules préservent la session de note montée, son mode Édition/Lecture, son contenu, son historique
  Undo/Redo, sa sélection, son défilement et l'autosauvegarde. Elles ne provoquent aucune écriture à elles
  seules.
- L'onglet Informations affiche les données complètes : date d'ajout à Sillage, toutes les sources, leurs
  descriptions, la source de travail et les métadonnées du fichier local. Les descriptions longues sont
  dépliables individuellement ; une description absente ne produit pas de volet vide.
- Erreurs, conflits et protection de départ de la note demeurent accessibles quand Informations est actif. Les
  captures acceptées continuent de se terminer.
- Une citation depuis Informations ne révèle Note et ne focalise l'insertion **que si elle est admissible**. Un
  refus laisse l'onglet inchangé et n'envoie aucune commande au lecteur.

## 3. Note Markdown et sauvegarde

### 3.1 Contenu et modes

- Chaque `Video` possède **zéro ou une note principale**, créée au premier enregistrement, et indépendante des
  sources, des transcriptions et des médias.
- Une note absente et une note persistée vide sont différentes. Aucune note n'est créée à la simple ouverture.
- Le contenu est du **Markdown source**. Édition utilise CodeMirror 6 ; Lecture rend du GFM sécurisé sans
  exécuter de HTML brut. Il n'existe pas de WYSIWYG généralisé.
- Les fins de ligne sauvegardées sont canoniques **LF (`\n`)** ; les anciennes formes CRLF/CR sont normalisées à
  la sauvegarde uniquement, sans migration ni écriture provoquée par la lecture.
- Le sélecteur à icônes utilise un crayon pour **Édition** et un livre ouvert pour **Lecture**. Ces noms
  accessibles sont aussi les infobulles au repos. Le groupe « Mode de la note » contient deux boutons natifs
  avec `aria-pressed` exclusifs ; un fond distinct indique le segment actif, avec un focus clavier visible.
- La bascule Édition/Lecture ne modifie pas le document et ne détruit pas la session d'édition. Les interactions
  visuelles n'écrivent pas de contenu implicite.

### 3.2 Édition, autosauvegarde et conflits

- Autosauvegarde après **2 s d'inactivité** ou **20 s de modifications continues non prises en charge** ; cette
  dernière durée est un objectif de déclenchement, pas une garantie pendant une écriture en cours ou un onglet
  suspendu.
- **Ctrl+S** et le bouton Enregistrer permettent la sauvegarde explicite. Il n'y a qu'une écriture en cours ; la
  saisie reste possible pendant l'envoi. Les versions et réponses asynchrones ne doivent pas produire de
  confirmation trompeuse.
- Les écritures utilisent des révisions conditionnelles. Une réponse perdue ou un état réseau incertain doit
  être réconcilié avant une nouvelle écriture ; une version distante plus récente n'est jamais écrasée
  automatiquement.
- En cas de conflit, le texte local est préservé, l'autosauvegarde suspendue et les versions locale/serveur sont
  consultables. Le choix de conserver le texte local reste une écriture conditionnelle ; pas de fusion
  silencieuse.
- Les transitions internes et l'historique navigateur tentent de préserver le contenu non confirmé : sauvegarde
  puis décision explicite de rester/quitter si nécessaire. La fermeture ou le rechargement peut afficher un
  avertissement navigateur, sans garantie de sauvegarde tardive.
- Une erreur de lecture de note n'est jamais confondue avec une note absente. Une sauvegarde identique confirmée
  n'incrémente pas inutilement sa révision.
- Aucun brouillon local persistant ni récupération après crash brutal n'est garanti actuellement.

### 3.3 Retour visuel de sauvegarde

La commande de sauvegarde reste visible et interactive au repos.

- **Modifications en attente** : disquette avec marqueur distinct.
- **Écriture en cours** : spinner, y compris pour les sauvegardes automatiques et réessais.
- **Succès** : coche pendant **5 s**, uniquement lorsque le serveur a confirmé **tout le texte courant**. Une
  modification ou nouvelle sauvegarde retire immédiatement la coche. Une réponse confirmant seulement une
  ancienne version ne suffit pas.
- **Échec** : croix et message persistants ; **conflit** : signal distinct et accès à la résolution. Ils ne
  disparaissent pas automatiquement après cinq secondes.
- Un clic sans écriture réelle ne crée ni ne prolonge de confirmation. Une création volontaire de note vide ou
  une normalisation LF effectivement enregistrée peut, elle, être confirmée.
- L'infobulle accessible au survol et au clavier indique l'état, la dernière révision confirmée et l'heure
  serveur. Les états sont aussi annoncés aux technologies d'assistance, sans dépendre uniquement des couleurs.
- Revenir depuis Informations ne redémarre pas artificiellement la durée d'affichage d'une confirmation.

### 3.4 Présentation de la note

- La barre permanente place les insertions Temps (`clock-plus`) et Capture (`camera`) à gauche ; la sauvegarde
  puis le sélecteur Édition/Lecture à l'extrémité droite. La mise en forme contextuelle apparaît seulement après une sélection stabilisée (voir § 3.5).
- Les commandes à icônes conservent des cibles **40 × 40 px**, sur mobile aussi. Les insertions sont espacées de
  4 px, le sélecteur et la sauvegarde de 8 px, les deux groupes d'au moins 12 px. Le sélecteur partage le fond
  commun, les segments arrondis et l'état actif du sélecteur YouTube/Local. Celui de la note mesure **42 px**
  de haut, bordure de 1 px comprise, sans padding extérieur ni ombre sur le segment actif ; le focus reste visible.
- Les infobulles restent dans le viewport et celles des insertions sont ancrées à gauche de leur groupe.
  À 320/375 px, Temps, Capture et le groupe sauvegarde/modes tiennent sur une ligne. Le groupe droit
  reste indivisible et peut passer entier à la ligne si la largeur l'exige.
- Édition et Lecture utilisent la **police système, 16 px CSS, interligne 1,5**, avec une colonne de texte
  centrée de **700 px utiles maximum**, sans inclure les marges/paddings.
- Le code inline et les blocs de code restent monospace dans les deux modes ; les styles du code, citations,
  listes et tableaux ne doivent pas altérer le Markdown source.
- Sur desktop, les commandes restent hors du défilement du contenu et les deux modes partagent la même zone
  défilante, sans second ascenseur CodeMirror. Sur mobile, la page suit son flux naturel et les commandes Note
  restent sticky.
- Les changements d'affichage, de largeur, de thème ou d'onglet ne doivent pas provoquer de remontage de
  l'éditeur, de déplacement intempestif du curseur ni d'enregistrement.

### 3.5 Mise en forme contextuelle du Markdown

En Édition, une sélection continue non vide fait apparaître une barre compacte après stabilisation du geste.
Son ordre est **Texte**, **Gras**, **Italique**, **Code inline**, **Lien**. Texte contient Paragraphe et H1 à H6 ;
le libellé affiche le niveau reconnu, Texte ou Mixte. Une sélection simplement repliée visuellement reste
monoligne. Aucun bouton Markdown permanent, WYSIWYG ou nouveau raccourci de mise en forme n'est introduit.
Le Live Preview ciblé des titres est décrit au § 3.6.

- La barre ne prend pas le focus à son apparition et attend la fin du glisser. Elle reste ouverte pendant
  l'utilisation de ses commandes, de son sous-menu ou du formulaire. Les sélections multiples et la
  composition IME ne l'affichent pas.
- Une transformation réussie ferme la barre et conserve une sélection utile, dans le même sens lorsque
  possible, hors des délimiteurs ajoutés. La transaction et les confirmations de sauvegarde ne la rouvrent
  pas. Un nouveau geste de sélection, même sur le même passage, permet sa réouverture.
- Échap, un clic extérieur, la saisie, la disparition de la sélection ou le masquage de l'éditeur la ferment.
  Un clic extérieur conserve son propre focus. Les changements de mode, d'onglet, de disposition et de thème
  conservent la session CodeMirror. Ouvrir, mesurer et fermer la barre ne modifie ni texte, ni historique, ni
  sauvegarde.
- Chaque transformation réelle forme une étape Undo/Redo distincte des saisies voisines et utilise
  l'autosauvegarde habituelle. Aucun contenu provisoire n'est inséré.

**Commandes inline.** Elles demandent une sélection monoligne de source avec du contenu utile. Les espaces
périphériques sont conservés à l'extérieur de l'enveloppe. Gras et Italique ajoutent ou retirent une
enveloppe exacte reconnue, sélectionnée avec ou sans ses délimiteurs. Les compositions simples utilisent au
besoin les variantes avec underscores pour conserver des délimiteurs fiables. Code inline choisit des
backticks plus longs que ceux du contenu et ajoute le padding Markdown nécessaire ; retirer une enveloppe
restitue son contenu source. Les sélections partielles ambiguës dans une mise en forme sont refusées :
aucun moteur de suppression partielle ou d'uniformisation n'est proposé.

Les commandes refusent les structures protégées : code de bloc, HTML, tableaux GFM, images, définitions ou
références de liens, ainsi que les en-têtes littéraux de callout. Les transformations inline qui touchent
une référence temporelle, son libellé ou sa destination sont refusées. Une commande indisponible reste
consultable au clavier ; son activation explique le refus sans modifier la note. La présence d'une syntaxe
existante ne suffit pas à refuser une composition fiable.

**Titres.** Une sélection partielle cible la ligne entière ; une fin exactement au début de la ligne
suivante exclut cette dernière, dans les deux sens de sélection. Chaque ligne non vide reçoit le niveau
explicitement demandé ; les lignes vides sont conservées. Le niveau existant est remplacé et choisir le
même niveau est sans effet. Paragraphe retire le préfixe ATX reconnu et son éventuelle clôture, en conservant
les autres mises en forme. Les titres Setext restent différés. Une liste, citation, callout, table, bloc
de code, HTML ou définition incompatible provoque un refus global. Retirer un titre est aussi refusé
si ses lignes voisines ou son contenu révéleraient une autre structure Markdown. Un lien temporel complet
reste intact quand seul le préfixe de titre change.

**Création de lien.** La sélection fournit le libellé. Le champ « Adresse du lien », Entrée et le bouton
« Insérer » permettent une confirmation explicite ; Annuler ou Échap ne modifie rien. La destination suit
le filtre des liens en Lecture (notamment HTTP(S), mailto, liens relatifs et ancres) ; les URI temporelles
sont réservées aux actions dédiées. Les caractères spéciaux du libellé sont échappés et les destinations
sont protégées par des chevrons et un encodage ciblé. Aucune requête réseau ni ouverture d'adresse n'est
effectuée. La création de liens imbriqués et la modification générale des liens existants sont exclues.

Le formulaire appartient à la vue et à la sélection qui l'ont ouvert. Une modification du document,
notamment la fin d'une capture asynchrone, invalide sa cible : la confirmation est désactivée et le message
« La note a changé depuis l’ouverture du formulaire. Sélectionnez à nouveau le texte pour insérer le lien. »
est affiché. Une confirmation de sauvegarde sans changement du document conserve la cible. Un remplacement
explicite de version en conflit détruit les surfaces de l'ancienne session.

**Position et accessibilité.** La barre privilégie le dessus et se replie dessous. Elle suit le défilement
extérieur à CodeMirror et les changements de géométrie ; pour une longue sélection, elle utilise
l'extrémité active ou une portion sélectionnée encore visible. Elle est masquée si aucun ancrage n'est
visible. Les surfaces sont bornées au viewport, défilables et adaptées aux fenêtres basses ou étroites,
avec des cibles de 40 px et les couleurs des deux thèmes.

Tab entre dans la barre depuis l'éditeur et permet d'en sortir ; les flèches parcourent les commandes,
Home/End leurs extrémités, Entrée/Espace les activent. Le champ conserve ses touches natives. Échap ferme
d'abord le sous-menu ou le formulaire, puis la barre. Les raccourcis existants de sauvegarde, historique
et navigation temporelle sont conservés.

Sur tactile, le délai de stabilisation est plus long et le viewport visuel tient compte du clavier
virtuel. La sélection, les poignées et le menu natif Copier/Coller restent gérés par le navigateur.
Une recette sur appareils réels **iOS/Safari et Android/Chrome** est nécessaire ; l'émulation de largeur
ne suffit pas à confirmer leur comportement.

### 3.6 Live Preview des titres ATX

Les titres ATX **H1–H6 de premier niveau de structure** ont une typographie de titre directement en Édition.
L'analyse syntaxique reconnaît leur contexte, l'indentation admissible et la clôture ATX optionnelle.
Hors d'une ligne active ou sélectionnée, le préfixe, ses blancs séparateurs et l'éventuelle clôture
sont masqués **sans largeur réservée**, sans englober le saut de ligne. Les `#` du contenu restent visibles.
Les titres vides (`#`, `## `, `### ###`) restent en source.

Un curseur révèle toute sa ligne logique, même repliée sur plusieurs lignes visuelles. Toute plage de
sélection révèle les titres qu'elle rencontre ou englobe ; une fin exactement au début de la ligne
suivante exclut celle-ci, dans les deux sens. Cela s'applique à chaque plage sans rendre la barre
contextuelle disponible aux sélections multiples. Le focus dans la barre ou le formulaire de lien ne
remasque pas les titres sélectionnés.

Le masquage est gelé pendant un glisser souris puis actualisé après sa sélection finale. Pendant la
composition IME, la ligne active reste en source et les décorations conservées suivent les changements
documentaires ; le recalcul attend la fin de la composition. Ces mesures ne remplacent pas une recette
IME et tactile sur appareils réels.

Les clics, sélections, déplacements, suppressions et l'historique restent natifs. La révélation ne
recalcule pas une seconde position depuis les coordonnées du clic. Les déplacements horizontaux et
changements de hauteur, notamment aux seuils de retour à la ligne, sont acceptés ; aucune animation
de taille ou position n'est appliquée. Le défilement reste celui de `.note-content` sur desktop et de la
page sur mobile, sans recentrage ou restauration systématique. Une référence temporelle dans le titre
garde ses propres interactions et peut aussi changer de largeur à la révélation.

Édition et Lecture partagent l'échelle du thème par défaut d'Obsidian 1.14.5, avec le corps de note de
16 px, la police système et les couleurs Sillage :

| Niveau | Taille relative au corps | Graisse | Interligne | Espacement des lettres |
| --- | ---: | ---: | ---: | ---: |
| H1 | 1,618 | 700 | 1,2 | −0,015 em |
| H2 | 1,462 | 680 | 1,2 | −0,011 em |
| H3 | 1,318 | 660 | 1,3 | −0,008 em |
| H4 | 1,188 | 640 | 1,4 | −0,005 em |
| H5 | 1,076 | 620 | 1,5 | −0,002 em |
| H6 | 1 | 600 | 1,5 | 0 |

Les graisses intermédiaires dépendent de la police disponible. Les titres n'ont ni italique ni
soulignement systématique ; les styles inline, liens et code monospace restent conservés.
L'espacement d'Édition est un padding de ligne modéré, identique en source et compact, en conservant
les lignes vides du Markdown. Lecture utilise des marges de bloc distinctes ; l'identité pixel à pixel
entre modes n'est pas recherchée. Ces styles restent limités au contenu des notes.

Le Markdown brut reste l'unique source de vérité : ces effets ne modifient ni texte, sélection,
historique, révision ou autosauvegarde et ne rouvrent pas la barre. **Setext, titres imbriqués dans
listes/citations/callouts et Live Preview général restent différés.** Leur édition
existante est conservée ; les six niveaux du rendu Lecture partagent néanmoins la même échelle.

### 3.7 Live Preview du gras et de l'italique

Édition compacte les paires reconnues par la grammaire Markdown CodeMirror : `**gras**`, `__gras__`,
`*italique*` et `_italique_`, y compris les imbrications comme `***texte***`,
`**gras et *italique***` et `**_texte_**`. Seuls leurs marqueurs syntaxiques sont remplacés, sans largeur
réservée ; les espaces du contenu et les sauts de ligne ne sont jamais masqués. La mise en forme existante
est conservée, en source comme en compact, y compris dans les titres sans changer leur échelle.

La révélation suit **chaque expression**, indépendamment des autres expressions de sa ligne :

- Un curseur révèle l'ouverture et la fermeture lorsqu'il se trouve dans le contenu, dans un marqueur,
  ou exactement à l'une des deux frontières de l'expression. L'entrée et la suppression restent natives.
- Une sélection non vide utilise l'intersection documentaire à borne haute exclusive ; une sélection
  seulement adjacente ne révèle pas l'expression voisine. Les sélections inversées et chaque plage
  supplémentaire utilisent la même règle, sans élargir le périmètre du menu.
- Une expression imbriquée révèle ses enveloppes ancêtres concernées ; ses expressions sœurs restent
  compactes si elles ne rencontrent aucune plage.
- Le focus dans le menu ou son formulaire de lien conserve cette révélation. La sélection et la copie
  restent celles du Markdown source : les marqueurs englobés sont copiés, même lors d'un glisser compact.

Lors d'un double clic et de son glisser par mots, les marqueurs d'emphase effectivement masqués
bornent les groupes sélectionnés : `__Alpha__` compact donne `Alpha`, et `**_Alpha_**` compact donne
également `Alpha`. L'adaptation utilise les catégories de caractères et graphèmes de CodeMirror,
sans retrancher les underscores ordinaires du contenu (`snake_case`). Elle ne change ni les clics
simples, ni les gestes modifiés ou à plages multiples, ni les sélections clavier. Les marqueurs déjà
révélés restent soumis aux groupes source natifs ; `__Alpha__` révélé peut donc être sélectionné
avec ses underscores. Un glisser conserve tous les marqueurs intermédiaires dans sa plage source,
même si les marqueurs masqués aux bornes du mot visé n'en font pas partie.

Le gras et l'italique sont pris en charge dans les paragraphes, titres, listes et corps de citations ou
callouts. Une paire peut traverser plusieurs lignes logiques ; cela n'étend pas les commandes inline du
menu, qui restent monolignes. Les formes échappées, incomplètes ou littérales suivent l'analyse syntaxique :
aucune recherche globale d'astérisques ou d'underscores ne décide du masquage.

Les **libellés de liens et d'images** gardent leurs marqueurs source, y compris les liens temporels
enrichis. Les destinations, titres de liens, code et HTML littéral (blocs, tags et attributs) restent aussi
en source. Le Markdown situé entre des tags HTML inline reste analysé normalement. Une enveloppe
d'emphase extérieure à un lien ou à une image peut être compactée : ses marqueurs restent hors de la
plage du lien ou du widget temporel et ne changent ni sa reconnaissance ni son activation.
Les en-têtes littéraux connus de callout restent source, même invalides ou imbriqués ; une expression
traversant un tel en-tête reste entièrement source.

Titres et emphases partagent un seul gel de présentation pendant le glisser et la composition DOM ou
EditContext, avec mapping des décorations conservées puis reprise après les mutations natives.
Les clics successifs utilisent un même instantané de présentation avant la sélection native, sans
retarder le clic simple. Ces effets n'écrivent pas le document, ne déplacent pas la sélection, ne créent
pas d'étape Undo et ne rouvrent pas le menu. Ils ne corrigent ni la navigation ni le défilement.
La géométrie peut changer à la révélation, sans animation ; les conteneurs existants restent utilisés.

Le barré, le code inline, les liens et images ne reçoivent pas de nouvelle compaction dans cette tranche.
Le Live Preview général, Setext et la compaction des marqueurs des autres structures restent différés.
Une simulation Chromium de composition et une émulation responsive ne remplacent pas la recette IME et
tactile sur appareils réels.

## 4. Temps, références Markdown et citations

### 4.1 Référence temporelle canonique

Une référence temporelle Markdown identifie explicitement la vidéo et sa source et conserve le temps canonique
en **millisecondes** :

```markdown
[12:42](sillage://videos/5/sources/5?start_ms=762345)
```

Le libellé, temporel (`m:ss` ou `h:mm:ss`) ou descriptif, est destiné à l'affichage : **`start_ms` est seul
faisant foi**. L'autorité logique de l'URI est `videos`. `end_ms` est réservé aux futures plages temporelles
et n'est pas une fonction prise en charge aujourd'hui.

### 4.2 Insérer le temps courant

- Le bouton **« Insérer le temps actuel »**, disponible en Édition, relève immédiatement le temps admissible
  du **lecteur actif**, sans lui envoyer de commande de lecture ni déclencher de bascule.
- La référence est insérée au curseur ou après la sélection sans la remplacer, suivie d'un espace ; le focus et
  le curseur reviennent après cet espace. Une insertion constitue une seule étape Undo/Redo et suit
  l'autosauvegarde normale.
- Zéro est valable. Lecture, pause et fin de vidéo permettent l'opération lorsque le temps est disponible ; un
  lecteur **masqué et effectivement en pause** peut aussi fournir ce temps.
- Un départ uniquement préparé (`cued`), un état transitoire, le chargement, un masquage en cours ou une erreur
  ne constituent pas une position annotable. Le refus est explicite, sans commande différée ni fausse insertion.
- En Lecture, le bouton est désactivé. Dans un contexte de code, l'insertion reste textuelle et ne restructure
  pas les blocs voisins.

### 4.3 Navigation depuis les références

- En Lecture, clic simple, Entrée ou Espace sur une référence canonique activent sa navigation. En Édition,
  les références reconnues utilisent les gestes spécifiques décrits plus bas ; une forme invalide reste du
  Markdown ordinaire.
- Les deux modes partagent la pastille compacte : même horloge décorative, couleurs de thème, fond et
  espacements. Le libellé Markdown d'origine est conservé, même descriptif ; les libellés longs se replient
  sans déborder sur mobile. Les horloges des callouts `quote:tr` reprennent cette apparence, avec leur temps
  calculé. L'horloge n'ajoute rien au nom accessible ; le bouton de Lecture conserve son focus et ses messages
  de navigation. Les liens ordinaires gardent leur présentation.
- La navigation est autorisée uniquement pour **la vidéo et la source de travail courantes**. Une autre identité
  ne déclenche ni changement de fiche ni changement de lecteur : un message explique le refus.
- Un lecteur indisponible ou en cours de masquage refuse la commande et invite à réessayer. Aucune navigation
  n'est mise en attente.
- Une navigation acceptée peut révéler un lecteur masqué et amener **la page** à sa hauteur, avec un défilement
  minimal, sans faire défiler les zones Note ou Transcription ni modifier la session d'édition.
- Les liens externes HTTP(S) des notes s'ouvrent dans un nouvel onglet protégé ; les liens internes utilisent la
  navigation SPA, `mailto` son comportement natif. Les destinations dangereuses sont filtrées.

### 4.4 Callouts en Lecture

Deux formes de citation sont reconnues, sans moteur générique de callouts :

```markdown
> [!quote] Aristote
> L'homme est par nature un animal politique.

> [!quote:tr](sillage://videos/6/sources/6?start_ms=40360) Limites du modèle
> decision models. So, when you go to ollama.com.
```

- `quote` : citation ordinaire avec attribution facultative en texte simple.
- `quote:tr` : citation de transcription avec URI temporelle **canonique** et titre facultatif en texte simple ;
  sans titre, afficher « Transcription ». Le timestamp est calculé depuis `start_ms`, non depuis le texte du
  titre.
- La reconnaissance exige un véritable blockquote Markdown, un en-tête connu au début de son premier contenu,
  hors code, sans échappement ni parent blockquote. Une citation placée dans une liste est acceptée si le
  parseur la reconnaît comme blockquote.
- Les titres/attributions sont littéraux (pas de Markdown ou HTML interprété). Le corps garde son rendu
  Markdown/GFM ; les callouts imbriqués ne sont pas enrichis.
- Un en-tête connu mais invalide reste visible et inerte. Un marqueur inconnu suit les règles Markdown
  ordinaires. Les URI d'une autre vidéo/source restent affichées mais leur navigation est refusée par les
  contrôles communs.
- Les anciennes citations Markdown ne sont pas migrées automatiquement. Modifier la citation ne garantit ni
  authenticité ni synchronisation avec la transcription source.

### 4.5 Édition : décorations et références compactes

CodeMirror enrichit la présentation **sans modifier le Markdown persisté** :

- Les véritables blockquotes sont marqués visuellement, y compris en listes ou avec lignes de continuation ; le
  code extérieur n'est pas décoré.
- Les callouts admissibles ont un style distinct (fond, marqueur, attribution/titre). Les formes invalides
  restent des blockquotes ordinaires.
- Les **liens temporels directs monolignes** avec libellé simple et URI canonique sont présentés de façon
  compacte (horloge + libellé). Les syntaxes complexes — liens par définition, libellés enrichis, titres de
  lien, images, code, formes multilignes ou invalides — restent visibles en source.
- Dans les en-têtes admissibles de `quote:tr`, seule l'URI est compactée ; le marqueur, les parenthèses et le
  titre restent visibles. Les en-têtes invalides ne deviennent pas interactifs.
- Sur un lien temporel direct compact, un clic simple sans modificateur révèle la source et sélectionne
  **exactement le libellé**, hors crochets et URI, dans la même vue focalisée. Saisie, collage et composition
  le remplacent par les mécanismes ordinaires de CodeMirror. L'URI n'est ni reconstruite ni normalisée ;
  un nouveau libellé, même temporel, ne change jamais le `start_ms` canonique. Une forme vide, enrichie ou
  invalide reste telle quelle et suit les règles existantes de reconnaissance, sans réparation.
- Pendant un geste souris commencé sur ce widget, sa présentation reste stable jusqu'au relâchement.
  Un glisser conserve sa sélection documentaire étendue ; les appuis successifs d'une même série de clics
  commencée sur le widget gardent la cible du libellé, sans nouveau calcul de coordonnées après révélation.
  Un nouveau clic dans la source place normalement le curseur ; ses doubles clics et glissers restent natifs.
  Les headings et emphases englobants gardent leurs protections communes.
- Un tap bref sur le widget vise le même résultat ; scroll, appui long, poignées et sélections natives ne
  sont pas convertis en demande de remplacement. Les simulations Chromium ne valent pas recette tactile réelle.
- Une horloge `quote:tr` n'a pas de libellé source équivalent : son clic conserve la révélation avec curseur
  dans l'URI, sans sélection d'une portion de celle-ci. Un déplacement clavier à l'intérieur d'une référence
  ou une sélection traversante continue de révéler la source sans sélectionner automatiquement le libellé.
  Copier et éditer gardent leurs comportements natifs. La suppression contre un lien compact révèle
  d'abord la syntaxe sans la détruire au premier appui ; l'édition suivante est normale.
- La révélation et cette sélection ne changent aucun caractère, aucune révision ni étape de modification
  dans Undo/Redo et ne déclenchent pas de sauvegarde. Une modification réelle utilise l'historique et
  l'autosauvegarde habituels. Cette sélection peut ouvrir le menu Markdown comme une sélection ordinaire ;
  les commandes inline restent refusées sur la référence et ses composants, les commandes de bloc admissibles
  conservent le lien. Les protections du formulaire de lien restent inchangées.
- La composition IME suspend les transformations visuelles incompatibles. L'affichage compact n'introduit ni
  arrêt Tab, ni écriture, ni modification de l'historique Undo/Redo.
- **Ctrl+clic** (Cmd+clic sur macOS) active une référence reconnue ; **Ctrl/Cmd+Entrée** l'active lorsqu'un
  curseur unique est strictement à l'intérieur de sa plage. Les frontières, titres et sélections multiples ne
  déclenchent pas d'activation implicite. Après sélection automatique du libellé, une flèche peut la replier
  avant Ctrl/Cmd+Entrée ; les autres raccourcis natifs de l’éditeur restent inchangés. Shift et Alt n’ajoutent
  pas d’activation.
- Un curseur-main signale Ctrl/Cmd sur une référence activable ; au repos, le curseur d'édition reste natif. Le
  focus et la sélection sont préservés lors d'une navigation acceptée ; les refus s'affichent dans un état
  distinct de l'autosauvegarde.

Les détails de reconnaissance et d'implémentation sont décrits dans [Architecture](03-architecture.md). L'objectif d'un Live Preview plus étendu reste exploratoire : voir [Open questions](06-open-questions.md).

## 5. Transcriptions

### 5.1 Acquisition et consultation

- La fiche consulte par défaut **le contenu local déjà acquis** ; elle ne lance ni découverte distante ni POST
  automatique.
- Sans transcription, la commande **Récupérer** affiche une icône de téléchargement ; avec un contenu,
  **Actualiser** affiche une icône d'actualisation. Seule une action explicite lance l'acquisition depuis YouTube.
- Pendant l'acquisition et son éventuelle vérification locale, l'icône devient un spinner. Une réponse POST
  valide confirme le succès (coche verte) ; une erreur serveur confirmée produit une croix rouge. Ces résultats
  durent **5 s**, puis l'icône normale revient selon le contenu réellement disponible. Une nouvelle action
  efface le retour précédent ; les lectures locales, dont celle d'ouverture, ne produisent aucun de ces résultats.
- La commande conserve sa cible de **40 × 40 px** et sa place pendant les retours visuels. Son nom accessible
  conserve l'action proposée ; l'infobulle indique l'activité ou le résultat et, avec un contenu, la date
  d'acquisition. L'activité est exposée par `aria-busy`, le succès est annoncé sans texte visible supplémentaire
  et les erreurs/actions de reprise restent accessibles après les 5 s. Le spinner respecte `prefers-reduced-motion`.
- La sélection actuelle privilégie la piste automatique originale admissible à partir des signaux audio, avec
  des replis déterministes. La langue affichée est celle du contenu (sans suffixe technique `-orig`) et le
  libellé utilisateur indique « Transcription automatique ».
- Le marqueur `-orig` ne garantit pas absolument qu'une piste correspond à l'audio original, notamment en
  présence d'un doublage.
- L'acquisition peut conserver l'ancien contenu pendant une actualisation ou après un échec. Absence, erreur de
  lecture locale, erreur distante, sélection ambiguë, délai dépassé et opération en cours ne sont pas présentés
  comme un seul état.
- Après une réponse POST incertaine, une nouvelle consultation locale peut retrouver le contenu enregistré,
  **sans confirmer l'actualisation** : ni coche ni croix, même si cette lecture réussit, et aucun POST automatique.
  Les réponses tardives d'une ancienne fiche sont ignorées, y compris pour les retours visuels.
- L'interface actuelle n'offre pas de sélection manuelle de pistes, de sous-titres manuels, de traduction ou de
  STT.

### 5.2 Regroupement et navigation temporelle

- Les fragments horodatés sont regroupés pour l'affichage en **intervalles fixes de 10 s ancrés à zéro**, sans
  découper un fragment. Seuls les fragments consécutifs du même intervalle sont fusionnés, en préservant l'ordre
  source même si les timestamps ne sont pas monotones.
- Les textes sont concaténés **sans séparateur artificiel** ; la présentation peut rendre les espaces plus
  fluides sans altérer les données source. Ne montrer ni bloc vide ni intervalle sans texte ; les blancs isolés
  peuvent séparer le texte voisin.
- Le temps du bloc est le `start_ms` de son premier fragment réel, pas une borne arrondie à l'intervalle. Des
  blocs peuvent couper une phrase ou un mot : aucun regroupement linguistique n'est revendiqué.
- Le timestamp est activable au clavier et navigue vers la position réelle du bloc, sans insertion de note. Il
  utilise les mêmes règles de disponibilité et de navigation que les références Markdown.
- La synchronisation continue du défilement avec la lecture n'est pas implémentée.

### 5.3 Recherche locale

- La recherche opère **sur la transcription déjà chargée**, sans requête réseau ni modification du lecteur. Elle
  est insensible à la casse, sans recherche par regex ni suppression des accents.
- Elle cherche dans le texte continu formé par les fragments, y compris à travers les frontières de
  présentation. Les blancs du texte sont conservés ; une espace recherchée peut correspondre à une suite de
  blancs ou un saut de ligne.
- Le champ est replié au départ. Son ouverture le focalise ; Échap ou un second clic sur la loupe le replie sans
  effacer la requête, les surlignages et le résultat actif. Changer de vidéo/source réinitialise la recherche.
- « Rechercher » dans la barre contextuelle ouvre ce même champ avec le texte de la sélection, tel que copié
  (blancs de bord retirés, suites de blancs ramenées à une espace), puis le focalise. La recherche repart de
  la première occurrence, même pour une requête identique ; moteur, surlignages, compteur et navigation restent
  ceux de la recherche locale, sans réseau ni commande au lecteur.
- Toutes les correspondances non chevauchantes sont surlignées, avec un résultat actif, un compteur et des
  actions précédent/suivant circulaires. Entrée dans le champ avance sans commander le lecteur et sans valider
  une composition IME.
- Une actualisation réussie recalcule les occurrences pour la requête conservée ; pendant l'acquisition ou après
  un échec, l'ancien contenu reste consultable.
- Les résultats font défiler le texte pertinent : à desktop le panneau Transcription, sur mobile le défilement
  naturel de la page. La recherche ne persiste pas entre les fiches.
- La loupe signale l'existence d'une recherche repliée. Le bouton Citation reste la dernière action de la barre
  avant le texte quand la recherche est repliée.

### 5.4 Sélection et citation dans la note

- La sélection de transcription est **native** (souris, clavier, tactile), y compris sur plusieurs fragments,
  blocs ou surlignages. Les timestamps ne sont ni copiés ni inclus dans le texte sélectionné.
- La copie d'un passage valide produit le texte continu source dans l'ordre, avec les suites de blancs ramenées
  à un espace et les blancs de bord retirés. Les copies hors sélection valide gardent le comportement natif du
  navigateur.
- Le bouton **« Citer dans la note »** est disponible pour un passage valide, non vide et contenu dans la
  transcription. Une sélection multiple ou débordante est refusée.
- Après stabilisation d'une sélection valide, une petite barre flottante propose les icônes
  **« Citer dans la note »** (Lucide Quote, identique à la commande permanente) et
  **« Rechercher dans la transcription »** (loupe), avec noms accessibles et infobulles explicites, près du
  texte encore visible. Elle ne prend pas le focus à son apparition et reste masquée pendant le glisser ou
  un contact tactile en cours. « Citer » utilise exactement la même insertion
  et les mêmes validations que le bouton d'en-tête, qui reste disponible.
- Tab depuis la transcription donne accès à la barre ; les flèches gauche/droite parcourent ses deux boutons.
  Échap ferme la barre. Si sa fermeture retire un bouton focalisé, notamment lorsque le passage sort de
  l'écran, le focus revient au texte sans déplacer le défilement. Un clic ou un focus extérieur ferme sans
  action ; une sortie de fenêtre ou un focus extérieur n'est pas repris. La copie native et le sens de la
  sélection sont conservés pendant l'interaction avec la barre.
- Le menu suit le défilement et les changements de taille ; il se ferme si la sélection n'est plus visible.
  Une nouvelle sélection, une recherche modifiant le rendu ou le remplacement du contenu invalident l'ancienne
  cible. Une action vérifie encore sa plage native avant d'utiliser l'extrait.
- Le début de la citation vient du **premier fragment contenant du texte effectivement retenu**, même si les
  timestamps ne sont pas monotones : pas d'interpolation ni d'utilisation systématique de la borne du bloc
  visuel.
- La citation insérée utilise le format `quote:tr`, avec échappement du texte source afin qu'il demeure littéral
  dans le Markdown.
- En Édition, une note vide accepte l'insertion au début. Une note non vide, **même composée uniquement de
  blancs**, exige un emplacement choisi explicitement ; une prise de focus automatique ne suffit pas. Le contenu
  sélectionné dans la note n'est pas remplacé : l'insertion suit la borne supérieure de la sélection.
- En Lecture ou sans emplacement explicitement choisi, afficher un refus ; ne pas changer d'onglet, deviner une
  position, modifier le lecteur ou programmer une insertion différée. La sélection de transcription consommée
  doit être refaite pour réessayer. Un refus depuis la barre contextuelle rend le focus à la transcription
  si l'action avait été activée au clavier.
- Une citation acceptée utilise la session CodeMirror existante, les séparateurs LF nécessaires et **une seule
  étape Undo/Redo**. Le curseur est replacé après le bloc et sa ligne vide, l'autosauvegarde suit son cycle
  normal.
- Changer de vidéo/source, remplacer réellement la transcription ou rendre la sélection obsolète invalide la
  citation préparée. Les interactions de focus habituelles ne doivent pas réutiliser un extrait périmé.
- Dans une liste, un tableau ou un bloc de code, l'insertion reste textuelle : le rendu dépend de ce contexte ;
  aucune restructuration automatique du document n'est tentée.

## 6. Lecture vidéo, conservation du média et captures

### 6.1 Deux lecteurs, une source de travail

- La première source YouTube exploitable dans l'ordre REST est actuellement la **source de travail commune** au
  lecteur, à la transcription et aux références. Ce choix n'introduit pas de source principale persistée.
- Les modes **YouTube** (iframe et IFrame Player API) et **Local** (élément HTML5) partagent un panneau et un
  contrôle segmenté. Ils concernent la même `VideoSource` ; conserver le fichier crée un `MediaFile`, pas une
  `Video` ou `VideoSource` supplémentaire.
- YouTube permet la consultation et les annotations sans téléchargement. Local facilite les navigations répétées
  et le travail approfondi ; aucune action de note ou capture n'est réservée à Local.
- À l'ouverture, attendre la consultation initiale du média : **Local si le fichier de cette source est
  disponible, sinon YouTube**, y compris en cas d'erreur de consultation. Aucun lecteur YouTube transitoire
  pendant cette attente. Note et transcription restent utilisables.
- Le mode initial est choisi **une fois par session de fiche**. Les changements ultérieurs de disponibilité et
  la fin d'un téléchargement ne sélectionnent pas automatiquement un autre lecteur. Aucune préférence de lecteur
  persistée.
- Cliquer Local sans fichier disponible ouvre la **modale de téléchargement**, sans changer le mode sélectionné.
  Après suppression confirmée depuis Local, ce mode reste affiché avec son état vide et permet une nouvelle
  acquisition.
- Le contrôle indique clairement le mode actif, y compris au clavier ; l'état du téléchargement est communiqué
  séparément du mode effectivement sélectionné.

### 6.2 Masquage, bascule et transfert de position

- Masquer un lecteur le met en pause ; le réafficher ne relance pas la vidéo. Pour YouTube, la garantie d'arrêt
  prime sur une commande concurrente ; en cas d'impossibilité de confirmer la pause, l'ancienne instance peut
  être détruite.
- La bascule récupère, si possible, une position valide de l'ancien lecteur, **arrête et décharge l'ancienne
  instance**, puis prépare la nouvelle **sans autoplay**. La note, la transcription, les sélections et
  l'autosauvegarde ne sont pas démontées.
- Une position seulement **préparée** après bascule peut être transférée de nouveau pendant la même session tant
  qu'elle reste valable. Elle n'est pas un temps de visionnage confirmé et ne suffit jamais pour
  « Insérer le temps actuel » ou « Capturer une image de la vidéo ».
- Une référence temporelle acceptée depuis YouTube `cued` remplace le départ préparé et constitue une vraie
  navigation. Une commande refusée n'est pas différée.
- L'absence normale de temps avant première lecture n'est pas une erreur. En revanche, une position
  **incertaine** (erreur, buffering, seek local en cours, masquage en cours) n'autorise pas à reprendre une
  ancienne cible : la bascule se fait sans transfert et peut le signaler.
- La position préparée est limitée à la session de fiche/source. Aucun suivi de progression ni reprise persistée
  n'est implémenté. Local borne un transfert initial à la durée du fichier ; une navigation normale hors durée
  est refusée.

### 6.3 Règles de navigation YouTube et Local

- Une référence de note ou un timestamp de transcription exprime une **navigation explicite**. Pour YouTube, la
  commande utilise `seekTo` : en pause, la pause reste applicable ; en lecture, elle continue ; depuis un état
  non démarré, `cued` ou terminé, la commande demande la lecture au passage.
- **L'ouverture d'une fiche et les bascules** ne déclenchent jamais la lecture. La préparation par
  `cueVideoById` ne constitue pas une navigation annotable.
- Si le navigateur signale un blocage du démarrage, afficher un message non fatal invitant à cliquer Lecture ;
  supprimer ce message à la reprise. L'absence de signal de blocage ne doit pas donner lieu à une détection par
  délai ou à une nouvelle commande automatique.
- Pour « Insérer le temps actuel » et « Capturer une image de la vidéo » avec YouTube, utiliser le temps
  **réellement annoncé par l'API dans un état admissible**, jamais la cible d'un ancien `seekTo`. Une valeur
  momentanément ancienne reste possible : ne pas attendre une égalité exacte, une tolérance arbitraire ou un
  événement de confirmation durable.
- Local suit les contrôles du navigateur. L'affectation de `currentTime` ne lance pas la lecture ; pendant
  `seeking`, avant disponibilité des données ou après erreur, le temps ne doit pas être présenté comme confirmé.
- Les commandes refusées restent sans effet différé. Après une erreur de lecture locale, rester en mode Local
  avec un message prudent et des actions de réessai ou retour manuel à YouTube : **pas de conversion, effacement
  ni bascule automatique**.

### 6.4 Panneau et présentation du lecteur

- Le panneau Lecteur reste monté pendant les bascules ; seules les surfaces de lecture propres aux modes
  changent. La barre permanente comprend le sélecteur YouTube/Local, une commande de téléchargement indépendante
  lorsque nécessaire (voir §6.5), **Informations** et l'œil de masquage.
- Le sélecteur segmenté contient uniquement les libellés **YouTube** et **Local**, sans icône ni place réservée
  à un indicateur. Ses boutons natifs exposent le choix actif par `aria-pressed` ; fond commun légèrement
  contrasté, fond distinct pour le segment actif, segment inactif neutre et coins arrondis. Les cibles mesurent
  **40 px** de haut. Les transitions ne déplacent pas le sélecteur ; elles respectent `prefers-reduced-motion`,
  comme le spinner de téléchargement.
- Informations ouvre un popover non modal contextualisé : source/titre/compte/durée/description pour YouTube,
  détails techniques et opérations de conservation pour Local. Il ne remplace pas l'onglet Informations complet
  de la fiche.
- Le popover reçoit le focus et se ferme par Échap, bouton de fermeture, clic extérieur ou changement de mode.
  Échap restitue le focus à Informations ; un clic extérieur conserve la destination du clic.
- Les icônes ont des noms accessibles, des cibles utilisables et des indicateurs de focus/infobulles au clavier
  comme au pointeur. L'état d'erreur important reste lisible après fermeture d'un popover ou disparition d'une
  icône transitoire.
- Les surfaces YouTube et Local prennent la **largeur intérieure du panneau**, avec un contenant de ratio
  **16:9**. Une **hauteur minimale commune de 200 px sur petit mobile** prime sur le ratio quand la largeur est
  trop faible (environ moins de 356 px).
- Local utilise `object-fit: contain`, fond noir, **sans recadrage ni déformation**. L'iframe YouTube conserve
  son rendu interne. Les coins sont arrondis ; le conteneur ne doit pas tronquer les popovers.
- Les messages informatifs non bloquants apparaissent après la surface ; les erreurs avec action restent près du
  lecteur. Aucun système de notifications globales n'est implémenté.

### 6.5 Télécharger et supprimer un fichier local

- Le téléchargement est **volontaire** et vise la source de travail. Il n'interrompt pas YouTube et ne modifie
  pas le lecteur actif, les notes ou la transcription.
- Les états doivent distinguer **non téléchargé**, **téléchargement en cours**, **disponible**, **échec** et
  **consultation incertaine**. Une consultation en échec ne signifie pas que le serveur a confirmé l'absence du
  fichier.
- La modale commune présente le contexte actuel. Annuler/Échap n'envoie aucun POST ; confirmer lance une seule
  acquisition. Fermer une modale pendant un téléchargement n'arrête pas le traitement serveur. Les réessais sont
  explicites.
- Le suivi reprend à l'ouverture, au retour sur la page et pendant une acquisition. Une réponse POST perdue
  conduit à une consultation GET, **sans second POST automatique**. La fin de traitement ne change pas le mode
  sélectionné.
- La commande indépendante se trouve **immédiatement à droite du sélecteur** et ouvre la même modale que Local
  sans fichier. Elle affiche une icône de téléchargement en l'absence de fichier, remplacée par un spinner
  pendant la demande ou l'activité serveur ; l'état reste consultable. Après succès confirmé, une coche verte
  reste **5 s**, puis la commande disparaît. Après échec confirmé d'une activité suivie, une croix rouge reste
  **5 s**, puis l'icône de téléchargement revient. Un fichier déjà disponible n'affiche aucune commande.
- Une consultation initiale disponible/échouée ne crée pas de résultat transitoire ; une activité serveur
  retrouvée rétablit le spinner. Après POST perdu, une relecture confirmant la disponibilité peut confirmer le
  succès ; un ancien échec sans activité observée ne prouve pas celui de la demande. Erreurs de consultation,
  de suppression ou de décodage ne produisent pas de croix. Les symboles complètent les annonces accessibles
  et ne remplacent pas les erreurs persistantes ni leurs actions de reprise.
- Si la commande disparaît alors qu'elle détient le focus, celui-ci revient à **Local**, sans le voler ailleurs.
  Fermer la modale rend le focus à son déclencheur, ou à Local si ce déclencheur a disparu.
- Un média disponible affiche ses informations : conteneur, taille, durée, dimensions, cadence, codecs et langue
  audio déclarée lorsque connues. Les inconnues restent explicites ; ces informations sont relatives au fichier,
  pas à une nouvelle source.
- Supprimer exige une confirmation portant sur le **fichier exact**. Depuis Local, arrêter et décharger avant
  DELETE ; depuis YouTube, ne pas arrêter le lecteur distant. Une suppression refusée par une réservation
  concurrente ne déclenche pas de réessai automatique.
- Après suppression réussie, conserver `Video`, note, transcription et captures. Si Local était sélectionné, il
  reste vide dans la session ; au prochain chargement de la fiche, le choix initial est recalculé.
- Une référence à un fichier disparu peut être supprimée explicitement. Aucune maintenance ou élimination
  silencieuse des médias orphelins au démarrage.

### 6.6 Captures vidéo

- **« Capturer une image de la vidéo »** est disponible en Édition et lit le temps admissible du lecteur actif.
  Une capture concerne **la source courante**, jamais une autre source de la même vidéo substituée silencieusement.
- L'extraction utilise d'abord le média complet local exploitable, puis le flux distant YouTube selon les règles
  de repli applicables. Elle n'entraîne pas de téléchargement permanent du média complet.
- Le résultat est un **PNG** sans réduction volontaire de résolution. La capture vise la première image
  décodable à partir du temps demandé : aucune identité parfaite avec l'image affichée par YouTube n'est
  garantie.
- Dès le clic, un marqueur CodeMirror d'attente apparaît **sans changer le Markdown**. Il suit les éditions et
  Undo/Redo ordinaires ; détruire son ancrage ou remplacer la session invalide l'insertion, sans que la réponse
  tardive puisse la ressusciter.
- Après acceptation persistée, insérer une seule référence Markdown à l'emplacement retenu :

  ```markdown
  ![Capture à 12:42](/api/v1/assets/123/content)
  ```

  L'insertion est une seule étape Undo/Redo et suit l'autosauvegarde. Si le curseur est resté au marqueur, le
  placer après la référence ; sinon préserver le focus et la sélection courants. Undo ne supprime pas l'`Asset`,
  Redo ne relance pas l'extraction.
- Pendant l'acceptation et la génération, Capture est désactivée et expose `aria-busy`. Le spinner remplace
  la caméra sans changer la cible ; le nom accessible reste « Capturer une image de la vidéo », l'infobulle
  indique « Capture en cours… » et un statut accessible distinct annonce cette activité. Aucun succès
  transitoire n'est ajouté. Une erreur de consultation ne signifie pas la fin de génération.
- Le passage en Lecture est bloqué uniquement pendant l'acceptation initiale. Une génération acceptée continue
  côté serveur après navigation ; quitter avant acceptation abandonne l'insertion locale sans prétendre annuler
  le serveur.
- En Lecture, l'image affiche son état de préparation, de disponibilité ou d'échec ; une erreur de consultation
  est distinguée de l'échec de génération. La note Markdown reste intacte si la génération échoue. L'image ne
  commande pas le lecteur.
- Une seule capture à la fois est traitée par instance serveur. Le catalogue Images donne accès aux captures de la vidéo, sans
  compteur global d'activité. Retirer la référence Markdown **ne supprime pas** l'`Asset` ou son PNG.

### 6.7 Images de la vidéo

Le bouton à icône **Images**, à droite de Note/Informations et hors du `tablist`, ouvre ou ferme les captures
sans changer d'onglet, en Édition comme en Lecture. Son état actif, son nom accessible et son infobulle
identifient le toggle. Une préparation en cours peut être annulée ; aucun retour tardif ne rouvre le panneau.
Le sélecteur est chargé à la demande ; son attente est annoncée et annulable. Les messages de préparation
et d'erreur restent accessibles depuis les deux onglets. Il présente la vidéo courante,
toutes sources confondues, même sans référence dans la note. Le catalogue ne crée ni note ni asset,
ne commande aucun seek et ne répare pas un fichier par une nouvelle génération.

À partir de 1 100 px, un drawer **non modal** recouvre le cadre Lecteur/Transcription sans redimensionner
la note. Les composants restent montés ; les commandes recouvertes sont inertes. La note reste interactive,
un clic dans celle-ci ne ferme pas Images. Sous ce seuil, le même sélecteur devient une modale plein écran.
Un changement responsive conserve le catalogue, son défilement et les sessions. Pendant « Quitter la note ? »,
les changements de présentation native sont différés : la protection reste prioritaire sur Images et la
lightbox, puis la présentation adaptée à la largeur courante est rétablie. Le panneau possède un en-tête,
une croix de fermeture nommée accessible à droite et un défilement interne. Son ouverture n'est pas conservée entre vidéos.

Ouvrir Images met YouTube en pause s'il joue ou bufferise, sans utiliser `stop()` ni décharger son iframe.
Un échec de confirmation de pause refuse l'ouverture et laisse le lecteur accessible avec un message explicite ;
une reprise tardive impossible à remettre en pause ferme Images avec une erreur, sans destruction du lecteur.
L'initialisation reste sans autoplay.
Local continue à jouer. Fermer ne révèle pas une surface volontairement masquée et ne reprend aucune lecture.
Ces règles ne modifient ni Masquer, ni les bascules de lecteur, ni les autres dialogues.
Une référence temporelle admissible depuis la note ferme Images et révèle le lecteur ; un refus explicite
laisse le panneau ouvert, sans navigation différée.

La grille présente 12 captures au plus par page, par **timestamp croissant puis ID croissant**, sans prétendre
synchroniser les sources. Les cadres 16:9 affichent les images entières. Sous chaque miniature, une petite
barre place le temps à gauche et l'insertion à droite. La provenance n'est affichée que si la vidéo possède
plusieurs sources, même si la page de captures n'en montre qu'une. Ces badges distinguent les `VideoSource`
par leur identité ; ils ne désignent pas le support des pixels et ne servent pas à naviguer.

Un indicateur discret `×1`, `×2`, etc., absent à zéro, compte les images visant cet Asset dans le Markdown
courant de la session, sauvegardé ou non. Il suit collages, suppressions, Undo/Redo, versions remplacées,
Lecture et Informations. Images directes et références résolues sont comptées selon le rendu, y compris dans
citations, listes et liens. Texte brut, liens ordinaires, code, syntaxes échappées, définitions inutilisées
et images littérales des en-têtes de callout ne sont pas des utilisations rendues. Aucun enregistrement
ni chargement d'image supplémentaire ne découle du comptage. Un léger retard est admis : les rafales de frappe
sont regroupées et la frappe continue conserve une actualisation périodique. Les anciens résultats ne sont
pas réappliqués après une modification ou un remplacement explicite de version.

Le clic sur l'image ouvre une lightbox modale : image flottante entière sur fond assombri, sans cadre
visible. Une croix en haut à droite, Échap ou un clic sur le fond la ferment ; image, navigation et réessai
ne la ferment pas. Chargement et erreur restent lisibles. Précédent/Suivant et les flèches gauche/droite
parcourent uniquement les captures `available` de la **page courante**, dans son ordre, sans boucle ni
franchissement de page. Les bornes et cette limite sont explicites. `pending` et `failed` sont ignorés ;
un PNG `available` illisible reste une étape avec erreur et réessai, sans changer son état métier.
La légende privilégie le timestamp et, si la vidéo a plusieurs sources, sa provenance ; une position
compacte (`3 / 10`) accompagne l'image. La limite de page est disponible dans la description accessible
et l'aide de position, sans phrase permanente dans la légende. Aucun préchargement du reste du catalogue
n'est ajouté.

La fermeture rend le focus à la miniature d'origine, même après navigation dans la lightbox, sans perdre
le défilement. Si sa commande a disparu après une erreur d'affichage, sa carte reste la cible de retour. Si une actualisation
retire l'image consultée de la page, la lightbox se ferme avec une explication ; l'en-tête de la galerie
sert de retour lorsque la carte d'origine n'est plus présente.
Échap traite d'abord la surface modale la plus interne ; le drawer ne piège pas le focus et sa fermeture
ne reprend pas celui d'une note active. Les protections de départ restent au-dessus de la consultation.

L'acceptation d'une nouvelle capture depuis la fiche actualise uniquement la page de catalogue ouverte,
sans navigation automatique vers une autre page et en conservant le tri chronologique.
`pending` affiche l'attente et actualise temporairement la page ; `failed` explique l'échec sans régénération.
Un PNG `available` illisible propose de réessayer l'affichage, sans changer son état de génération. Une erreur
de catalogue possède son propre réessai. Les réponses obsolètes sont annulées. Les PNG pleins formats sont
chargés paresseusement ; pagination et démontage de la page précédente bornent le volume affiché.
La réduction CSS ne réduit pas les octets transférés. Aucune miniature dérivée ni politique de rétention
supplémentaire n'est introduite.

En Lecture, la consultation reste disponible mais les boutons d'insertion sont désactivés ; une aide indique
qu'il faut passer en Édition, sans bascule automatique. Le bouton d'insertion à icône SVG **plus**, dans la
barre sous l'image, reste toujours visible avec une cible de 40 px et un focus visible. Il est indépendant
de l'agrandissement et des réessais. L'insertion attend un premier affichage réussi. Une indisponibilité
constatée dans la miniature ou la visionneuse la bloque sur les deux surfaces ; un réessai reste bloquant
jusqu'à son succès. Cela ne constitue pas une validation réseau systématique ni une garantie contre une
disparition ultérieure du fichier. L'état métier de génération reste inchangé.

Une note strictement vide accepte un ajout au début. Toute note non vide, y compris des blancs, exige un
emplacement choisi explicitement par un geste de rédaction ou de déplacement ; le focus automatique ne
suffit pas. Chaque clic lit la sélection **actuelle** de CodeMirror et ajoute après sa borne supérieure,
sans remplacer le texte sélectionné. La référence canonique vers l'Asset existant et son espace final
suivent les conventions des captures. Le texte environnant reste intact, en LF.

Le point logique avance après l'ajout pour les insertions successives et suit tout nouveau placement ou
édition de la note. Sur desktop, le drawer reste ouvert et la commande conserve le focus ; une décoration
non persistée montre la sélection et le point d'ajout, même lorsque l'éditeur n'a plus le focus. L'insertion
est révélée dans le défilement de note. Une insertion acceptée depuis Informations révèle Note sans déplacer le focus de la galerie. Sur mobile, une réussite ferme Images et focalise le point d'ajout ;
un refus le laisse ouvert. Fermer sans insertion conserve le contexte de note.

Chaque ajout est une unique étape Undo/Redo, sans extraction ni sauvegarde indépendante. Le cycle normal de
NoteSession gère révisions, erreurs et protection de départ. En conflit, les ajouts locaux restent possibles
et l'autosauvegarde reste suspendue. Un remplacement explicite de session invalide l'ancien emplacement ;
aucune insertion tardive ni aucun ancrage asynchrone de capture ne sert à la réinsertion.

## 7. Recherche, IA et pistes non livrées

- **Extensions de recherche** : passages de transcription, navigation temporelle, filtres avancés et recherche sémantique restent distincts de la V1 globale décrite en section 1.4 ; voir [Roadmap](05-roadmap.md).
- **MCP** : interface future pour exposer les cas d'usage métier à un agent, sans accès direct aux primitives de
  persistance ; outils et permissions restent à décider.
- **IA intégrée** : facultative, postérieure aux primitives métier ; candidates : résumés, tags suggérés,
  chapitrage, questions/réponses et extraction d'informations. Aucun provider n'est choisi.
- **Autres pistes** : annotations structurées, plages temporelles, sources supplémentaires, STT, sélection de
  pistes, import d’images, clips durables, redimensionnement des panneaux, reprise de lecture et
  export. Elles ne doivent pas être traitées comme des fonctionnalités déjà implémentées.

Pour les objectifs des étapes futures, voir [05-roadmap.md](05-roadmap.md). Pour leurs arbitrages encore ouverts, voir [06-open-questions.md](06-open-questions.md). Ne pas dupliquer ici leurs spécifications tant qu'elles ne sont pas implémentées.

## 8. Principes UX et maintenance documentaire

1. **Continuité du travail** : le lecteur, la transcription, les tags, les popovers et le thème ne doivent pas
   interrompre une session de note.
2. **Annotation rapide** : l'insertion temporelle ou d'une citation ne doit pas imposer de parcours complexe ni
   de manipulation implicite du lecteur.
3. **Connaissances distinctes des médias** : télécharger, supprimer ou changer de mode n'altère pas `Video`, la
   note, les transcriptions et les captures conservées.
4. **Identités temporelles explicites** : vidéo, source et millisecondes font autorité ; ne pas inférer une
   position de lecture d'un libellé ou d'une commande simplement préparée.
5. **Erreurs honnêtes** : absence, indisponibilité, incertitude et échec ne sont pas interchangeables. Une
   réponse différée ou refusée n'est jamais présentée comme un succès.
6. **Accessibilité et responsive** : contrôle clavier, focus visible, messages accessibles et fonctionnement à
   faible largeur sont des exigences transversales.
7. **Sans IA et sans téléchargement obligatoire** : le parcours central doit rester entièrement utilisable avec
   une vidéo YouTube et des notes Markdown.
8. **Maintenance** : consolider les règles dans les sections fonctionnelles ; ne pas ajouter de compte rendu de développement, validation de jalon ou décision supersédée à la fin de ce document. Les PR/Git conservent le détail historique ; [l'historique synthétique](history/sillage-decisions-octobre-2026.md) explique certains arbitrages passés.
