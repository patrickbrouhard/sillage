# Recette manuelle — lecteurs vidéo et workspace

## Objet

Cette recette vérifie les comportements des lecteurs **YouTube réel** et **Local** que les tests automatisés ne couvrent pas entièrement, ainsi que les interactions critiques avec le workspace.

- **Parcours essentiel** : à rejouer après une modification du lecteur, de sa barre de commandes ou de la composition du workspace.
- **Scénarios ciblés** : à sélectionner selon les composants ou contrats modifiés. Il n'est pas nécessaire de tous les exécuter après chaque changement mineur.
- Un test Playwright avec un lecteur YouTube simulé ne constitue pas une validation du comportement de l'iframe réelle dans Brave.
- Ce document est une **recette à exécuter**, pas une déclaration de tests réussis. Consigner les résultats dans la PR ou le ticket concerné.

## Préparation

- Utiliser **Brave sous Windows**, une vidéo YouTube accessible et un fichier effectivement téléchargé par Sillage via yt-dlp. Prévoir également une vidéo sans fichier local.
- Prévoir si possible un média long pour les seeks, et des vidéos **16:9, 4:3 et portrait** pour l'affichage. Les contrôles propres aux codecs ne valent que pour les formats réellement essayés.
- Vérifier au minimum un viewport desktop (par exemple 1920 × 1080) et un mobile étroit (375 ou 320 px). Adapter les autres tailles et le zoom au changement testé.
- Pour les scénarios de téléchargement, suppression, réseau ou concurrence, utiliser des données de test dont la perte est acceptable.

## 1. Parcours essentiel

- [ ] **Ouverture et sélection initiale** : avec fichier disponible, Local est sélectionné ; sans fichier ou si la consultation échoue, YouTube est sélectionné. Pendant la consultation, aucun lecteur YouTube transitoire n'est monté et aucun mode n'est faussement déclaré actif. Note et transcription restent utilisables.
- [ ] **Sélection sans média** : depuis YouTube, cliquer Local sans fichier ouvre la modale de téléchargement. Annuler ou fermer ne lance rien et ne modifie ni le mode, ni la lecture, ni la position.
- [ ] **Bascule** : pendant la lecture, passer de YouTube à Local puis revenir. L'ancienne instance s'arrête, la position admissible est approximativement transférée et la nouvelle instance ne démarre pas automatiquement. Une première ouverture ne lance jamais la vidéo.
- [ ] **Lecture réelle** : en Local et dans l'iframe YouTube, vérifier lecture/pause, audio, seek vers le début, le milieu et la fin, commandes natives et plein écran. Observer les erreurs de console/réseau si un comportement paraît anormal.
- [ ] **Navigation temporelle** : activer des timestamps de transcription et des références depuis la note en Lecture et en Édition (Ctrl-clic et Mod-Entrée). Vérifier la navigation du lecteur actif, le refus d'une identité vidéo/source non admissible et l'absence de commande différée après un refus.
- [ ] **Annotations** : utiliser `+ Temps` et `+ Capture` sur une position admissible, y compris lecteur masqué en pause. Vérifier qu'une position non confirmée (chargement, seek local, YouTube préparé, erreur) est refusée sans écriture trompeuse.
- [ ] **État de la note** : pendant les bascules, les masquages et les changements d'onglet Note/Informations, conserver sélection, focus utile, historique Undo/Redo, défilement et autosauvegarde. Une simple bascule ne déclenche pas de sauvegarde.
- [ ] **Masquage** : masquer un lecteur en cours de lecture le met en pause ; le réafficher ne relance pas la lecture. Sur desktop, l'espace libéré profite à la transcription.

## 2. Téléchargement et suppression — scénarios ciblés

- [ ] **Confirmation** : annulation/Échap sans POST ; double confirmation ou clics rapprochés sans téléchargement concurrent. Pendant une acquisition, l'état reste consultable et la fin du téléchargement ne change pas le lecteur sélectionné.
- [ ] **Retour d'état** : spinner pendant une activité suivie, coche/croix temporaire après son résultat confirmé, puis retour au repos. Après rechargement, un ancien résultat n'est pas réaffiché ; une activité encore présente sur le serveur est retrouvée. Une erreur de consultation ou de décodage n'est pas présentée comme un échec de téléchargement.
- [ ] **Réseau incertain** : en cas de coupure ou de réponse perdue, ne pas annoncer un succès non confirmé et ne pas lancer automatiquement un second POST. Les erreurs pertinentes restent consultables.
- [ ] **Suppression en Local** : annuler ne change rien. Confirmer arrête et décharge la vidéo avant la requête ; après succès, Local reste sélectionné et vide, la modale permet de télécharger à nouveau et notes, transcriptions et PNG restent conservés. Après rafraîchissement, le choix initial redevient YouTube en l'absence de fichier.
- [ ] **Suppression depuis YouTube** : ne pas interrompre l'iframe. Si le fichier enregistré est indisponible, la gestion de cet état reste accessible.
- [ ] **Concurrence, si concernée** : depuis deux onglets, tester un transfert actif, un refus de suppression et le devenir d'une requête Range lorsque le média est supprimé entre deux transferts. Aucun effacement forcé ni réessai implicite.
- [ ] **Fichier non décodable ou lecture interrompue** : rester en mode Local, afficher une erreur et permettre un réessai ou un retour manuel vers YouTube, sans conversion, suppression ou reclassement implicite du téléchargement.

## 3. Position, navigation YouTube et transferts — scénarios ciblés

- [ ] **Départ préparé** : Local vers 0:40 → YouTube préparé → Local sans lecture : revenir approximativement à 0:40, en pause. Un YouTube `cued` ne fournit pas de temps annotable.
- [ ] **Nouvelle navigation** : depuis YouTube préparé, activer une référence vers 1:20 ; le départ précédent est abandonné. Une navigation acceptée depuis non démarré, `cued` ou terminé demande la lecture ; depuis une pause, elle conserve la pause.
- [ ] **Temps confirmé** : après une lecture effective sur YouTube, transférer le temps annoncé par le lecteur et non l'ancien départ préparé. Après un seek, `+ Temps` et `+ Capture` lisent la valeur annoncée dans un état admissible, même légèrement différente de la cible. Ne pas exiger une correspondance exacte à l'image YouTube.
- [ ] **Position incertaine** : lors d'une initialisation, d'un buffering, d'un seek local en cours, d'un changement rapide de mode ou d'une erreur, ne jamais réutiliser une ancienne cible devenue incertaine. Un transfert impossible est signalé ; aucune navigation précédemment refusée n'est rejouée.
- [ ] **Bornes et identité** : sur un transfert Local, borner une position préparée à la durée connue ; refuser une navigation explicite hors durée. Après suppression/rechargement du média, changement de vidéo/source ou rafraîchissement, ne pas réutiliser de préparation issue de l'ancienne session.
- [ ] **Autoplay bloqué, si reproductible** : si l'iframe émet `onAutoplayBlocked`, afficher une indication non fatale invitant à démarrer manuellement, puis l'effacer quand la lecture commence. L'absence de cet événement ne constitue pas un échec du test.

## 4. Affichage actuel et accessibilité — scénarios ciblés

- [ ] **Surfaces vidéo** : à largeurs desktop et mobile, YouTube et Local occupent une surface commune au format 16:9, à l'exception du minimum de **200 px** sur très petit mobile. Une vidéo 4:3 ou portrait conserve son image sans déformation ni recadrage imposé par Local (`object-fit: contain`).
- [ ] **Workspace desktop (à partir de 1100 px)** : Lecteur et Transcription forment visuellement un cadre droit jointif, mais restent des composants distincts. Le texte de transcription conserve au moins **12rem** de hauteur utile hors commandes/messages ; les contenus longs n'agrandissent pas indéfiniment le workspace.
- [ ] **Workspace mobile et fenêtre basse** : à 1099, 375 et 320 px, l'ordre Lecteur → Note → Transcription, le défilement de page et l'absence de débordement horizontal sont préservés. Sur petite hauteur ou avec zoom, la page peut défiler au lieu d'écraser les panneaux.
- [ ] **Commandes et popovers** : sélecteur YouTube/Local, Informations, masquage et actions de conservation restent accessibles au clavier et dans les deux thèmes. Échap, fermeture, clic extérieur et restitution du focus fonctionnent ; les popovers ne sont pas rognés par le lecteur.
- [ ] **Messages et états atypiques** : absence de média, erreur de lecture, transfert impossible, lecteur masqué et chargement ne doivent ni masquer les actions utiles ni faire chevaucher les panneaux. Les notifications informatives restent près du lecteur.
- [ ] **Note/Informations** : lors d'un long document, d'une capture en cours ou d'une erreur de sauvegarde, les onglets conservent l'état de l'éditeur et les actions de résolution restent accessibles.

## Limites de validation

- Le fonctionnement de `ffprobe`/`ffmpeg` ne prouve pas que Brave sache décoder les mêmes pistes. Une requête HTTP Range réussie ne prouve pas non plus le décodage audio/vidéo.
- Une capture extraite par ffmpeg peut différer de l'image effectivement affichée dans l'iframe YouTube, même à des timestamps proches.
- Les tests automatisés vérifient de nombreux contrats de code, mais les comportements réels de l'iframe, du navigateur, des codecs et du plein écran nécessitent des vérifications sur les environnements concernés.
- Ne pas transformer une recette non exécutée en validation acquise. Reporter dans la PR le navigateur, les médias utilisés, les cas effectivement testés et les éventuelles limites.
