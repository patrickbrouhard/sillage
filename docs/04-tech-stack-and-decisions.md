# Tech stack & decisions — Sillage

Ce document réunit les **choix techniques actuellement applicables** et les orientations architecturales déjà retenues. Il explique leur portée et leurs limites ; il ne retrace ni les jalons de développement ni les validations successives.

Statuts utilisés : **acté et implémenté**, **orientation privilégiée** (non encore livrée), **ouvert** (décision à prendre). Les possibilités futures ne sont pas des exigences pour le code actuel.

Documents complémentaires :

- [Vision du produit](00-project-brief.md) et [comportements UX](01-product-and-ux.md).
- [Modèle métier](02-domain-model.md) et [architecture, API et contrats d'intégration](03-architecture.md).
- [Roadmap](05-roadmap.md), [questions ouvertes](06-open-questions.md) et [recette manuelle du lecteur](07-local-playback-validation.md).
- [Historique de certains arbitrages](history/sillage-decisions-octobre-2026.md).

**Principe de lecture :** les spécifications métier appartiennent prioritairement au document 02, les parcours utilisateur au document 01 et les contrats détaillés des services/adapters/REST au document 03. Le présent document explique **les technologies choisies et les règles techniques à préserver**. En cas de divergence, vérifier le code avant de modifier la documentation : une description ancienne n'a pas autorité sur une implémentation plus récente.

## 1. Synthèse des choix

| Domaine | Choix actuel | État |
| --- | --- | --- |
| Backend | Go ; bibliothèque standard et packages ciblés | Acté et implémenté |
| HTTP | `net/http` + Chi ; API REST | Acté et implémenté |
| Persistance | SQLite via `database/sql` et `modernc.org/sqlite`, sans ORM | Acté et implémenté |
| Identifiants | Entiers SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` lorsque l'entité possède un ID propre | Acté et implémenté |
| Migrations | SQL embarqué (`embed.FS`), `PRAGMA user_version`, évolutions forward-only | Acté et implémenté |
| Dates | `TEXT` en UTC, RFC 3339 avec millisecondes fixes | Acté et implémenté |
| Positions média | Entiers en millisecondes | Acté et implémenté |
| Métadonnées YouTube | `yt-dlp` exécuté comme outil externe via adapter | Acté et implémenté |
| Transcriptions | Captions automatiques originales admissibles, JSON3 conservé en snapshot ; pas de fragments en SQLite | Acté et implémenté |
| Traitement vidéo | `ffmpeg` / `ffprobe` | Acté et implémenté |
| Frontend | React, TypeScript, Vite ; SPA sans SSR | Acté et implémenté |
| Édition | CodeMirror 6 ; Markdown source, lecture GFM sécurisée | Acté et implémenté |
| Lecteurs | IFrame Player API YouTube + `<video>` HTML5 natif, sans bibliothèque de lecteur | Acté et implémenté |
| Distribution | Docker multi-stage, frontend statique servi par Go, dépendances externes épinglées | Acté et implémenté |
| Journalisation | `log/slog`, sortie standard, texte local ou JSON en Docker, rotation Docker | Acté et implémenté |
| Recherche globale | SQLite FTS5, projection transactionnelle par vidéo | Acté et implémenté |
| MCP | Serveur Go s'appuyant directement sur les services applicatifs ; SDK Go officiel privilégié | Architecture envisagée, non livrée |
| IA / STT | Fournisseurs et moteurs à choisir ; pas de dépendance du domaine à un fournisseur | Ouvert |
| Desktop | Éventuelle application Wails, sans engagement | Ouvert |
| WAL, sauvegarde avancée, framework de migrations | À évaluer selon les besoins réels | Ouvert |

## 2. Backend Go et interfaces

### 2.1 Go, dépendances et frontières

Go est le langage du backend. Les services métier restent indépendants de Chi, SQLite, des détails CLI de `yt-dlp`, de `ffmpeg` et des bibliothèques d'interface. Utiliser des interfaces/ports correspondant à des besoins concrets, sans repository générique ni framework applicatif disproportionné.

- Préférer la bibliothèque standard, puis des dépendances ciblées et justifiées.
- Garder les adaptateurs responsables de la traduction entre demandes métier, processus externes, SQL et HTTP.
- Propager `context.Context` lors des opérations susceptibles d'être annulées ou interrompues.
- Ne pas introduire microservices, message broker, Redis ou queue distribuée sans besoin avéré.

### 2.2 REST : `net/http` et Chi

Le routeur Chi complète `net/http`, sans imposer de modèle métier ni de DTO au domaine. Les réponses HTTP utilisent leurs propres représentations ; les erreurs techniques sont transformées en codes publics stables, sans analyser des chaînes arbitraires de `stderr`.

Principes en vigueur :

- API `/api/v1` ; ajout YouTube synchrone et idempotent sur l'identité `(provider, external_id)` : création `201`, source connue `200` sans rafraîchissement implicite.
- Corps JSON stricts et bornés ; types MIME et timeouts vérifiés ; délais et annulations propagés.
- Listes et détails exposent des DTO stables ; les contrats précis, routes, enveloppes, statuts et erreurs figurent dans le [README](../README.md) et dans l'[architecture](03-architecture.md).
- Les notes utilisent une révision attendue obligatoire pour leurs écritures, avec réponse `409` en cas de conflit.
- Les tags partagent le même catalogue ; leurs associations sont explicites et les résultats du catalogue conservent l'ordre d'ID défini.
- Depuis les publishers/personnes, `creator` n'est plus un champ REST : les sources exposent un `publisher` nullable et les vidéos leurs `person_ids` directs. Ne pas rétablir un alias historique par accident.
- Les API de récupération de transcription ne contactent pas YouTube lors d'un GET : toute acquisition est déclenchée explicitement.

L'application vise actuellement un usage local : ne pas déduire de l'absence d'authentification actuelle que l'API serait prête à être exposée publiquement. Pagination, permissions et authentification restent à cadrer.

### 2.3 MCP et IA : frontières futures

Le futur MCP doit appeler les **services applicatifs directement**, sans requêtes HTTP vers la propre API du serveur lorsque les deux interfaces résident dans le même processus :

```text
REST ──┐
       ├── Application services ── Domain / ports / adapters
MCP ──┘
```

Le SDK MCP Go officiel est la piste privilégiée. Les outils, permissions, ressources, confirmations et transport restent à décider. Les fonctions IA et STT devront également rester derrière des abstractions ciblées : ni le domaine ni l'usage manuel ne doivent dépendre d'OpenAI, d'Ollama ou d'un autre fournisseur particulier. Voir [Open questions](06-open-questions.md).

## 3. SQLite et modèle persistant

### 3.1 Base et driver

SQLite est la base principale d'une application personnelle ou à faible concurrence : données relationnelles, transactions locales et déploiement sans serveur de BDD séparé. `modernc.org/sqlite` est utilisé avec `database/sql`, **sans CGO et sans ORM**. PostgreSQL/MySQL ne sont pas prévus sans justification nouvelle.

La base persiste sous le répertoire de données, aux côtés des fichiers médias, assets et snapshots. **La suppression d'une référence SQL ne donne pas, à elle seule, le droit de supprimer un fichier présent sur disque.** Les workflows de conservation et les procédures de nettoyage sont distincts.

### 3.2 Identités, contraintes et associations

- `Video` et `VideoSource` possèdent un ID interne entier stable, indépendant des identifiants externes ; pour YouTube, `(provider, external_id)` représente l'identité de source et doit rester unique.
- Pour les entités dotées d'une identité propre, `INTEGER PRIMARY KEY AUTOINCREMENT` empêche la réattribution d'anciens ID. `Note` utilise `video_id` comme clé primaire ; pas d'ID de note supplémentaire.
- `VideoSource` et `Publisher` occupent des espaces d'identité différents. Une chaîne identifiée n'est pas une personne ; les relations sont explicites, sans propagation implicite.
- Les associations vidéo–personne et entité–tag utilisent des tables relationnelles et des contraintes d'unicité/référence. Les identités provider/external_id des publishers sont immuables selon leurs contraintes actuelles.
- Les titres de source, données utilisateur, représentations médias et transcriptions ont des cycles de vie distincts. Ne pas créer des colonnes « au cas où » (`title_override`, soft delete, schémas de jobs génériques, etc.) sans décision métier.

Le schéma effectif et ses contraintes sont définis dans les **migrations SQL**, pas dans la reproduction d'une ancienne migration au sein de cette documentation.

### 3.3 Migrations

Les migrations sont des fichiers SQL versionnés embarqués avec `embed.FS`. Le runner les applique dans l'ordre, dans des transactions, suit leur version par `PRAGMA user_version` et refuse une base dont le schéma est plus récent que le binaire.

- Migrations **forward-only** ; ne pas modifier rétrospectivement une migration déjà diffusée pour changer le schéma courant.
- Les données et identités utilisateur doivent être préservées lors des évolutions.
- La migration d'introduction des publishers/personnes a sauvegardé les anciennes bases par `VACUUM INTO` avant modification ; elle n'a **pas** rapproché les anciens noms `creator` des nouveaux publishers. Cette protection reste pertinente pour toute évolution destructrice.
- Le petit runner existant est conservé tant qu'un outil comme Goose n'apporte pas d'avantage concret.
- La stratégie générale de sauvegarde/restauration, l'évolution du runner et les migrations de bases de grande taille restent à étudier.

### 3.4 Configuration et concurrence

Les clés étrangères sont activées sur les connexions SQLite ; un `busy_timeout` d'environ cinq secondes absorbe les contentions brèves. **WAL n'est pas une décision actée.** Toute évolution de concurrence doit être justifiée, testée et compatible avec les garanties transactionnelles de sauvegarde et de publication.

Les modifications conditionnelles des notes utilisent une **révision entière** et une précondition atomique, y compris lors de la création ; aucune « dernière écriture gagnante » implicite ne doit écraser le contenu d'un autre client. Les créations de tags et leurs associations sont transactionnelles, même en concurrence.

### 3.5 Notes : texte et horodatages

- Stocker le **Markdown brut en `TEXT`**, sans représentation HTML persistée.
- Normaliser uniquement les fins de ligne CRLF/CR en **LF** lors d'une écriture ; ne pas migrer ni réécrire silencieusement les notes à la lecture.
- Distinguer note absente et note enregistrée vide. Une sauvegarde identique ne modifie pas les horodatages ni la révision.
- Les dates calendaires sont représentées en Go par `time.Time` et persistées en SQLite en `TEXT` UTC RFC 3339 avec exactement trois décimales de millisecondes (`YYYY-MM-DDTHH:MM:SS.mmmZ`). Les services produisent les dates, pas des valeurs SQL par défaut implicites.
- Les durées et positions au sein d'un média sont des `INTEGER` en **millisecondes**, jamais des timestamps calendaires.

### 3.6 Tags : identité Unicode

Un tag est identifié après suppression des espaces aux extrémités, normalisation Unicode **NFC** et repli complet de casse insensible à la locale. Les accents sont significatifs ; ni NFKC, ni suppression d'accents, ni rapprochement sémantique.

L'implémentation utilise `golang.org/x/text` et une `identity_key` unique en SQL ; la casse d'affichage initiale est conservée. Ainsi `DevOps` et `devops` sont identiques, mais `Café` et `Cafe` sont distincts ; le repli peut aussi rapprocher `Straße` et `STRASSE`. Une modification future de l'algorithme doit vérifier **les collisions possibles entre tags déjà persistés**.

Les tags inutilisés demeurent dans le catalogue. Les associations avec vidéos, publishers et personnes ne s'héritent pas ; leurs ajouts multiples et retraits respectent transactions et unicité.

### 3.7 Recherche globale

SQLite FTS5 permet une recherche locale sans service externe et une projection cohérente avec les transactions métier. Le texte des notes est dérivé avec Goldmark/GFM, sans modifier le Markdown original. Cette recherche lexicale n'introduit ni embeddings ni infrastructure supplémentaire.

La [référence technique de recherche](search.md) porte la configuration du tokenizer, les limites Unicode, l'extraction, les pondérations et le cycle de vie de la projection.

## 4. `yt-dlp` : sources et métadonnées

### 4.1 Intégration par processus externe

Sillage exécute **le binaire `yt-dlp`** via un adapter Go, sans coupler le domaine au code Python ni aux options CLI. L'adapter normalise les métadonnées reconnues ; les processus disposent de délais, d'annulation et de limites sur leurs sorties.

La source de données durable contient uniquement les champs métier utiles, **pas de `raw_metadata` permanent**. Une redécouverte ponctuelle n'implique pas de rafraîchissement automatique des informations utilisateur.

Pour YouTube, `external_id` et `canonical_url` sont requis par les opérations applicatives. Un publisher n'est créé/réutilisé que si son **`channel_id`** est fiable ; noms, handles et libellés ne sont pas des identifiants de rapprochement.

La résolution d'une URL de chaîne s'effectue au moyen de `yt-dlp` sans télécharger les vidéos ni parcourir toute la liste. Les URLs de chaînes sont normalisées et l'identité `YoutubeTab` validée. Les plafonds précis des sorties et paramètres de l'extracteur sont des contraintes d'adapter, révisables sans changer cette règle métier.

### 4.2 Langue audio et métadonnées

La langue audio originale d'une `VideoSource` et la langue du **fichier effectivement téléchargé** sont deux informations différentes.

- À la découverte d'une vidéo, les signaux audio explicites permettent éventuellement d'identifier une langue originale ; les captions ne doivent jamais être utilisées pour la déduire.
- Une langue absente, contradictoire ou non fiable peut rester inconnue.
- Le champ `audio_language` d'un `MediaFile` provient de la représentation audio sélectionnée par `yt-dlp` (format audio demandé ou format combiné), **pas** de `ffprobe`, du champ global agrégé ou de `VideoSource.original_audio_language`.
- Il est nullable, et une langue différente de la transcription ne constitue pas une erreur.
- Codec audio/vidéo, dimensions et cadence moyenne sont obtenus par `ffprobe` ; les attributs inconnus restent `NULL`, sans valeurs fabriquées ni réanalyse automatique des anciens fichiers.

## 5. Transcriptions YouTube et JSON3

### 5.1 Acquisition et sélection actuelle

Le parcours en place acquiert **les captions automatiques originales admissibles** d'une source YouTube en JSON3. L'identité de transcription est `(video_source_id, language, provenance)` avec provenance `youtube_auto`. Il n'existe ni sélection manuelle de piste, ni STT, ni catalogue persistant de pistes.

La sélection suit cet ordre :

1. Utiliser la clé `*-orig` admissible correspondant exactement à la langue audio originale enregistrée, lorsqu'elle est fiable.
2. Pour une étiquette simple `langue-région` (région de deux lettres ou trois chiffres), essayer la clé originale générique correspondante ; ne pas simplifier arbitrairement les écritures, variantes et autres étiquettes complexes.
3. À défaut, accepter une **unique** piste originale admissible, même dans une autre langue. En l'absence de candidat : `404 transcript_not_available`. Si plusieurs pistes restent ambiguës : `409 transcript_selection_ambiguous`.

Une piste admissible possède une langue exploitable et une variante JSON3 récupérable par URL HTTPS valide. Plusieurs formats d'une même clé ne comptent pas comme plusieurs langues candidates. La redécouverte de la langue audio au cours de l'acquisition **ne départage pas** les pistes.

Le marqueur YouTube `-orig` peut concerner l'audio doublé. La sélection privilégie donc la piste correspondant probablement à l'original, **sans en garantir l'identité acoustique**. L'UI affiche « Transcription automatique » plutôt que « Automatique originale ».

### 5.2 Format, snapshots et consultation

- Conserver le **JSON3 source** complet de chaque acquisition réussie ; ne pas créer de format propriétaire, de table mot-à-mot ni de texte brut persisté par défaut.
- Parser et valider l'ensemble du JSON3 avant de publier un nouveau snapshot ; le document source est borné à la taille admise par l'adapter (16 Mio actuellement).
- Publier sous un nom de fichier unique, puis référencer le chemin depuis SQLite. Un échec d'acquisition préserve le contenu déjà publié ; les anciens snapshots peuvent rester sur disque pour protéger les lectures concurrentes.
- Les URLs directes des captions sont temporaires et **ne sont pas stockées durablement** ; un nouvel appel d'acquisition les redécouvre.
- Le GET est **exclusivement local**. Il ne relance ni `yt-dlp` ni un POST en cas de snapshot manquant. Le POST lance explicitement une acquisition/actualisation.
- Le texte brut et les regroupements utiles à la présentation ou à la recherche sont **dérivés en mémoire** des fragments existants.

La rétention durable, le nettoyage des snapshots devenus orphelins, leur emplacement configurable et l'éventuelle sélection d'autres langues restent [ouverts](06-open-questions.md). Réviser explicitement le contrat de consultation avant d'adopter une politique de cache supprimable.

## 6. Téléchargement et conservation des médias

### 6.1 Représentation et politique de téléchargement

Télécharger une vidéo ne crée **ni nouvelle `Video` ni nouvelle `VideoSource`**. L'opération conserve un `MediaFile` associé à la source de travail ; la provenance YouTube est obligatoire pour cette acquisition.

L'acquisition concerne une vidéo YouTube terminée : **une invocation native `yt-dlp`**, sélection `bv*+ba/b` et classement `-S res:1080` (sans `--format-sort-force`). C'est une préférence de résolution, pas un plafond strict. Les critères natifs de l'extracteur continuent à s'appliquer.

- Aucun filtrage maison des codecs, des conteneurs ou de la langue audio originale ; les fichiers peuvent être MP4, WebM, MKV ou un autre conteneur admissible.
- Vidéo et audio sont conservés sans réencodage ou changement volontaire de timeline. La présence d'un fichier ne garantit pas sa lecture par tous les navigateurs.
- Configurations utilisateur `yt-dlp` ignorées pour garder le comportement reproductible ; identité YouTube et statut du média vérifiés avant le transfert.
- Réessais de transfert bornés ; pas de retry applicatif implicite après un échec déclaré, ni d'acquisition de playlist.
- Le résultat complet est inspecté par **`ffprobe` avant publication** : conteneur reconnu, pistes attendues, codecs identifiés, dimensions positives, fichier réel, durée cohérente. Une sortie ambiguë ou partielle n'est pas publiée comme média disponible.
- La comparaison de durée tolère `max(1 s, min(3 s, 0,1 % de la référence))` lorsqu'une référence exploitable existe. Il ne s'agit ni d'une somme de contrôle ni d'une preuve de décodage intégral.

Les attributs techniques restent facultatifs lorsque l'outil ne peut pas les établir. Un nom physique sûr et une extension validée protègent les chemins ; ils ne constituent pas une identité métier.

### 6.2 Publication, suppression et incidents

La disponibilité du média est déterminée par la combinaison de sa référence persistée et du fichier réellement accessible. Les états et opérations de téléchargement/suppression sont documentés dans [l'architecture](03-architecture.md).

- Publication protégée par les transactions et étapes de finalisation définies ; ne pas promettre `available` tant qu'une opération est encore active.
- Une interruption ou un commit SQL incertain ne justifie pas la suppression compensatoire de fichiers complets.
- Au démarrage ou après restauration d'une base antérieure, les médias complets non référencés et les temporaires `.pending` / `.deleting` abandonnés **ne sont pas automatiquement effacés**.
- La maintenance de ces fichiers nécessite une opération future explicite d'inventaire, sélection et confirmation, susceptible également de rattacher un média récupérable.
- La suppression volontaire d'un `MediaFile` préserve vidéo, source, transcription, notes, tags et captures ; elle cible l'identité physique exacte et tient compte des lectures/extractions actives.
- Une anomalie du stockage média ne doit pas empêcher l'accès aux connaissances déjà persistées.

Les raisons historiques du choix de la sélection native et de la conservation prudente sont consignées dans [history](history/sillage-decisions-octobre-2026.md).

## 7. Captures PNG : traitement avec `ffmpeg`

### 7.1 Source et extraction

Une capture se rattache à la **source et à la position temporelle demandées**. Le résultat est un `Asset` PNG persistant, sans perte ajoutée ni redimensionnement volontaire.

- Préférer un `MediaFile` complet disponible de la **même `VideoSource`**, avec emprunt protégeant temporairement sa lecture contre une suppression concurrente. Ne jamais substituer une autre source de la vidéo.
- À défaut de média local exploitable, résoudre un flux YouTube temporaire, sans conserver automatiquement la vidéo complète.
- Pour le distant : sélectionner la meilleure résolution exploitable avec `yt-dlp` et classement forcé propre aux captures. À largeur et hauteur identiques, **HTTPS direct précède HLS** ; un HLS de meilleure résolution peut rester prioritaire.
- Transmettre les en-têtes nécessaires au probe et au décodage, **sans stocker ni journaliser** les URLs signées, cookies ou secrets.
- Utiliser un seek précis (`-ss` avec `-accurate_seek`) puis décoder une image, sans `stream copy` ni retour silencieux à la seule image clé antérieure.
- Une capture au-delà de la durée exploitable ou sans frame décodable échoue explicitement. La frame retenue peut être décalée de la cible à cause de la cadence ou d'une représentation distante différente ; **aucune identité pixel à pixel avec l'iframe YouTube n'est promise**.

### 7.2 Couleurs, limites et replis

- Appliquer l'orientation native de `ffmpeg`. Refuser explicitement les pixels non carrés lorsque le rendu correct imposerait une transformation non garantie.
- SDR : sortie RGB24 ; HDR PQ/HLG identifié : conversion BT.709 et tone mapping Hable avec les filtres requis. Un rendu HDR exact ou identique à YouTube n'est pas garanti.
- Bornes de protection en vigueur : 64 Mio pour la sortie du sous-processus, 100 millions de pixels pour la validation PNG et deux minutes pour l'opération entière. Elles font **échouer**, sans redimensionner.
- Un échec lié au seek/démuxage HLS ou un PNG vide peut déclencher **un seul essai HTTPS direct de dimensions strictement identiques**. Aucun déclassement automatique de résolution.
- Un HTTP 403 au probe/décodage peut justifier **un unique renouvellement d'URL** partagé entre tentative initiale et éventuelle alternative ; pas de boucle. Au plus trois résolutions/extractions dans le délai global.
- Les échecs de stockage, les erreurs SQL, les outils manquants et les annulations n'autorisent pas ces replis réseau.

### 7.3 Commande et publication asynchrones

Une capture par instance serveur au maximum, indépendamment du téléchargement, sans queue de jobs générique. La clé de commande UUID fournie au démarrage sert à retrouver l'opération et à gérer une réponse incertaine **sans déclencher une nouvelle extraction sous une autre identité**.

L'asset est publié et référencé durablement ; son cycle de génération `pending/available/failed` reste distinct de la consultation effective du fichier. L'insertion dans CodeMirror ne conserve aucun faux Markdown temporaire et n'efface pas l'asset lors d'un Undo : les détails de session et de rendu relèvent du [document UX](01-product-and-ux.md) et de l'[architecture](03-architecture.md).

Le catalogue Images utilise les PNG existants, chargés paresseusement par pages de 12. Il ne produit pas de
miniatures dérivées : réduction visuelle et réduction du transfert sont distinctes. Une éventuelle politique
de génération, stockage et rétention des miniatures nécessite un cadrage séparé.

## 8. Frontend : React, CodeMirror et lecteurs

### 8.1 Distribution du frontend

La SPA utilise **React + TypeScript + Vite**, sans SSR ni serveur Node permanent en production. Go sert les assets compilés. React Router gère la navigation ; les parcours nécessitant la protection d'une note utilisent les mécanismes de blocage adaptés, y compris l'historique interne.

Les composants d'interface ne doivent pas recréer les identités métier, implémenter une déduplication Unicode alternative ni assimiler des réponses réseau tardives à des états courants. Les associations de tags et de publishers restent sous la responsabilité des services/API.

### 8.2 Éditeur et lecture Markdown

- **CodeMirror 6** intégré directement en Édition ; texte source conservé. Lecture via `react-markdown` et `remark-gfm`, avec HTML brut non exécuté et URLs dangereuses filtrées.
- L'instance et la session de note restent **montées** lors des changements de thème, d'onglet, de mode Édition/Lecture ou de disposition. Conserver sélection, Undo/Redo, brouillon et autosauvegarde.
- Autosauvegarde et révisions conditionnelles appartiennent à la session de note : déclenchement après 2 s d'inactivité ou 20 s de modifications continues, sans requêtes périodiques si rien ne change.
- Les réponses perdues, réessais réseau bornés et conflits doivent préserver le texte local et ne produire ni faux succès ni écrasement inconditionnel.
- La barre contextuelle utilise les tooltips, sélections et transactions de CodeMirror, sans nouvelle
  dépendance. Son validateur réutilise Remark/GFM déjà présent en Lecture pour reconnaître les structures
  voisines, notamment les tableaux ; il ne sérialise pas le document. La grammaire CodeMirror reste CommonMark.
- Les représentations visuelles enrichies reposent sur des **décorations CodeMirror**, non sur une transformation persistée du Markdown. Les callouts `quote`/`quote:tr` utilisent une reconnaissance ciblée ; pas de moteur générique extensible ou de Live Preview complet.
- Les références temporelles canoniques peuvent être compactées ou révélées en Édition ; la copie, la sélection, la composition IME et les gestes d'édition doivent rester sûrs.
- L'activation temporelle en Édition se fait par **Ctrl/Cmd+clic** ou **Ctrl/Cmd+Entrée** pour les formes admissibles ; elle réutilise les contrôles de navigation de la transcription et du mode Lecture, sans écrire dans la note.
- L'insertion d'une citation, d'une capture acceptée ou d'un asset connu utilise une transaction CodeMirror isolée dans Undo/Redo et laisse l'autosauvegarde habituelle gérer l'écriture.

Les grammaires exactes et cas limites des callouts, widgets et citations sont décrits dans [Product & UX](01-product-and-ux.md) ; leur composition interne figure dans [Architecture](03-architecture.md).

### 8.3 Références temporelles

Syntaxe Markdown actuelle :

```markdown
[12:42](sillage://videos/5/sources/5?start_ms=762345)
```

L'autorité logique `videos`, les deux identifiants vidéo/source et la position `start_ms` sont **explicites**. La position provient du paramètre numérique, jamais de son libellé ; `end_ms` est réservé aux plages futures et n'est pas généré/interprété comme une fonctionnalité existante.

Les références ne commandent que la source de travail actuellement compatible. Les autres identités, URI invalides et lecteurs non prêts produisent des refus explicites, **sans commande différée**. La portabilité entre deux bases indépendantes n'est pas assurée par les IDs locaux.

### 8.4 Lecteurs YouTube et Local

La surface distante utilise directement **l'IFrame Player API YouTube**, et la surface locale un **`<video>` HTML5 natif**. Pas de bibliothèque tierce de lecteur, de MSE ou de transcodage implicite. Une seule instance active à la fois ; changer de mode détruit/arrête l'ancienne surface sans démonter la note ni la transcription.

- Choix initial **Local si un fichier de la source de travail est disponible**, sinon YouTube. Attendre la consultation initiale avant de monter un lecteur ; une erreur de consultation sélectionne YouTube. Pas de préférence persistante et pas de bascule automatique en fin de téléchargement.
- Une bascule **prépare** la position transférable, mais **ne démarre jamais la lecture**. Un départ préparé encore valable peut circuler entre lecteurs ; une position devenue incertaine ne doit pas réutiliser une ancienne cible.
- `+ Temps` et `+ Capture` utilisent **la position courante admissible** du lecteur actif, jamais un départ simplement préparé ni la dernière cible d'un seek.
- Pour YouTube, le verrou durable `pendingSeek` a été abandonné : dans un état admissible, utiliser le temps rapporté par l'API, même momentanément approché. Ne pas attendre l'égalité avec la cible ni imposer une tolérance arbitraire.
- Une **navigation explicite** depuis une référence appelle `seekTo` ; elle conserve la pause depuis `paused` et demande le démarrage depuis les autres états connus. `cueVideoById` reste réservé à la préparation lors des bascules.
- Une éventuelle notification `onAutoplayBlocked` affiche une aide, sans échec forcé, délai de détection inventé ou relance automatique. L'ouverture de la fiche et les bascules ne sollicitent aucun autoplay.
- Local utilise `currentTime` et refuse une position tant que le seek ou le chargement rend la mesure inadmissible. Une erreur de décodage ne supprime pas le média et n'impose pas de bascule vers YouTube.
- Images utilise une commande distincte : pause YouTube confirmée sans déchargement ni reprise, maintien de la lecture locale. Un refus de pause laisse l'instance accessible, sans destruction de secours.
- Masquer un lecteur l'interrompt en pause ; réafficher ne redémarre pas la lecture. L'instance distante doit préserver les garanties de pause pendant les opérations de masquage et de destruction.
- La diffusion locale utilise des routes contrôlées **GET/HEAD/Range** avec `net/http.ServeContent` et autorisation de l'identité exacte du média. Aucun accès direct à `data/media` ; la réservation concerne le transfert HTTP et ne révoque pas les octets déjà mis en tampon par un client.
- `canPlayType` et les noms de codecs retournés par `ffprobe` ne suffisent pas à garantir la lisibilité par le navigateur ; une erreur réelle est présentée sans attribuer systématiquement la cause au codec.

Le comportement visuel de la barre, du popover, du lecteur 16:9 et du workspace relève de [Product & UX](01-product-and-ux.md). Les scénarios réels Brave/YouTube et les codecs sont couverts par la [recette manuelle](07-local-playback-validation.md).

## 9. Journalisation et diagnostics

### 9.1 Configuration

La journalisation utilise **`log/slog` directement**, sans interface supplémentaire ni persistance SQL des logs.

- Niveaux `DEBUG`, `INFO`, `WARN`, `ERROR` ; **INFO** par défaut.
- Sortie **stdout** ; format **texte** hors Docker, **JSON** dans Docker.
- `SILLAGE_LOG_LEVEL` et `SILLAGE_LOG_FORMAT` sont validés au démarrage ; un paramètre invalide est signalé sans en recopier la valeur sensible.
- Dans Docker, pilote de logs `local`, rotation en **5 fichiers de 20 Mio** ; nom de conteneur configurable, `sillage` par défaut. La rétention de logs n'est pas un archivage durable des connaissances.

### 9.2 Sévérité, corrélation et confidentialité

- Les lectures/pollings/sauvegardes réussis à haute fréquence sont `DEBUG`. Les commandes et cycles métier sont `INFO`, les anomalies récupérables `WARN`, les échecs terminaux `ERROR`. Un refus normal ou un `busy` n'est pas une erreur serveur.
- Le bilan HTTP utilise un identifiant **généré par le serveur**, retourné par `X-Request-ID` ; ne pas faire confiance à l'identifiant entrant. Les opérations asynchrones disposent d'une identité propre ; les captures peuvent être retrouvées par leur clé de commande.
- Ne jamais journaliser corps de notes/transcriptions, requêtes brutes, URLs signées, cookies, en-têtes, chemins arbitraires de l'hôte, `stderr` brut, ou messages d'exception incontrôlés, **même en DEBUG**.
- Les outils externes exposent des catégories d'erreur fermées, un code de sortie et l'étape technique utile. Les niveaux de log n'altèrent ni les catégories REST publiques ni les politiques de retry/repli des médias.
- Les erreurs ou absences métier attendues peuvent rester `DEBUG` ; une déconnexion HTTP ne doit pas masquer un véritable échec applicatif terminal dans le diagnostic.

## 10. Docker, fichiers et déploiement

### 10.1 Image et exécution

Distribution self-hosted dans une image **multi-stage** regroupant frontend compilé et serveur Go. Le runtime est basé sur **Debian slim**, exécuté sans root ; il contient `yt-dlp`, Deno, `ffmpeg`, `ffprobe`, les certificats et bibliothèques nécessaires, sans serveur Node permanent.

- Version de `yt-dlp` explicitement épinglée ; téléchargement de binaire vérifié par empreinte SHA-256 lors du build. Une mise à jour nécessite une **reconstruction** volontaire de l'image, pas une auto-mise-à-jour au démarrage.
- Image et configuration compatibles avec un bind mount de données persistantes, UID/GID cohérents, sans `chown` récursif automatique au démarrage.
- Serveur accessible dans le conteneur sur `0.0.0.0:8080`, publication hôte limitée par défaut à `127.0.0.1`. Ne pas exposer ce mode sans protection adaptée.
- Ne pas exécuter deux instances Sillage en écriture sur la même base. Les sauvegardes/restaurations complètes s'effectuent **à froid**, avec le répertoire persistant cohérent.
- Le build et le smoke test Docker font partie de la validation de la distribution ; le parcours CI déterministe n'exige pas un accès réel à YouTube.

### 10.2 Organisation des données

Organisation conceptuelle du répertoire persistant (les chemins exacts dépendent du mode de lancement) :

```text
data/
├── sillage.db
├── media/
├── assets/
└── transcripts/
```

SQLite conserve les entités, relations, états et chemins nécessaires. Le filesystem conserve les octets des médias, assets et snapshots. Les noms physiques sont techniques et ne doivent jamais constituer la seule donnée métier de provenance ou de temporalité.

Les sauvegardes, restaurations et changements de chemins doivent préserver **simultanément** la cohérence de la base et des fichiers. La configuration de stockages externes/NAS, la maintenance des orphelins et une stratégie de backup en ligne restent à définir.

## 11. Limites et décisions non prises

La recherche globale FTS5 est décrite en section 3.7. Transcriptions avec passages/timestamps et futurs artefacts IA restent hors de son périmètre actuel. Une éventuelle recherche sémantique nécessite une décision distincte ; aucune base vectorielle n'est introduite.

À reconsidérer uniquement lorsque le besoin est établi : WAL ; Goose ; import de `VideoSource` locale ; format et rétention des snapshots ; plusieurs qualités et audio seul ; règles de suppression/soft delete ; sauvegarde et restauration avancées ; jobs persistants ; recherche hybride ; auth/multi-utilisateur ; desktop ; providers IA/STT ; transport et permissions MCP. La liste et les questions détaillées vivent dans [Open questions](06-open-questions.md), pas dans un journal ajouté ici.

Ne pas ajouter sans justification : ORM lourd, microservices, queue distribuée, Redis, PostgreSQL/MySQL, hiérarchie générique des sources, moteur de plugins, dump permanent des métadonnées brutes ni modèle SQL mot-à-mot des transcriptions.

## 12. Maintenance du document

- **Mettre à jour une règle en place** lorsque l'implémentation ou la décision change ; supprimer le texte remplacé au lieu d'ajouter un nouveau compte rendu à la fin.
- Garder ici les **choix techniques en vigueur**. Mettre les parcours UX dans le document 01, les invariants de domaine dans le 02 et les contrats détaillés des adapters/HTTP/services dans le 03.
- Reporter les décisions non prises dans `06-open-questions.md` et l'avancement dans `05-roadmap.md`.
- Réserver `history/` aux arbitrages dont la motivation demeure utile. Conserver les validations ponctuelles, commandes de recette, volumes de tests et états de branches dans Git, les PR ou la recette dédiée.
- Ne pas anticiper une abstraction ou une dépendance pour une fonctionnalité simplement évoquée.
