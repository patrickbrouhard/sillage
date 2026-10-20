# Recette de lecture locale

## Statut

La priorité initiale Local est activée après accord explicite de l'utilisateur.
Les tests Chromium automatisés
ne garantissent pas les capacités de Brave Windows ni tous les conteneurs/codecs.

## Vérifications manuelles dans Brave sous Windows

Utiliser des fichiers réellement téléchargés par Sillage via yt-dlp, dont une
vidéo longue et les conteneurs disponibles. Conserver la sélection native actuelle.

1. Ouvrir une vidéo avec et sans fichier : Local si disponible, sinon YouTube.
   Avec une consultation lente, aucun lecteur YouTube ne doit apparaître avant Local.
   Aucun mode n'est annoncé sélectionné pendant la consultation initiale.
   Sans fichier, Local ouvre la confirmation et conserve le mode actif.
2. Pendant une lecture YouTube, cliquer Local, annuler, puis confirmer un téléchargement.
   Aucun de ces gestes ni la fin du téléchargement ne doit changer l'instance,
   la lecture ou la position. Sélectionner Local ensuite reste volontaire.
3. Passer à Local vers 12:30 puis revenir à YouTube : arrêt de l'ancien lecteur,
   position approximativement conservée, aucune reprise automatique. Un départ
   YouTube préparé peut rester une vignette jusqu'au clic Lecture.
4. Tester le seek natif au début, au milieu et près de la fin d'un long fichier ;
   vérifier image et audio, plein écran, volume, réactivité et console réseau.
   Ne pas confondre requêtes Range et preuve de décodage de toutes les pistes.
5. Depuis Local, tester timestamps de transcription, références en Lecture et
   Ctrl-clic/Mod-Entrée en Édition ; vérifier refus vers une autre vidéo/source.
   Tester + Temps et + Capture, y compris sur un lecteur masqué en pause.
6. Éditer une note, sélectionner du texte, basculer rapidement, masquer/réafficher :
   sélection, Undo/Redo, focus utile et autosauvegarde restent fonctionnels.
7. Tester un fichier non lisible ou une réponse média interrompue : Local reste
   choisi, erreur prudente, aucun effacement/conversion, retour YouTube manuel.
8. Supprimer après confirmation pendant la lecture locale : arrêt et déchargement,
   état Local vide, connaissances et PNG conservés. Annuler ne doit rien arrêter.
   Après refus concurrent, recharger le lecteur ou réessayer explicitement.
   Après suppression réussie puis rafraîchissement, YouTube doit être sélectionné.
9. Avec deux onglets, vérifier le refus de suppression pendant un transfert actif
   et l'erreur d'une nouvelle plage après suppression entre deux transferts.
   Les octets déjà tamponnés peuvent encore être lus dans l'autre onglet.
10. Vérifier 320/375 px et desktop, clavier, noms accessibles, messages, thème
    sombre, absence de débordement et stabilité des panneaux.

## Limites à observer

Le téléchargement peut contenir une piste doublée différente de la transcription.
Les durées proches ne garantissent pas l'identité image par image. ffmpeg et le
navigateur peuvent décoder des formats différents. Les captures conservent leur
repli serveur indépendamment du mode. Aucun test manuel Brave n'est revendiqué
par la seule réussite de la suite automatisée.

## Choix initial activé

Le choix initial est Local seulement si le média de la source de travail est
disponible, sinon YouTube, également en cas d'erreur de consultation. Attendre le premier résultat de disponibilité sans
monter brièvement YouTube ; garder notes/transcription indépendantes. En cas
d'échec de lecture après sélection de Local, rester Local. Aucune préférence
persistée et aucune bascule à la fin d'un téléchargement.


## Recette complémentaire — barre phase 1

- Vérifier la ligne unique avec segments, Informations et œil, en clair/sombre
  à 1440, 375 et 320 px. Le mode actif reste identifiable, le focus reste sur
  son bouton après bascule. Le libellé Local ne disparaît jamais.
- Confirmer que les marges de 1rem et les hauteurs de la surface sont inchangées.
  Aucune validation du bord à bord n'est incluse dans cette recette.
- Annuler/Échap dans la modale : aucun POST. Double clic Confirmer : une seule demande.
  Cliquer pendant acquisition : état visible, pas de téléchargement concurrent.
- Modifier l'état depuis un autre onglet pendant que la modale est ouverte :
  la consultation existante actualise son contenu et les actions possibles.
- Vérifier spinner pendant activité, coche/croix cinq secondes après résultat confirmé.
  Recharger : pas de résultat ancien ; spinner si serveur encore actif.
  Coupure réseau : diagnostic d'incertitude sans résultat inventé ni second POST.
- Ouvrir Informations au clavier : contenu focalisé, Tab vers les actions,
  Échap vers Informations, clic extérieur sans reprise du focus.
  Vérifier les longues descriptions, dimensions inconnues et added_at local.
- Supprimer depuis le popover : Annuler focalisé ; retour à Informations ;
  lecture arrêtée seulement après confirmation en Local. Après suppression,
  rester Local vide et ouvrir la même modale pour télécharger à nouveau.
- Depuis YouTube, traiter un fichier enregistré mais indisponible par la fenêtre
  Local : suppression confirmée de l'identité sans arrêter YouTube.
- Vérifier que les erreurs restent accessibles après fermeture des informations
  et après disparition de la croix. Une erreur de décodage n'est pas un échec d'acquisition.
- Revoir Métadonnées et sources : toutes les sources et informations internes
  demeurent accessibles, indépendamment du popover de la source de travail.

Les tests player-panel.spec.ts produisent des captures en clair/sombre pour trois
largeurs, avec un vrai WebM synthétique et une acquisition distante simulée.
Les captures YouTube utilisent l'API simulée (iframe vide) : vérifier le véritable
lecteur et ses interactions de focus/modalité dans Brave Windows.
La phase 2 reste interdite sans retour explicite après ce bilan.

## Recette complémentaire — transfert temporel de session

- YouTube jamais démarré → Local : début du fichier, aucun faux avertissement.
- Local à 0:40 → YouTube préparé → Local sans lecture : environ 0:40, en pause.
- Depuis ce YouTube préparé, activer une référence vers 1:20 (transcription,
  Lecture Markdown, puis Édition) : retour Local vers 1:20 si commande acceptée.
- Lire YouTube jusqu'à 1:10 après une préparation à 0:40 : Local reçoit le temps
  réellement lu, sans reprendre automatiquement.
- Sur YouTube cued, y compris après masquage, + Temps et + Capture doivent refuser.
  Après lecture puis pause, ils retrouvent leur comportement habituel.
- Basculer rapidement pendant initialisation ; une ancienne instance ne doit
  commander ni déplacer le nouveau lecteur. Un timestamp refusé n'est pas différé.
- Basculer pendant buffering, seek local en cours ou après erreur : aucun retour
  trompeur vers 0:40 ; avertissement de transfert impossible, nouveau lecteur en pause.
- Masquer un lecteur réellement en pause puis basculer : conserver son temps.
  Tester également le cas d'une pause YouTube non confirmée et détruite.
- Atteindre une position distante au-delà de la durée locale : la cible locale
  est bornée ; revenir sur YouTube ne doit pas ressusciter la cible hors durée.
- Supprimer/recharger le média, changer de fiche/source et rafraîchir : pas de
  reprise d'une ancienne préparation. Note, sélection, Undo/Redo et autosauvegarde
  restent inchangés.

Le spinner natif Local, preload, ratios, paddings et hauteurs ne sont pas modifiés.
La simulation YouTube couvre les commandes et refus mais ne remplace pas ces essais
sur l'API réelle dans Brave Windows, notamment ses délais de seek et de buffering.

## Recette complémentaire — annotations après navigation YouTube

- En pause, activer une référence de transcription ou Markdown puis + Temps et
  + Capture : utiliser le temps annoncé, même légèrement différent de la cible.
- Tester seeks courts et longs, avant/arrière, portions chargées et non chargées,
  références successives et déplacements dans les contrôles natifs.
- Vérifier qu'une navigation ne laisse pas un verrou durable après retour à un
  état exploitable. Buffering, erreur, lecteur absent et masquage en cours restent
  des motifs de refus ; une ancienne commande de seek n'en est plus un.
- Vérifier les captures à partir de la position relevée, sans exiger l'identité
  image par image avec l'iframe. La fraîcheur instantanée du getter YouTube n'est
  pas certifiée ; observer notamment les clics très rapprochés de la navigation.
- Depuis un lecteur non démarré, cued ou terminé : un clic temporel demande
  désormais la lecture au passage. Une bascule seule garde son départ préparé
  sans lecture et ne rend pas ce départ annotable.
- Local conserve le refus pendant seeking ; préparation et bascules restent
  distinctes de la lecture du temps pour les annotations.

Les tests de caractérisation de 83a7f40 sont remplacés par des assertions de
réussite à la valeur annoncée. Le cas d'un getter encore ancien explicite la
limite acceptée ; il ne prétend pas reproduire un défaut observé dans Brave.

## Recette complémentaire — navigation explicite YouTube

- Sur un profil Brave peu utilisé, ouvrir YouTube sans démarrer : cliquer un
  timestamp de transcription puis une référence Markdown, y compris au clavier.
  Le lecteur doit demander la lecture au passage ; vérifier aussi ended et cued.
- En lecture, continuer après navigation ; en pause, rester en pause. Tester
  Lecture Markdown, callouts, Ctrl-clic et Mod-Entrée dans l'éditeur.
- Local → YouTube : départ préparé sans lecture. Cliquer ensuite une référence :
  abandonner l'ancien départ, naviguer, puis annoter avec le temps annoncé.
- Avec restrictions du navigateur, le lecteur reste accessible. Si le signal
  onAutoplayBlocked arrive, un message invite à utiliser Lecture. Il disparaît
  à playing. Sans signal, aucun diagnostic par délai ni relance automatique.
- Masquage en cours : navigation refusée. Lecteur masqué conservé en pause :
  révélation et seek sans reprise. Une instance détruite ne réagit plus.
- Vérifier l'absence de lecture à l'ouverture et à chaque bascule. Local,
  captures, sélection, Undo/Redo et autosauvegarde restent inchangés.

## Validation Brave avant la phase 2

L'utilisateur a validé manuellement dans Brave Windows la phase 1 du panneau,
les évolutions temporelles et la navigation explicite YouTube avant cette phase.
La préparation sans lecture lors des bascules et le comportement Local sont
conservés. La phase 2 bord à bord est désormais autorisée ; sa validation visuelle
et fonctionnelle fera l'objet d'un nouveau retour utilisateur.
