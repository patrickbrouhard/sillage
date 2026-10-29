# Recette locale Sillage + Authelia

Recette ponctuelle WSL, hors CI, sans Traefik ni modification du homelab.
Le moteur Docker est explicitement `unix:///var/run/docker.sock` : les contextes distants
et variables Docker de la session ne sont pas utilisés. Projet Compose :
`sillage-oidc-recipe`. Ports publiés sur loopback uniquement : 9091 et 18082.
Ne pas lancer plusieurs exemplaires simultanés. Un port occupé provoque un échec ;
aucun service existant n'est arrêté automatiquement.

## Préparer et ouvrir

Prérequis : WSLg, Python 3, OpenSSL, Docker avec Compose, Chromium installé par
Playwright pour ce dépôt (`cd web && npx playwright install chromium` si nécessaire).
Exécuter depuis la racine du dépôt, dans WSL :

```sh
python3 tests/manual/oidc/lab.py prepare
python3 tests/manual/oidc/lab.py up
python3 tests/manual/oidc/lab.py browser
```

`prepare` refuse de remplacer une recette existante. `up` construit Sillage depuis
la branche courante. Les deux services sont Sillage et Authelia 4.39.19 ; ce dernier
utilise directement TLS, un backend utilisateurs fichier et SQLite. Aucune infrastructure
Redis, LDAP, SMTP ou de proxy n'est nécessaire.

Tous les éléments générés vivent dans `tests/manual/oidc/.runtime/`, ignoré par Git et
créé avec des permissions privées : clés, certificats, mots de passe, configurations,
SQLite, profil Chromium et éventuels diagnostics d'échec. Ne pas publier ce répertoire,
les traces réseau du navigateur ou les URLs de callback contenant un code.
Les mots de passe aléatoires des comptes `owner` et `other` se trouvent dans
`.runtime/credentials.json`. Aucun mot de passe n'est passé en argument CLI.

Authelia est accessible à `https://auth.sillage.test:9091`. Son nom est résolu par
un alias du réseau Compose côté Sillage et une règle du seul Chromium de recette.
Aucun fichier hosts n'est modifié. Le certificat de 30 jours est signé par une CA privée :
Sillage utilise `SSL_CERT_FILE` ; Chromium utilise un magasin NSS sous son HOME isolé.
Un conteneur Debian jetable fournit `certutil`, sans installation sur WSL. Aucune exception
TLS, aucun `ignoreHTTPSErrors` et aucune désactivation du sandbox navigateur ne sont utilisés.
Le navigateur habituel ne connaîtra donc pas cette CA : utiliser celui ouvert par le script.

Sillage utilise `http://localhost:18082` pour sa callback loopback ; cela ne valide pas
un futur déploiement HTTPS de Sillage. L'issuer Authelia, la découverte, les clés JWKS
et l'échange du code sont bien en HTTPS vérifié. Le propriétaire n'a aucun mot de passe
local ; la politique est `oidc`. Son subject est précréé avec la commande officielle
`authelia storage user identifiers add`, sans rapprochement par e-mail.

## Quatre scénarios

1. **Première connexion et identité.** Cliquer « Se connecter avec le SSO », utiliser
   `owner`, accepter le consentement, vérifier l'accès à la bibliothèque. Se déconnecter
   de Sillage puis d'Authelia (ouvrir son portail), refaire le parcours avec `other` :
   Sillage doit refuser l'accès. Revenir avec `owner`. Il n'y a pas de formulaire local.
2. **Réauthentification en édition.** Créer une vidéo de test et ouvrir sa note. Saisir
   du texte, sélectionner un passage et attendre le verrouillage (inactivité Sillage :
   une minute ; éviter lectures ou opérations média qui entretiennent l'activité).
   Le SSO doit s'ouvrir dans une fenêtre secondaire. Revenir au même éditeur, vérifier
   texte, sélection, Undo, Redo et sauvegarde. Répéter après déconnexion du portail
   Authelia pour imposer la saisie des identifiants. En cas de fenêtre bloquée, utiliser
   le lien proposé, puis revenir à l'onglet d'origine sans le recharger. Ne pas conclure
   à la préservation d'un brouillon non confirmé si tout était déjà sauvegardé : pour
   ce cas, passer temporairement le navigateur hors ligne, modifier la note, attendre
   l'expiration, rétablir le réseau et effectuer la reconnexion.
3. **Déconnexion volontaire.** Quitter Sillage par son menu Session. L'écran de connexion
   doit rester affiché, sans relance du SSO. Cliquer ensuite explicitement sur le bouton :
   une session Authelia encore active doit éviter une nouvelle saisie du mot de passe.
4. **Fournisseur indisponible.** Avec une session Sillage valide, arrêter Authelia puis
   redémarrer Sillage avec les commandes ci-dessous. Vérifier immédiatement les accès
   privés avant expiration. Une nouvelle connexion SSO doit échouer sans offrir de
   connexion locale. Relancer Authelia, puis vérifier que la connexion redevient possible.

Commandes ciblées pour le scénario 4 (même moteur et projet que le script) :

```sh
docker --host unix:///var/run/docker.sock compose -p sillage-oidc-recipe -f tests/manual/oidc/.runtime/compose.json stop authelia
docker --host unix:///var/run/docker.sock compose -p sillage-oidc-recipe -f tests/manual/oidc/.runtime/compose.json restart sillage
docker --host unix:///var/run/docker.sock compose -p sillage-oidc-recipe -f tests/manual/oidc/.runtime/compose.json start authelia
```

Pour ne pas confondre panne et expiration pendant ce scénario, régler au préalable
`SILLAGE_SESSION_IDLE_TIMEOUT` à `10m` dans `.runtime/compose.json`, puis exécuter `up`.
La récupération administrative et les transitions de politique restent documentées dans
[la référence configuration](../../../docs/configuration.md) et couvertes par les tests automatisés.

## Arrêt et suppression

Fermer le Chromium de recette avant nettoyage.

```sh
# Arrêter et retirer conteneurs et réseau ; conserver secrets et données pour reprendre.
python3 tests/manual/oidc/lab.py down
# Supprimer également toutes les données locales et le profil dédié.
python3 tests/manual/oidc/lab.py clean
```

Les images Docker restent en cache. On peut supprimer explicitement l'image dédiée
`sillage:oidc-recipe` ; ne pas utiliser de prune global. Les images Authelia et Debian
peuvent être partagées par d'autres tâches. Après 30 jours, recréer la recette pour renouveler
ses certificats. Aucun certificat n'a besoin d'être désinstallé de Windows ou de WSL.

Références : [TLS natif Authelia](https://www.authelia.com/configuration/miscellaneous/server/),
[cookies de session](https://www.authelia.com/configuration/session/introduction/).
