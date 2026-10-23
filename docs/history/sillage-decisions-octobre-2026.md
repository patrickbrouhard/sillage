# Sillage — Arbitrages techniques et UX (octobre 2026)

> **Historique ciblé, non normatif.** Ce document conserve les raisons de quelques changements de direction intervenus pendant les travaux sur les médias et le workspace. Pour modifier Sillage, se référer d'abord au code et aux documents de référence (`../01-product-and-ux.md`, `../02-domain-model.md`, `../03-architecture.md`, `../04-tech-stack-and-decisions.md`). Il ne s'agit ni d'une roadmap, ni d'un compte rendu de tests, ni d'une liste de travaux à effectuer.

## 1. Acquisition des médias : préférer la sélection native de yt-dlp

**Évolution.** La première implémentation du téléchargement a été corrigée pour ouvrir les formats pris en charge plutôt que maintenir une sélection restrictive de conteneurs et de pistes. L'acquisition a ensuite été simplifiée en un appel `yt-dlp`, avec les propriétés techniques mesurées par `ffprobe` et la langue de la piste sélectionnée issue de `yt-dlp`.

**Pourquoi retenir ce changement.** Des contraintes de sélection trop strictes faisaient dépendre Sillage d'hypothèses fragiles sur les formats et les pistes audio disponibles. Le choix natif du téléchargeur simplifie la politique ; il ne constitue toutefois **pas une garantie universelle d'obtenir l'audio original**.

**Où se trouve la règle actuelle.** `../04-tech-stack-and-decisions.md` (téléchargement 7.1) et `../02-domain-model.md` (`MediaFile`).

## 2. Conservation : ne pas assimiler absence de référence SQL et fichier supprimable

**Évolution.** Le correctif de conservation de 7.1 a pris en compte les médias orphelins après restauration d'une ancienne base, les suppressions interrompues et les résultats SQL incertains.

**Pourquoi.** Un fichier physiquement présent peut représenter une conservation volontaire, même si sa référence n'est plus retrouvée dans l'état courant de SQLite. Une tentative de « réparation » automatique pourrait entraîner une perte irréversible de média.

**Conséquence.** La découverte d'orphelins ne doit pas, à elle seule, déclencher une suppression. Les politiques de rapprochement et de maintenance restent distinctes de la suppression explicitement demandée par l'utilisateur.

**Règle actuelle.** Voir `../03-architecture.md` et `../04-tech-stack-and-decisions.md`.

## 3. Lecture locale : changement de priorité de présentation

**Évolution.** Le lecteur local a été introduit après la lecture YouTube, dans la même zone logique. Le comportement initial a ensuite été orienté vers **Local en priorité quand un fichier est disponible**, sinon YouTube. Ce choix ne correspond pas à une préférence persistée et la fin d'un téléchargement ne change pas automatiquement le lecteur actif.

**Pourquoi.** La lecture distante est utile pour accéder immédiatement à la vidéo ; la conservation locale vise le travail plus approfondi sur son contenu. La bascule ne doit pas perturber la note, la transcription ou les références temporelles.

**Règle actuelle.** Voir `../01-product-and-ux.md` et `../03-architecture.md`.

## 4. Temps YouTube : abandon du verrou `pendingSeek`

**Évolution.** Une stratégie de confirmation durable de la cible d'un `seek` a été essayée, puis abandonnée après la découverte d'un défaut logique dans un scénario de seek approché. La manifestation de ce défaut dans un vrai navigateur n'avait pas été démontrée au moment de sa détection.

**Pourquoi.** Comparer durablement le temps remonté par l'API YouTube à la cible demandée pouvait rendre les annotations indisponibles alors que l'API avait déjà atteint la position qu'elle annonçait. La solution retenue lit le temps déclaré par YouTube **dans un état admissible**, sans prétendre garantir sa fraîcheur immédiatement après un seek.

**À ne pas confondre.** Les positions préparées pour le changement de lecteur restent distinctes des positions admissibles pour `+ Temps` et `+ Capture`. La navigation explicite et la préparation lors d'une bascule ont des comportements différents.

**Règle actuelle.** Voir `../04-tech-stack-and-decisions.md` (temps et navigation YouTube).

## 5. Workspace : préserver les composants et la session de note pendant les refontes

**Évolution.** L'interface est passée de plusieurs barres et informations occupant l'espace vertical à un en-tête compact, une navigation superposée, les onglets Note/Informations et un workspace réorganisé. Le lecteur et la transcription demeurent des composants distincts même lorsqu'ils paraissent jointifs sur desktop.

**Pourquoi.** Gagner de l'espace de travail ne doit pas provoquer de remontage du Markdown ou perdre sélection, défilement, historique Undo/Redo, sauvegarde ou captures en cours. La cohérence visuelle ne nécessite pas la fusion des composants.

**Arbitrages notables.** Surface vidéo 16:9 en situation ordinaire, avec exception de hauteur minimale sur très petit mobile ; hauteur minimale utile de transcription sur desktop. Un futur redimensionnement devra arbitrer explicitement entre largeur de la surface et ratio du contenant, et non supposer que toutes ces contraintes peuvent rester fixes simultanément.

**Règle actuelle.** Voir `../01-product-and-ux.md` (workspace, panneau vidéo, fiche vidéo) et `../03-architecture.md`.

## 6. Enseignement de validation : tests simulés et navigateur réel ne prouvent pas la même chose

Les validations automatisées ont largement couvert les flux Go/REST, Playwright, Docker et des médias locaux réels. En revanche, certaines interactions du lecteur YouTube et politiques d'autoplay ont été testées avec un **lecteur simulé** : ces résultats ne prouvent pas à eux seuls le comportement réel dans Brave ou d'autres navigateurs.

Pour de futures refontes touchant lecture, focus, pleine page, formats atypiques ou zoom, compléter les tests déterministes par une **recette manuelle ciblée**, sans recopier les nombres de tests de chaque ancienne tranche. Les scénarios historiques non rejoués ne doivent pas être présentés comme validés aujourd'hui.

## Traçabilité

Le détail des étapes, anciennes recettes et nombres de tests reste récupérable dans l'historique Git du document d'origine `docs/05-roadmap-and-open-questions.md`. Les états intermédiaires ne font pas autorité sur le comportement actuel.
