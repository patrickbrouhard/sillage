# Tests Postman de Sillage

Les deux collections utilisent le format Postman **v3**, composé de fichiers
`*.request.yaml` et de métadonnées `.resources/definition.yaml`.
Elles s'utilisent avec Postman v12 (Native Git) et Postman CLI, pas Newman.

## Collections

- **deterministic/** : scénarios ne nécessitant ni exécution réelle de `yt-dlp`
  ni accès réseau externe. Les échanges HTTP avec Sillage restent locaux.
  Certaines validations passent par l'adaptateur avant rejet.
- **youtube/** : scénarios réels, réservés aux lancements locaux avec `yt-dlp`
  et accès à YouTube. Aucun workflow ne lance cette collection.

La collection déterministe couvre 29 requêtes : bibliothèque vide, vidéo absente,
identifiants invalides, validation JSON et URL, types de contenu, paramètres MIME,
limite exacte de 16 Kio et dépassement, puis bibliothèque toujours vide.

La collection YouTube couvre cinq requêtes : bibliothèque vide, création,
doublon sans refresh, détail et liste. Les assertions portent sur la représentation,
les identifiants, les en-têtes et la cohérence des réponses ; le titre et la
description ne sont pas figés. Chaque parcours complet exige une base vide.

Aucun faux exécutable `yt-dlp` n'est ajouté pour ce jalon. Les scénarios CI de
création réussie, doublon, tri sur bibliothèque remplie, échec d'extraction et
timeout seront ajoutés au second jalon. Les tests Go existants restent complémentaires.

## Prérequis

Exécuter les commandes depuis la racine du dépôt, sous Linux ou WSL2 :

- Go correspondant à `go.mod`, disponible dans `PATH` ;
- Python 3 (bibliothèque standard uniquement) ;
- Postman CLI **1.56.1**, version validée et utilisée en CI ;
- pour `youtube/` seulement : le véritable `yt-dlp` disponible dans `PATH`.

Le lanceur utilise directement `postman` trouvé dans `PATH`. Si la CLI est déjà
installée (par exemple `/usr/local/bin/postman`), aucune réinstallation n'est nécessaire :

```bash
postman --version
command -v postman
```

Si elle est absente, l'installateur officiel peut être utilisé :

```bash
curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
```

Cet installateur fournit la version courante. Pour installer exactement la version
validée dans un dossier dédié, sans sudo, utiliser le script employé par la CI :

```bash
bash tests/postman/install-cli.sh "$HOME/.local/lib/sillage-postman"
```

Ce script cible Linux x86_64, fixe la version et vérifie l'archive par SHA-256.
Il ne modifie pas le PATH global. Le téléchargement des outils et dépendances
nécessite Internet ; la qualification « sans réseau externe » concerne les
scénarios déterministes exécutés contre l'API.

## Exécution en CLI

Avec `postman` disponible dans `PATH`, les commandes suffisent :

```bash
python3 tests/postman/run.py deterministic
python3 tests/postman/run.py youtube
```

L'option `--postman` est facultative. Elle sert uniquement à choisir un autre
exécutable, notamment après l'installation dédiée ci-dessus :

```bash
python3 tests/postman/run.py deterministic \
  --postman "$HOME/.local/lib/sillage-postman/postman"
```

Pour choisir une autre vidéo :

```bash
python3 tests/postman/run.py youtube \
  --youtube-url 'https://www.youtube.com/watch?v=IgKU8xCgbjc'
```

Le lanceur :

1. construit le véritable serveur ;
2. crée un répertoire de travail temporaire avec sa propre base `data/sillage.db` ;
3. démarre Sillage sur `127.0.0.1:18080` et attend une bibliothèque vide ;
4. exécute la collection, en arrêtant le parcours au premier échec ;
5. arrête les processus et supprime uniquement ce répertoire temporaire.

La base personnelle du dépôt n'est pas utilisée. Un port occupé provoque un
échec ; il n'est jamais réutilisé comme cible. `--port 18081` permet de changer
le port. En mode déterministe, le serveur reçoit un PATH vide de tout exécutable.

Les logs `server.log` et `postman.log` restent dans le dossier affiché.
`--logs-dir /chemin/dedie` permet de le choisir. Une nouvelle exécution dans
le même dossier remplace les logs précédents. Aucun secret Postman n'est requis.
La CLI peut afficher « No authorization data found » puis exécuter normalement
la collection. L'option `--no-report-events` désactive la remontée des événements.
L'export `--output` exige une connexion dans cette version : nous conservons donc
les logs texte et le véritable code de sortie, sans masquer les échecs.

Le timeout de la CLI par requête est de 75 s, supérieur aux 60 s du POST Sillage.

## Utilisation dans Postman

Ouvrir le dépôt local avec **Native Git dans Postman v12**, puis les collections
situées dans `tests/postman/sillage-api/`. Les fichiers v3 du dépôt sont la source
de vérité ; aucune collection cloud ni export v2.1 n'est nécessaire.

Démarrer le serveur dédié et le laisser ouvert :

```bash
python3 tests/postman/run.py deterministic --serve
# Ou, pour le vrai parcours YouTube :
python3 tests/postman/run.py youtube --serve
```

Dans Postman :

1. utiliser `baseUrl = http://127.0.0.1:18080` (ou le port affiché) ;
2. pour YouTube, régler `youtubeUrl` dans les variables de la collection ;
3. lancer la collection entière dans son ordre enregistré ;
4. terminer le serveur avec Ctrl+C.

Pour recommencer le parcours YouTube, arrêter puis relancer le serveur pour
retrouver une base vide. La collection mémorise l'ID et la représentation créée
pendant le parcours ; le premier scénario efface les valeurs des runs précédents.
Un environnement Postman ne doit pas masquer ces variables avec d'anciennes valeurs.

Avec Postman sous Windows et Sillage sous WSL2, utiliser le localhost transféré
par WSL. Si ce transfert n'est pas disponible sur la machine, il faut le rétablir
avant de tester depuis l'application Windows ; le serveur reste lié au loopback.

## GitHub Actions

`.github/workflows/api-tests.yml` est déclenché par `push`, `pull_request` et
`workflow_dispatch`.

Il exécute les tests Go, `vet`, le build, valide le format des deux collections,
puis **exécute uniquement deterministic/**. Les logs sont conservés dans l'artefact
`sillage-api-logs`, y compris en cas d'échec. Le lanceur refuse également
`youtube` lorsque `GITHUB_ACTIONS=true`.

## Références

- [Format des collections](https://learning.postman.com/docs/use/use-collections/collections-schemas)
- [Commandes Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-collections)
- [Native Git](https://learning.postman.com/docs/use/native-git/develop-locally)
