# Sécurité — authentification Web

## Périmètre

Sillage possède un propriétaire unique et une bibliothèque unique. L'identité applicative
est distincte de son moyen de connexion. Les connexions locales et OIDC utilisent les mêmes sessions Web. Aucun compte public, rôle, tenant ou lien
de propriété n'est ajouté aux vidéos et notes existantes.

A3.2 fournit les politiques explicites `local`, `both` et `oidc`, avec une association
externe déclarative. Les autorités et procédures de récupération sont décrites dans
[Configuration](configuration.md). L'administration Web et l'association interactive
restent réservées à A3.3 ; aucune confiance dans un proxy n’est ajoutée.

MCP peut être activé avec une clé Bearer obligatoire. L'administration Web des clés,
leur indépendance vis-à-vis d'OIDC et la récupération de sécurité sont décrites dans
[Clés API](api-keys.md). REST conserve exclusivement les sessions et le CSRF.

## Provisionnement et autorité

A3.1 ajoute une [configuration déclarative locale](configuration.md) : première
installation automatique, bootstrap ou gestion permanente du secret, adoption explicite
des installations existantes et rotations transactionnelles. La déclaration ne modifie
pas la bibliothèque unique ni les contrats de session ci-dessous.

## Première installation et récupération locales

Toutes les commandes utilisent `data/sillage.db` relativement au répertoire courant.
Lancer les commandes d'administration **serveur arrêté**, avec le même répertoire de
travail et les mêmes droits d'accès que le serveur. Les commandes interactives restent
disponibles pour l'administration locale ; le démarrage déclaratif lit le secret depuis
un fichier. Aucun secret n'est accepté dans les arguments ou les variables d'environnement.

Installation native, après `make build` :

```bash
./bin/sillage owner init
make run
```

La commande exige un terminal interactif. Elle demande l'identifiant, puis deux saisies
masquées du mot de passe. L'identifiant contient 1 à 128 octets, sans espaces de bord,
retour à la ligne ou caractère nul. Le mot de passe contient au moins 15 caractères
Unicode et au plus 1024 octets UTF-8. Il n'est ni tronqué ni normalisé.
Une initialisation répétée est refusée et ne remplace jamais le compte.

Docker, après configuration du répertoire de données et des UID/GID :

```bash
docker compose -f deployments/docker/compose.yaml build
docker compose -f deployments/docker/compose.yaml run --rm sillage owner init
docker compose -f deployments/docker/compose.yaml up -d
```

Ne pas utiliser `-T` : le terminal est nécessaire à la saisie masquée.
Les UID/GID règlent les droits Linux ; ils ne sont pas des identifiants applicatifs.

Récupération native : arrêter le serveur, puis lancer `./bin/sillage owner recover`.
Sous Docker :

```bash
docker compose -f deployments/docker/compose.yaml stop
docker compose -f deployments/docker/compose.yaml run --rm sillage owner recover
docker compose -f deployments/docker/compose.yaml up -d
```

La récupération conserve l'identifiant et la bibliothèque, remplace le mot de passe et
révoque toutes les sessions dans une seule transaction. Elle invalide également une
connexion qui aurait vérifié l'ancien mot de passe avant cette transaction.
Il n'existe pas de récupération par courriel ni de modification du mot de passe dans
le Web dans cette tranche. Un administrateur de l'hôte peut récupérer l'accès. En mode déclaratif, modifier la source
de configuration et redémarrer ; `owner recover` ne contourne pas cette autorité. La commande
`owner release` permet un retour explicite au mode local, serveur arrêté.

Un serveur sans propriétaire ni provisionnement valide refuse de démarrer. Sur une installation existante,
initialiser le propriétaire rattache l'accès à la bibliothèque conservée, sans réécriture
des connaissances. Sauvegarder avant de migrer, comme pour toute évolution du schéma.
Une sauvegarde contient aussi les anciennes sessions. Après restauration, les invalider
par `owner recover` en mode local ou par une rotation déclarative avant ouverture.

## Configuration et frontière réseau

| Variable | Défaut | Contrat |
| --- | --- | --- |
| `SILLAGE_PUBLIC_URL` | `http://127.0.0.1:PORT` | Origine canonique, sans chemin, query, fragment ou identifiants |
| `SILLAGE_SESSION_LIFETIME` | `12h` | Durée absolue des nouvelles sessions |
| `SILLAGE_SESSION_IDLE_TIMEOUT` | `1h` | Délai sans requête privée authentifiée |

Les durées acceptent la notation Go, entre `1m` et `720h`. Le délai d'inactivité
ne peut pas dépasser la durée absolue. Douze heures couvrent une journée d'utilisation
sans rendre la session indéfinie ; une heure d'inactivité ferme les sessions abandonnées.
La sonde `GET /api/v1/auth/session` ne renouvelle jamais l’activité : un onglet
visible sans autre requête peut donc expirer. Les autres lectures et pollings privés
comptent comme activité HTTP, pas comme preuve de présence humaine. Modifier la durée absolue concerne les nouvelles sessions ;
modifier le délai d'inactivité s'applique aux vérifications suivantes.

Compose calcule l'origine locale à partir de `SILLAGE_PORT`. Avec Vite :

```bash
make dev-api
# Autre terminal :
make web-dev
```

Utiliser exactement l'hôte et le port configurés dans le navigateur. Host doit correspondre
à l'autorité configurée. Les en-têtes Forwarded et X-Forwarded-* ne font pas autorité.
Le serveur accepte un déploiement avec une origine HTTPS configurée, mais ne termine pas
TLS lui-même. Les certificats, le reverse proxy et l'exposition réseau relèvent de la
tranche homelab. La distribution actuelle reste publiée sur loopback ; l'authentification
ne suffit pas à rendre sûre une exposition HTTP en clair sur le réseau.

## Identifiants et sessions

Le secret local utilise Argon2id : 19 Mio, deux passes, parallélisme 1, sel aléatoire
de 16 octets et résultat de 32 octets. Les paramètres sont fixes et vérifiés avant
hachage, pour borner le coût en cas de vérificateur corrompu.

Chaque connexion produit un jeton opaque aléatoire avec `crypto/rand`. Seule son empreinte
SHA-256 est persistée. La session inclut sa génération de propriétaire et ses échéances ;
l'ID token du fournisseur ne sera pas une session Web.

La connexion remplace la session précédente de ce navigateur. Les sessions survivent au
redémarrage, tant que leurs échéances restent valides. Chaque nouvelle requête privée
vérifie la session dans SQLite. Les mises à jour d'activité sont espacées d'au plus une
minute (ou un quart du délai d'inactivité). Les sessions dépassant la durée absolue sont
supprimées lors des connexions suivantes.

Le menu Navigation > Session propose une déconnexion du navigateur et une révocation de
toutes les sessions. Les révocations sont définitives pour les nouvelles requêtes.
Une opération média déjà acceptée conserve son cycle applicatif ; un transfert commencé
ou des octets déjà reçus ne sont pas repris au client.

Cookies : `HttpOnly`, `SameSite=Lax`, `Path=/`, sans Domain ; `Secure` lorsque l'origine
configurée est HTTPS. Dans ce cas les noms utilisent le préfixe `__Host-`.
Le mode HTTP loopback utilise des cookies sans Secure. Le navigateur conserve le cookie
jusqu'à l'échéance absolue ; le serveur reste l'autorité pour l'expiration et la révocation.

## Routes, CSRF et diagnostics

Le shell SPA et ses fichiers statiques sont publics, sans données de bibliothèque.
Toutes les routes `/api` et `/api/*` sont protégées, à l'exception des points d'entrée
explicites de connexion. Cela inclut recherche, notes, tags, métadonnées, opérations,
images et médias, avec HEAD, Range et requêtes conditionnelles.

| Route | Comportement |
| --- | --- |
| `GET /api/v1/auth/session` | État authentifié ou anonyme, jeton CSRF et échéance ; aucune connaissance privée |
| `POST /api/v1/auth/login` | JSON strict `username`/`password`, connexion locale |
| `POST /api/v1/auth/logout` | Révocation de la session courante |
| `POST /api/v1/auth/logout-all` | Révocation de toutes les sessions |

Les mutations exigent `X-CSRF-Token`, lié au cookie courant et obtenu par le GET de session.
Le jeton CSRF n'est pas un identifiant de session. Les connexions anonymes utilisent un
cookie préalable signé, valable dix minutes et sans stockage SQLite. Il est supprimé à
la connexion. Une origine présente doit correspondre exactement à l'origine configurée ;
les requêtes annoncées cross-site sont refusées. Aucune mutation métier n'utilise GET.

Une session absente ou expirée produit un 401 JSON `authentication_required`, avant tout
handler métier. Une protection CSRF invalide produit 403 `csrf_invalid`. Une panne de
stockage produit 503 `authentication_unavailable`, sans accès aux données. L'API ne
redirige jamais une requête privée vers du HTML. Les réponses privées imposent
`Cache-Control: no-store, private`.

La connexion borne son JSON à 8 Kio, autorise au plus deux calculs Argon2 simultanés et
limite globalement les tentatives à deux par seconde avec une réserve de dix.
Un refus de capacité/fréquence produit 429 et Retry-After. Un identifiant incorrect
effectue le même calcul qu'un mot de passe incorrect. Ces limites sont globales à
l'instance, sans confiance dans une IP fournie par un proxy.

Les logs conservent les catégories et corrélations existantes, jamais les mots de passe,
cookies, jetons CSRF, corps JSON ou URLs brutes. Les en-têtes nosniff, Referrer-Policy
same-origin et une CSP limitée à frame-ancestors/base-uri/object-src complètent la frontière.
Cette CSP n'est pas une politique exhaustive de scripts et de ressources.

## Continuité de l'éditeur

Le frontend charge les données privées après confirmation de la session. Une expiration,
révocation ou indisponibilité suspend les accès sans démonter l'application déjà ouverte.
La modale masque et rend inerte le contenu existant ; l'instance CodeMirror, sa sélection,
Undo/Redo, le brouillon, la révision et le conflit restent en mémoire.

Le contrôle partagé fournit le CSRF et reconnaît les refus d'accès. Il ne rejoue aucune
mutation. L'autosauvegarde suspend ses temporisations et reprend après confirmation de la nouvelle session,
sans redirection ni rechargement. Une écriture précédemment incertaine doit être relue
et réconciliée ; une connexion réussie n'efface pas un conflit et n'autorise pas une
nouvelle révision. Les autres commandes restent des gestes explicites.

Les onglets se notifient les changements de connexion, puis vérifient le serveur ;
aucun cookie n'est transmis par ce canal. Une déconnexion volontaire demande une
confirmation avant d'abandonner le brouillon non confirmé de l'onglet courant.
Les autres onglets se verrouillent en conservant leur brouillon.

L'état est uniquement en mémoire : fermeture, rechargement ou crash du navigateur
peuvent le perdre. Le garde de départ existant reste actif pour les notes non confirmées.
Un verrou visuel n'efface pas des données déjà transmises au navigateur.

## Architecture et validation

- `internal/auth` : identité, hachage, émission et révocation des sessions.
- `internal/adapter/sqlite/auth_repository.go` : unicité, générations et transactions.
- `internal/http/auth.go` : frontière HTTP globale, cookies et CSRF.
- `cmd/server/owner.go` : administration interactive.
- `web/src/auth.ts`, `AuthGate.tsx`, `noteSession.ts` : état d'accès et continuité.

Les tests Go utilisent SQLite réel pour la persistance, les expirations, la révocation,
la récupération et les connexions concurrentes à un changement de génération.
Les tests HTTP vérifient les accès anonymes, cookies HTTPS, origines, CSRF et erreurs de
stockage. Playwright exerce connexion réelle, sauvegarde réelle après révocation, état
CodeMirror, conflits, réponses perdues et plusieurs onglets. Les recettes Docker et
Postman initialisent une identité synthétique par la vraie commande interactive.
Elles n'ajoutent aucun mode sans authentification au binaire.

## Parcours OIDC

L'adapter OIDC utilise `go-oidc` et `oauth2` : Code + PKCE S256, validation des signatures,
issuer, audience, azp, échéance, date d'émission et nonce. L'autorisation compare ensuite
le couple exact `(issuer, subject)` déclaré. Aucun rapprochement par e-mail n'est permis.
Les ID/access tokens sont utilisés uniquement pendant l'échange, sans stockage durable
ni demande de refresh token. Les diagnostics externes sont remplacés par des catégories sûres.

`POST /api/v1/auth/oidc/start` exige le CSRF de Sillage ; il retourne l'URL du fournisseur.
`GET /api/v1/auth/oidc/callback` est une exception publique étroite au filtrage REST et
à la vérification d'origine : une transaction liée au navigateur remplace le CSRF habituel.
State, nonce et vérificateur PKCE sont aléatoires ; la transaction expire après dix minutes,
est consommée une seule fois et sa génération est contrôlée lors de l'émission de session.
Le nombre de transactions est borné. Aucun paramètre de destination arbitraire n'est accepté.
Une déconnexion annule les transactions du navigateur, y compris pendant un échange réseau ;
la révocation globale invalide également les générations antérieures.

La première connexion commence sur un bouton explicite. Pendant une édition, une fenêtre
secondaire protège l'onglet courant ; si elle est bloquée, un lien ouvre un autre onglet.
Le retour notifie les autres onglets, qui relisent la session sur le serveur ; le focus
et la sonde périodique constituent aussi un repli. Une notification seule ne déverrouille
jamais l'application. La réconciliation des écritures incertaines reste obligatoire.
La déconnexion est locale à Sillage : aucune déconnexion fournisseur, aucune reconnexion
SSO automatique. Fermer ou recharger l'onglet éditeur reste susceptible de perdre son état.
