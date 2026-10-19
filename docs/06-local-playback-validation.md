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
   Local reste sélectionnable sans fichier et permet de télécharger.
2. Lancer un téléchargement, revenir sur YouTube, démarrer sa lecture. La fin du
   téléchargement ne doit changer ni instance ni lecture ni position.
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
