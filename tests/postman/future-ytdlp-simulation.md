# Amélioration différée : simuler yt-dlp pour les tests Postman

## Statut et décision

**Différé, sans échéance.** Le premier jalon est suffisant pour les besoins actuels.
Le second jalon n'est ni un prérequis à la poursuite du développement ni une tâche
à implémenter automatiquement.

Cette note conserve la piste d'une simulation du processus yt-dlp pour enrichir
les tests Postman exécutables en CI. Sa reprise demande un besoin concret et une
décision explicite.

## Ce qui est déjà couvert

- Les tests Go vérifient notamment la persistance, les créations concurrentes,
  les DTO, les erreurs et la propagation de l'annulation.
- La collection Postman `deterministic/` vérifie les lectures sur une base vide
  et les rejets de requêtes. Ces scénarios ne nécessitent ni exécution réelle de
  `yt-dlp` ni accès réseau externe ; certaines validations passent par l'adaptateur.
- La collection `youtube/` exerce localement l'extraction réelle, la création,
  le doublon sans refresh, le détail et la liste.
- Les deux collections fonctionnent en CLI sur le PC de développement.
  GitHub Actions exécute avec succès la collection déterministe.
- L'utilisation depuis Postman Desktop reste à valider séparément ; cette
  difficulté ne justifie pas l'ajout d'un faux exécutable.

Le manque actuel est précis : les parcours Postman de création réussie et
d'erreurs d'extraction ne sont pas exécutés automatiquement en CI.
Les tests Go et les essais réels locaux apportent déjà une couverture complémentaire.

## Quand reconsidérer cette amélioration

| Situation constatée | Valeur attendue de la simulation |
| --- | --- |
| Une régression d'ajout, de doublon ou de réponse JSON passe les tests Go mais apparaît avec le serveur réel. | Reproduire automatiquement le parcours HTTP complet qui a échoué. |
| Les modifications du POST, du raccordement des composants ou de la gestion des délais deviennent fréquentes. | Vérifier les écritures et les erreurs à chaque changement sans extraction distante. |
| Les essais YouTube deviennent trop instables ou contraignants pour servir de vérification régulière. | Disposer de données contrôlées pour les tests du contrat, tout en gardant quelques essais réels. |
| Une évolution exige plusieurs vidéos, plusieurs sources ou des valeurs optionnelles difficiles à obtenir de manière stable sur YouTube. | Construire les seuls jeux de données nécessaires au nouveau comportement. |
| Un incident révèle un défaut de mapping d'erreur ou un timeout mal propagé jusqu'à la réponse HTTP. | Reproduire de façon déterministe l'échec concerné. |

Un déclencheur invite à réévaluer le besoin, pas à tout implémenter.
Avant de reprendre, décrire le problème observé et le scénario manquant,
puis vérifier si un test Go ciblé suffit. Retenir la simulation Postman si la
vérification du serveur assemblé en processus séparé apporte une valeur réelle.

Une hausse abstraite du taux de couverture, le simple passage du temps ou la
présence de cette note ne constituent pas des raisons suffisantes.

## Approche envisagée si le besoin est confirmé

Conserver le vrai binaire Sillage, ses handlers, ses services, son adaptateur
d'extraction et SQLite. Remplacer uniquement le processus externe par un
exécutable de test nommé `yt-dlp`, placé en tête du PATH du serveur par le lanceur.

Le processus de test retournerait des métadonnées prédéfinies ou un échec
contrôlé selon des entrées explicitement reconnues. Il refuserait toute entrée
imprévue et ne ferait aucun appel réseau externe.

Contraintes à conserver :

- aucune route de test ni option de simulation dans l'application ;
- aucun faux retour HTTP : les assertions portent sur les réponses du vrai serveur ;
- base et répertoire de travail temporaires, sans toucher aux données personnelles ;
- PATH spécifique au processus de test, sans modifier celui de la machine ;
- fixtures minimales et lisibles, sans copie brute volumineuse de métadonnées ;
- conservation du vrai parcours YouTube local : la simulation ne vérifie pas
  la compatibilité avec les évolutions de YouTube ou de yt-dlp ;
- aucune tentative de reproduire toutes les options ou tous les extracteurs de yt-dlp.

Le lanceur actuel donne un PATH vide au serveur en mode déterministe.
Lors d'une éventuelle reprise, il faudra adapter ce point explicitement et rendre
visible le mode utilisé. L'organisation des nouvelles collections et fixtures
sera choisie à ce moment, sans charger systématiquement une simulation pour les
scénarios qui n'en ont pas besoin.

## Scénarios candidats

À sélectionner selon le problème déclencheur, sans obligation de tous les ajouter :

- création `201` avec `Location`, puis doublon `200` sans refresh ;
- détail et liste cohérents avec la vidéo créée ;
- bibliothèque remplie, ordre des ajouts, champs absents et durée connue de zéro ;
- échec du processus ou métadonnées inexploitables donnant `502` ;
- processus lent, interruption par le contexte et réponse JSON `504`.

Un faux yt-dlp ne suffit pas à maîtriser la date de création attribuée par Sillage,
ni à rattacher plusieurs sources à une seule vidéo via le POST actuel.
Le départage de dates égales et les agrégats multisources restent couverts en Go ;
ne pas ajouter d'horloge configurable ou de route de préparation uniquement pour
les reproduire dans Postman.

Pour tester un timeout, utiliser un délai court propre au lancement de test et
vérifier l'arrêt du processus. Ne pas imposer une attente de 60 secondes à chaque
run. Le lanceur actuel fixe le délai à 60 secondes : son adaptation éventuelle
fait partie du travail à évaluer.

## Critères de validation d'une reprise

1. Le scénario qui motive la reprise est reproductible et échoue lorsque le
   comportement attendu est volontairement rompu.
2. La collection passe localement avec Postman CLI et dans GitHub Actions,
   sans installation du vrai yt-dlp ni accès à YouTube.
3. Les échecs remontent un code de sortie non nul ; processus et base de test
   sont nettoyés, avec logs conservés.
4. Les collections existantes continuent de fonctionner et la documentation
   distingue clairement simulation, validation sans processus et extraction réelle.

Voir le [README des tests Postman](README.md) pour les commandes actuelles.
