# Configuration déclarative et authentification

Sillage peut démarrer une bibliothèque neuve sans commande interactive. Le propriétaire
reste unique ; un changement d'identifiant ne crée ni bibliothèque ni nouvel utilisateur.
La [sécurité Web](security.md) conserve les contrats de session, CSRF et protection REST.

## Sources et responsabilités

- Les variables opérationnelles existantes règlent l'écoute, l'origine publique, les logs
  et les délais. Elles ne contiennent pas le mot de passe.
- `SILLAGE_CONFIG_FILE` désigne un fichier JSON de provisionnement et d’authentification. Absente, cette
  variable conserve le parcours local historique. Présente mais vide, elle est invalide.
- SQLite conserve le propriétaire, son vérificateur Argon2id, son statut d'administration,
  sa génération, les sessions et la bibliothèque. Le mot de passe clair n'y est pas stocké.

Le document est lu au démarrage, sans surveillance ni rechargement à chaud.
Il n'existe ni fusion de couches ni moteur générique de configuration. Les réglages
opérationnels ne sont pas dupliqués dans le JSON. L'autorité du bloc `owner` porte
ensemble sur l'identifiant et le secret local.

## Document et secret

```json
{
  "version": 1,
  "owner": {
    "mode": "managed",
    "username": "mon-identifiant",
    "password_file": "owner-password"
  }
}
```

`version`, `owner`, `owner.mode` et `owner.username` sont obligatoires.
`owner.password_file` est obligatoire pour `local` et `both`, facultatif pour `oidc`.
`owner.adopt_existing` autorise explicitement l'adoption d'une installation existante :
identifiants locaux en `managed`, ou première autorité d'authentification déclarée.
Aucun secret littéral n'est admis dans le document.

Le fichier JSON doit être régulier, en UTF-8, et ne pas dépasser 16 Kio. Champs inconnus,
doublons, variantes de casse, valeurs nulles, documents concaténés et versions inconnues
sont refusés. Les clés API sont administrées séparément depuis le Web ; voir [Clés API](api-keys.md).

Le chemin du secret est absolu ou relatif au répertoire du JSON, jamais au répertoire
de données. Sa cible doit être un fichier régulier lisible par l'utilisateur du serveur ;
les liens symboliques de montages de secrets sont acceptés. Les lectures sont bornées.

Le mot de passe contient 15 caractères Unicode au minimum, 1024 octets UTF-8 au maximum.
Ses octets sont lus **sans normalisation ni suppression des blancs ou retours à la ligne**.
Préparer le fichier sans saut de ligne final, sauf si celui-ci fait intentionnellement
partie du mot de passe. Protéger son accès et le monter en lecture seule. Un fichier monté
n'est pas un coffre chiffré ; le gestionnaire de secrets et les sauvegardes de configuration
restent sous la responsabilité de l'administrateur.

Les diagnostics n'affichent ni contenu du document, ni secret, ni chemin fourni.
Le serveur conserve uniquement le vérificateur salé dans SQLite.

## Bootstrap ou gestion permanente

| Situation | `bootstrap` | `managed` |
| --- | --- | --- |
| Aucun propriétaire | Crée un propriétaire administré localement | Crée un propriétaire administré déclarativement |
| Propriétaire local existant | Ne modifie rien si l'identifiant correspond | Exige `adopt_existing: true` |
| Propriétaire déjà déclaratif | Refus | Compare et applique les changements |
| Secret changé dans le fichier | Aucun effet après création | Rotation à la prochaine exécution |
| Configuration retirée | Administration locale conservée | Démarrage refusé |
| Récupération locale | `owner recover` reste disponible | Réparer la déclaration ou libérer explicitement l'autorité |

Ce tableau concerne l’autorité des identifiants locaux. Un bloc `authentication` adopté
reste administré indépendamment, y compris avec un bootstrap ; son retrait exige une
récupération explicite.

`managed` est recommandé pour les déploiements reproductibles. Une déclaration inchangée
ne réécrit pas le vérificateur et ne révoque pas les sessions, même après redémarrage.

En `bootstrap`, le fichier reste validé et tout secret déclaré reste requis tant que la déclaration
est présente. Une fois le propriétaire créé, on peut retirer `SILLAGE_CONFIG_FILE` et
le fichier de bootstrap. Un identifiant différent de celui déjà installé est refusé ;
le bootstrap n'est pas une commande de renommage ou de récupération.

Une adoption, un changement d'identifiant ou une rotation de mot de passe en mode
`managed` incrémente la génération et révoque toutes les sessions dans une seule
transaction. Une connexion ayant vérifié l'ancien secret ne peut pas publier une
session après ce changement. Si la transaction échoue, aucun changement partiel n'est
conservé. Les requêtes déjà acceptées ont les mêmes limites de révocation qu'en A1 + A2.

## Installation Docker automatisée

Depuis la racine du dépôt, préparer :

1. Un répertoire de données accessible à l'UID/GID du conteneur.
2. Un répertoire de configuration privé contenant `sillage.json` et `owner-password`.
   Le JSON peut partir de [l'exemple sans secret](../deployments/docker/sillage.example.json).
3. Un fichier `.env` à la racine, avec les chemins absolus et les UID/GID adaptés :

```dotenv
COMPOSE_FILE=deployments/docker/compose.yaml:deployments/docker/compose.declarative.yaml
SILLAGE_DATA_DIR=/chemin/absolu/sillage-data
SILLAGE_CONFIG_DIR=/chemin/absolu/sillage-config
SILLAGE_UID=1000
SILLAGE_GID=1000
SILLAGE_PORT=8080
```

Ces UID/GID sont des exemples de droits Linux, pas des identifiants applicatifs.
Le secret est préparé par l'administrateur ou son gestionnaire de secrets ; aucune
valeur par défaut n'existe. Le conteneur doit pouvoir traverser les répertoires et lire
les fichiers. Le complément Compose monte tout le répertoire de configuration en lecture
seule et définit `SILLAGE_CONFIG_FILE=/run/sillage-config/sillage.json`.

```bash
docker compose up -d
```

Compose construit l'image si elle est absente. Pour reconstruire après une mise à jour
des sources, utiliser `docker compose up -d --build`.
Ne pas exécuter `owner init` avant ce parcours. Le fichier Compose de base reste utilisable
seul pour les installations administrées localement. Les raccourcis Make imposent ce
fichier de base : utiliser directement `docker compose` avec le parcours déclaratif.

Le serveur est prêt après validation et provisionnement. Un document invalide, un secret
absent ou une adoption refusée arrête le démarrage ; aucune route privée n'est ouverte.
La validation des paramètres déclaratifs et de l'origine précède les mutations de
provisionnement. Les migrations de schéma restent distinctes : un échec ultérieur
du démarrage n'annule pas une migration ou une rotation déjà validée.

## Installation native

Définir `SILLAGE_CONFIG_FILE` avec le chemin du JSON puis lancer le binaire habituel.
La base reste `data/sillage.db`, relativement au répertoire courant. Aucun secret ne
doit être passé dans les arguments CLI. Les réglages d'origine et d'écoute restent ceux
du [README](../README.md#configuration).

## Reprise d'une installation A1 + A2

Sauvegarder à froid et arrêter le serveur. La migration conserve les identifiants,
vérificateurs et sessions existants, avec administration locale par défaut.

Pour adopter cette bibliothèque, fournir un document `managed` avec
`"adopt_existing": true` dans le bloc `owner`. Ce marqueur autorise explicitement le
remplacement éventuel des identifiants existants et révoque les sessions lors de l'adoption,
même si les identifiants fournis sont identiques. Retirer le marqueur après adoption est
recommandé ; son retrait ne change pas l'autorité persistée ni les sessions.

Sans ce marqueur, le passage du local au déclaratif est refusé sans modifier le propriétaire.

## Rotation et récupération

En mode `managed`, remplacer le secret dans sa source, puis redémarrer le serveur.
Sous Docker : `docker compose restart`. Si les montages ou variables Compose changent,
recréer le conteneur avec `docker compose up -d --force-recreate`.

Pour un mot de passe perdu, la même procédure suffit. `owner recover` refuse un
propriétaire administré déclarativement, y compris lorsque la variable de configuration
a été omise : le statut est conservé dans SQLite. Restaurer une configuration perdue est
possible en fournissant un nouveau document `managed` et un nouveau secret.

Pour rendre volontairement la main à l'administration locale :

1. Arrêter le serveur.
2. Retirer la déclaration `managed` de l'environnement administratif et du prochain
   démarrage ; ne pas seulement supprimer le fichier en laissant une variable invalide.
3. Exécuter `sillage owner release` sur la même base, avec un terminal.
   Saisir la confirmation exacte `RELEASE`.
4. Si nécessaire, exécuter `sillage owner recover`, puis redémarrer sans déclaration.

La libération conserve les identifiants et la bibliothèque mais révoque les sessions.
Elle est idempotente si l'autorité est déjà locale. Elle est refusée si une déclaration
`managed` est encore fournie à la commande. Le serveur doit rester arrêté pendant
ces opérations administratives.

Sous Docker, après avoir retiré le complément déclaratif de `COMPOSE_FILE`, utiliser
`docker compose run --rm sillage owner release`, puis éventuellement
`docker compose run --rm sillage owner recover`. Ne pas utiliser `-T` pour ces commandes.

Après restauration d'une sauvegarde déclarative, effectuer une rotation avant ouverture
si les sessions restaurées doivent être invalidées ; un démarrage avec un secret identique
les conserve normalement. En mode local, utiliser la récupération existante.

## Limites

Une instance unique possède le répertoire de données. Les contrôles de génération
refusent une modification concurrente du propriétaire ; ils ne constituent pas un mode
multi-instance. Une collision de provisionnement demande un nouveau démarrage après
vérification de la configuration.

Le document déclaratif ne gère pas les clés API : leur autorité reste en base et leur
administration Web est décrite dans [Clés API](api-keys.md). Les changements
administratifs d'identité préservent les clés ; la réinitialisation de sécurité
explicite révoque sessions et clés sans modifier la déclaration.

## Authentification OIDC — A3.2

Deux autorités restent indépendantes : `owner.mode` gouverne les identifiants locaux ;
le bloc `authentication` gouverne durablement la politique et l'identité OIDC autorisée.
La présence de ce bloc fait autorité, même avec `owner.mode: bootstrap`. Le retirer après
adoption fait échouer le démarrage : le défaut historique `local` ne réactive jamais
une méthode précédemment désactivée. Son contenu sensible est conservé dans SQLite,
sans le secret client. L'identité applicative et la bibliothèque restent inchangées.

Exemple OIDC seul, sans mot de passe local :

```json
{
  "version": 1,
  "owner": { "mode": "managed", "username": "proprietaire" },
  "authentication": {
    "policy": "oidc",
    "oidc": {
      "issuer": "https://auth.example.net",
      "subject": "sujet-exact-fourni-par-le-fournisseur",
      "client_id": "sillage",
      "client_secret_file": "oidc-client-secret"
    }
  }
}
```

| Politique | Connexion locale | OIDC | Paramètres requis |
| --- | --- | --- | --- |
| `local` | Oui | Non | Mot de passe ; aucun fournisseur |
| `both` | Oui | Oui | Mot de passe et bloc `oidc` complet |
| `oidc` | Non, même si un ancien hash subsiste | Oui | Bloc `oidc` complet ; mot de passe facultatif |

Sans bloc `authentication`, une installation historique reste locale. Une première adoption
sur une base existante exige `owner.adopt_existing: true`. Un bootstrap conserve le secret
local existant ; `managed` applique sa suppression si `password_file` est omis en mode `oidc`.
La politique est contrôlée côté serveur, indépendamment des boutons affichés.

Préparer auprès du fournisseur un client confidentiel utilisant Authorization Code,
PKCE S256 et le scope `openid`. Enregistrer exactement la callback
`SILLAGE_PUBLIC_URL/api/v1/auth/oidc/callback` (sans doubler le slash).
Pour Authelia, déclarer ce client et cette URI, puis fournir le **subject réellement émis
pour ce client** : ni l'adresse e-mail ni le nom de connexion ne sont des substituts.
Un sujet pairwise peut changer avec le client. Aucun compte externe n'est adopté
sur la seule base d'un premier login. L'association interactive relève d'A3.3.

L'issuer et les endpoints de découverte, de jetons et de clés doivent utiliser HTTPS
avec des certificats reconnus par le serveur. L'URL publique de Sillage suit les règles
existantes ; HTTP est réservé au développement local. Le déploiement du reverse proxy
et de TLS reste hors de cette tranche.

Le secret client est un fichier de 1 à 1024 octets, lu exactement, sans suppression du
saut de ligne final. Il n'est pas soumis à la longueur minimale du mot de passe humain.
Monter JSON et secrets en lecture seule avec le même overlay Compose que pour A3.1.
`docker compose up -d` suffit une fois le fournisseur, le client, le sujet et les secrets
préparés. Aucun appel réseau au fournisseur n'est nécessaire au démarrage du serveur.

Une rotation du secret client ne révoque pas les sessions Sillage. Un changement de
politique, d'issuer, de subject ou de client ID révoque toutes les sessions et invalide
les authentifications commencées avant ce changement. Les parcours OIDC en cours sont
également abandonnés à chaque redémarrage ; les sessions établies persistent.
Une panne du fournisseur bloque uniquement les nouvelles connexions OIDC, jamais une
session Sillage encore valide ni la connexion locale explicitement autorisée par `both`.

## Récupérer une politique d'authentification administrée

La voie normale consiste à corriger la déclaration puis redémarrer. Pour revenir
explicitement à l'administration locale, serveur arrêté :

1. Retirer les déclarations concernées de la configuration utilisée par les commandes.
2. Si les identifiants locaux sont `managed`, exécuter `sillage owner release`.
3. Exécuter `sillage owner recover-auth` et saisir un nouveau mot de passe local.
4. Redémarrer sans le bloc `authentication` retiré, ou préparer une nouvelle adoption explicite.

`recover-auth` fixe le mot de passe, libère l'autorité d'authentification, revient à
`local` et révoque toutes les sessions dans une transaction. Il refuse de contourner
une autorité de secret local encore `managed` ou un bloc d'authentification encore
présent dans sa configuration. `owner recover` ne change jamais la politique OIDC ;
`owner release` libère uniquement les identifiants locaux. Aucun compte de secours
ni mot de passe par défaut n'est créé. Les commandes utilisent le même volume SQLite
et les mêmes droits que le serveur ; sous Docker, utiliser `compose run --rm` après arrêt.
