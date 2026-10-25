# Architecture — Sillage

Ce document décrit **l'architecture actuellement implémentée** de Sillage : responsabilités des couches, interactions entre composants, contrats d'intégration et garanties à préserver. Il ne constitue ni un historique des jalons ni une liste de fonctionnalités à développer.

Documents complémentaires :

- [Vision et principes du produit](00-project-brief.md) ; [parcours et règles UX](01-product-and-ux.md).
- [Modèle de domaine et invariants](02-domain-model.md) ; [choix techniques](04-tech-stack-and-decisions.md).
- [Roadmap](05-roadmap.md), [questions ouvertes](06-open-questions.md) et [recette manuelle des lecteurs](07-local-playback-validation.md).
- [Historique des arbitrages significatifs](history/sillage-decisions-octobre-2026.md).

**Périmètre :** REST, services applicatifs, SQLite, `yt-dlp`, `ffmpeg`/`ffprobe`, stockage local, React et Docker sont implémentés. Le serveur MCP, l'IA intégrée, le STT et une application desktop restent des perspectives, pas des composants existants.

**Maintenance :** modifier les sections concernées lorsqu'un contrat évolue, sans ajouter de journal de développement. Les migrations SQL, les types et les routes du code font foi pour les détails d'implémentation ; corriger une divergence documentaire après vérification.

## 1. Vue d'ensemble et frontières

```text
   Navigateur (React / TypeScript / Vite)
                    │ REST / HTTP
                    ▼
         HTTP / Chi / DTO / SPA
                    │
                    ▼
          Services applicatifs Go
       video · note · transcript · media · asset · search
                    │
          ports et interfaces ciblés
             ┌──────┴─────────┐
             ▼                ▼
       SQLite / fichiers   Adapters externes
                           yt-dlp · ffmpeg · ffprobe

   Futur : MCP / CLI / desktop ──► mêmes services applicatifs
```

Le **cœur applicatif n'est pas l'API HTTP**. Les handlers convertissent et valident les requêtes, appellent les services puis construisent les réponses. Ils ne portent ni SQL métier, ni invocation directe de `yt-dlp`, ni gestion autonome des fichiers métier. Les objets métier ne dépendent ni de Chi, ni de React, ni de SQLite, ni d'un provider IA.

L'approche ports/adapters reste **légère** : une interface est utile lorsqu'elle matérialise une véritable frontière (persistance, processus externe, stockage), pas pour reproduire une architecture cérémonieuse. Éviter repository générique, ORM imposé, bus de messages et abstractions multi-provider anticipées.

### 1.1 Données et identité

`Video` est l'objet métier central ; `VideoSource` décrit une provenance externe et ses métadonnées. Un `MediaFile` est une représentation physique locale d'une source existante, **pas une nouvelle `VideoSource`**. `Transcript`, `Note`, `Asset`, `Publisher`, `Person` et `Tag` ont des identités et cycles de vie distincts.

Les identifiants internes Sillage sont indépendants des identifiants YouTube. L'identité externe d'une source est `(provider, external_id)` lorsqu'un ID externe existe. SQLite en garantit l'unicité. Une URL alternative de la même vidéo ne doit pas créer un doublon métier.

Une source de travail unique, actuellement la première source YouTube exploitable de l'ordre REST, sert au lecteur, à la transcription et aux opérations temporelles. Ce choix d'interface **n'est pas** une source principale persistée. La provenance est conservée explicitement dans les références temporelles et les captures.

### 1.2 Composition et séparation des interfaces

Le serveur Go assemble services et adapters au point de composition (`cmd/server`). En développement, Vite sert le frontend et relaie `/api` vers Go. En production, le serveur Go sert le frontend compilé et l'API ; le navigateur ne lit directement ni SQLite ni `data/`.

Le futur serveur MCP devra appeler les **mêmes services applicatifs** que REST, sans requêtes HTTP vers sa propre API si les deux partagent le processus. Ses outils, permissions et transports ne sont pas encore définis. Les futurs providers IA/STT seront eux aussi isolés derrière les frontières appropriées.

## 2. Services et transactions métier

### 2.1 Vidéos et métadonnées

Le service `AddVideo` extrait une source normalisée **avant** d'ouvrir la transaction de création. Il recherche `(provider, external_id)` : si la source existe, il restitue la vidéo existante **sans rafraîchir implicitement** titre, miniature, description, publisher ou autres associations ; sinon il crée `Video` et `VideoSource` atomiquement.

```text
URL → MetadataProvider.Extract → source normalisée
                                  │
                         FindBySource(provider, external_id)
                          ├─ existante → Video existante
                          └─ absente → transaction Video + VideoSource
```

La contrainte unique SQLite tranche la concurrence même si deux requêtes ont constaté une absence simultanément. Les services de lecture/liste utilisent des ports spécialisés tels que `VideoRepository`, qui exposent des erreurs métier stables plutôt que des erreurs SQL brutes.

L'adapter `yt-dlp` connaît les options CLI et les champs des formats externes ; le service ne les connaît pas. Le modèle n'impose pas la présence d'une URL canonique ou d'un external ID à tous les futurs providers, même si ces informations sont nécessaires pour YouTube.

### 2.2 Publishers, personnes et tags

`PublisherService` et `PersonService` portent la création, la résolution d'identité externe, les associations explicites, les tags et les parcours de consultation. `PublisherRepository` et `PersonRepository` restent spécialisés. Une chaîne YouTube est identifiée par `channel_id` ; son nom peut être inconnu. Aucun nom ou handle n'autorise la fusion automatique de personnes ou publishers.

Lors de l'import d'une vidéo, créer ou réutiliser son publisher est atomique avec la création de la source. Une réutilisation ne déclenche pas de mise à jour silencieuse. Une association explicite de personne ou de publisher n'est pas inférée ou corrigée par l'extracteur. La migration historique de `creator` n'a effectué aucun rapprochement par nom.

Le catalogue des tags est partagé entre vidéos, personnes et publishers, **sans héritage** entre ces entités. Les ajouts de noms et d'associations sont atomiques, y compris en présence de concurrents. Les retraits suppriment l'association, pas nécessairement le tag du catalogue. Le filtrage par tag conserve toutes les sources et tous les tags de chaque vidéo retenue.

Les listes et parcours indirects chargent leurs relations en lot et dédupliquent par ID ; ils ne doivent ni multiplier inutilement les requêtes par entité, ni créer d'associations persistantes pendant une lecture.

### 2.3 Notes et concurrence

`note.Service` possède la lecture et l'enregistrement d'une note Markdown principale facultative par vidéo. La note absente diffère d'une note enregistrée vide. Le contenu brut est conservé, à l'exception de la normalisation **CRLF/CR vers LF lors de la sauvegarde** ; un GET ne normalise ni ne sauvegarde.

Chaque `PUT` exige `expected_revision` ; `0` désigne une note attendue absente. La précondition est vérifiée **atomiquement sous transaction SQLite**, création comprise. Un conflit renvoie un résultat métier stable ; aucune dernière écriture gagnante ni écriture forcée n'est autorisée. Une sauvegarde sans modification canonique ne produit pas de nouvelle révision.

Le navigateur dispose d'une session locale d'édition ; elle n'est pas l'autorité sur la concurrence. Elle peut réconcilier une réponse perdue en relisant le serveur, mais les services et SQLite garantissent la protection pour **tous** les clients.

### 2.4 Transcriptions

`transcript.Service` vérifie la vidéo et l'appartenance de la source, puis sépare :

- **`Get`** : lecture strictement locale de la transcription référencée et de son snapshot JSON3 ; aucune requête YouTube.
- **`Fetch`** : acquisition explicite de la caption sélectionnée, normalisation du contenu, publication d'un nouveau snapshot et mise à jour de l'identité persistée `(video_source_id, language, provenance)`.

Le port de provider retourne un contenu normalisé et les octets source opaques ; la connaissance de JSON3 et des formats `yt-dlp` reste dans l'adapter. La langue audio de la source ne doit jamais être déduite de la caption. La sélection originale est une préférence explicite, **pas une garantie** d'identité avec la piste audio.

Publication d'un snapshot : écriture d'un nouveau temporaire, synchronisation, fermeture et renommage, **puis transaction SQLite courte**. Aucune transaction SQL n'est maintenue pendant le réseau ou l'écriture du fichier. L'ancien snapshot reste disponible pour les lecteurs ; un crash ou un échec SQL peut laisser un fichier orphelin, qui n'est pas effacé arbitrairement. Le `GET` lit et parse le snapshot référencé ; son absence/corruption est une erreur locale, sans réacquisition implicite.

### 2.5 Recherche globale

`search.Service` expose un port spécialisé indépendant de HTTP et de SQLite, réutilisable par les interfaces non HTTP. L'adapter SQLite maintient une projection FTS5 reconstructible, avec un document par vidéo, dans les transactions des écritures métier. Une recherche lit total, résultats et explications dans un même instantané ; les appels successifs restent indépendants.

La [référence technique de recherche](search.md) décrit la constitution et le cycle de vie de l'index, les requêtes, le contrat REST, les extraits et les validations. Les règles de présentation restent dans [Product & UX](01-product-and-ux.md).

## 3. Stockage SQLite et filesystem

### 3.1 SQLite

SQLite est accessible par `database/sql` avec `modernc.org/sqlite`. Les migrations SQL sont embarquées (`embed.FS`), ordonnées, transactionnelles et suivies par `PRAGMA user_version`. Une base d'une version supérieure à celle du binaire est refusée. Les clés étrangères sont activées ; un `busy_timeout` amortit la contention ordinaire.

L'intégrité repose sur les **contraintes de base et les transactions**, pas uniquement sur « rechercher puis insérer ». Les notes sont protégées par révision ; les tags par identité Unicode normalisée et contraintes uniques ; les relations et IDs externes par leurs clés et contraintes dédiées.

Les **migrations SQL** constituent la référence du schéma actuel. Ne pas recopier la migration `0001` comme si elle décrivait encore le modèle complet. Les décisions sur WAL, un futur outil de migrations et la stratégie de sauvegarde sont dans [Open questions](06-open-questions.md).

### 3.2 Fichiers durables et publications

Organisation actuelle du répertoire de données (chemin relatif au processus ; `/app/data` dans Docker) :

```text
data/
├── sillage.db
├── media/
├── assets/
└── transcripts/
```

SQLite conserve l'identité, la provenance, les états et les noms/chemins relatifs nécessaires. Le filesystem conserve les octets. Un nom de fichier n'est jamais l'identité métier ; une API publique n'expose pas les chemins internes.

Il n'existe pas de transaction distribuée SQLite/filesystem. Les protocoles de publication combinent **fichier complet et durable d'abord**, puis validation transactionnelle en base. Après commit SQL incertain, l'application peut vérifier son effet sans détruire les octets. Les orphelins résultant de crash, sauvegarde restaurée ou publication partielle sont **préservés et signalés**, jamais nettoyés automatiquement sur la seule absence de référence SQL.

La suppression d'un média est distincte de celle des connaissances : note, vidéo, transcription et captures sont préservées. Les procédures de réparation, d'inventaire et de rétention restent de futures opérations explicites.

### 3.3 Déploiement, sûreté et sauvegardes

Une instance serveur unique doit utiliser un même répertoire de données. Les données vivent dans un bind mount durable, séparé de l'image. La sauvegarde/restauration cohérente concerne **la base et ses fichiers** ; les sauvegardes à froid sont actuellement la référence de déploiement. L'application ne doit pas écrire ni servir directement des chemins contrôlés par le client.

## 4. Acquisition et conservation de médias

### 4.1 Service asynchrone

`media.Service` orchestre `VideoReader`, `Repository`, `Provider` et `Storage` ; les adapters SQLite, filesystem et `ytdlp.MediaClient` assurent les opérations techniques.

Le téléchargement est une opération **asynchrone appartenant au contexte serveur**, et non à la requête HTTP initiatrice. Une seule acquisition est active globalement ; une nouvelle demande de la même source retrouve l'opération, une autre reçoit un refus temporaire. Il n'y a ni file, ni `Job` persistant, ni reprise automatique après arrêt, ni annulation utilisateur.

L'activité est réservée **avant** le lancement de la goroutine. Le résultat terminal est publié après la finalisation et la libération de l'activité, de façon à ne pas annoncer `available` pendant que le travail est encore actif. Le dernier échec est un état transitoire borné en mémoire ; la disponibilité durable est déduite de SQLite et du fichier présent, non d'un indicateur mémorisé.

La requête GET de suivi est locale et ne lance ni `yt-dlp` ni `ffprobe`. Elle contrôle référence, présence, taille et possibilité de lecture ; elle ne garantit pas l'intégrité complète d'un fichier modifié ultérieurement à taille inchangée.

### 4.2 Extraction, validation et publication

Une invocation `yt-dlp` contrôle l'identité YouTube et le caractère terminé de la vidéo avant acquisition. La sélection et le tri sont délégués à `yt-dlp` ; Sillage n'impose ni MP4 ni catalogue de codecs. `ffprobe` valide la représentation obtenue (conteneur, pistes attendues, dimensions, codecs, durée et taille) avant publication. Les métadonnées techniques peuvent être inconnues (`NULL`) lorsque la source ne fournit pas de valeur exploitable.

L'opération travaille dans une zone temporaire sous `data/media`, sur le filesystem définitif. Après validation : synchronisation du fichier complet, publication sous nom sûr, puis transaction SQLite courte. Un fichier publié n'est **pas** supprimé en compensation d'une erreur SQL. Les fichiers temporaires de l'opération en cours sont nettoyés lorsqu'elle en a la maîtrise.

### 4.3 Suppression et rapprochement

Une suppression explicite désigne **un MediaFile précis**. Le service sérialise les consultations et opérations critiques ; une réservation d'usage empêche la suppression pendant une lecture HTTP ou une capture utilisant ce fichier.

Le fichier est déplacé dans une zone `.deleting`, synchronisé, puis sa référence SQL est supprimée avant l'effacement des octets. Au redémarrage, seul un `.deleting` référencé, sûr et sans original peut être restauré. Les fichiers sans référence, `.pending` abandonnés et `.deleting` orphelins sont laissés intacts et signalés. Une anomalie de média isolée ne doit pas rendre les notes et transcriptions indisponibles.

Une racine média inutilisable au démarrage peut désactiver les opérations média tout en préservant le reste du serveur jusqu'à réparation et redémarrage. Aucun nettoyage ni rattachement automatique n'est réalisé après restauration de sauvegarde.

### 4.4 Durée de vie et arrêt

`SILLAGE_DOWNLOAD_TIMEOUT` est indépendant du timeout d'acquisition HTTP des métadonnées/transcriptions. Sous Linux, les processus externes sont lancés en groupe et l'arrêt interrompt aussi leurs descendants. Le serveur attend la fin des opérations applicatives avant de fermer SQLite ; les requêtes HTTP ne possèdent pas la durée de vie du téléchargement.

## 5. Captures PNG et assets

### 5.1 Service et provenance

`asset.Service` possède l'acceptation, la déduplication par clé de commande, le repository, l'emprunt média, l'extraction et la publication. L'identité d'une capture inclut sa vidéo, sa **source exacte** et son timestamp. Une capture n'utilise jamais silencieusement un média d'une autre `VideoSource` de la même vidéo.

```text
POST capture → Asset pending + identité durable → réponse HTTP
                         │
                opération serveur autonome
                         │
           emprunt d'un MediaFile de même source
                  │ disponible ?
                  ├─ oui → extraction locale
                  └─ non / erreur éligible → flux distant
                         │
                 validation / publication PNG
                         │
                 état available ou failed
```

Une seule capture est active par instance serveur, indépendamment de l'acquisition média, sans queue. Le travail continue après la réponse d'acceptation ou la navigation du client. L'arrêt du serveur annule les sous-processus, attend leur finalisation et marque ou récupère les opérations interrompues selon les règles persistées.

### 5.2 Extraction et replis

La capture utilise en priorité le `MediaFile` complet de **la même source**, protégé contre la suppression pendant l'emprunt. Sinon l'adapter résout un flux distant récent et utilise `ffmpeg`/`ffprobe`. Le seek recherche une image réellement décodable au timestamp demandé ; il n'est pas assimilable à une reproduction pixel à pixel de l'iframe YouTube.

La sélection distante privilégie la résolution, puis HTTPS direct à dimensions égales. Un échec HLS éligible peut déclencher **une seule alternative HTTPS de mêmes dimensions** ; un HTTP 403 peut autoriser **une seule nouvelle résolution** de l'URL, dans un budget global borné. Un échec SQLite, stockage ou une annulation **ne déclenche pas** ce repli. Aucun téléchargement complet durable ni réduction automatique de qualité n'est introduit.

Le PNG est validé et synchronisé avant publication sans écrasement, puis le statut SQL est confirmé. Les fichiers publiés sont conservés en cas de commit incertain ; aucune collecte arbitraire des orphelins. La capture peut échouer explicitement sur timestamps sans image, profils colorimétriques non traitables ou formats invalides. Les critères détaillés de format, HDR, sécurité et sélection figurent dans [Tech stack & decisions](04-tech-stack-and-decisions.md).

### 5.3 Idempotence et récupération

Chaque demande possède une clé de commande générée côté client et réutilisée si la réponse HTTP est perdue. La recherche par clé permet de retrouver l'identité de l'Asset ; une répétition avec les **mêmes paramètres et la même clé** reste idempotente. Réutiliser la clé pour une demande différente est un conflit. Une simple consultation ne relance jamais l'extraction.

La génération est distinguée de la **consultation de son fichier** : un Asset `available` dont le PNG est inaccessible ne doit pas être requalifié arbitrairement en `failed`.

### 5.4 Catalogue par vidéo

Le service vérifie l'existence de la vidéo puis le repository lit les captures de toutes ses sources,
indépendamment des références de note et sans tester les fichiers. Le tri `timestamp_ms ASC, id ASC` est
stable ; il n'affirme aucune synchronisation entre timelines. Un index `(video_id, timestamp_ms, id)`
sert cet ordre. Une page contient au plus 12 éléments ; un treizième détecte la suite. L'offset ne fournit
pas un instantané entre requêtes concurrentes. Le transport distingue vidéo absente, page vide et erreur.

## 6. API HTTP / Chi

### 6.1 Conventions

L'API `/api/v1` est construite avec `net/http` et Chi. Les handlers sont minces, les DTO restent distincts du domaine et les données techniques internes ne sont pas retournées au client.

- JSON strict : type MIME approprié lorsque requis, corps bornés, objet unique, champs inconnus refusés, UTF-8 valide et identifiants contrôlés.
- Erreurs métier transformées en **statuts et codes publics stables**. Un `stderr`, un chemin hôte ou une exception technique ne fait jamais partie du corps public.
- Les listes renvoient leurs enveloppes (`{"videos": [...]}`, `{"tags": [...]}`, etc.), les éléments et associations leur ordre déterministe ; les champs facultatifs sont représentés selon le contrat REST existant.
- Les acquisitions synchrones sont bornées par `SILLAGE_POST_TIMEOUT` et annulées avec le contexte HTTP ; les travaux asynchrones ont leur propre contexte serveur.
- Une API non authentifiée, accessible localement par défaut, ne doit pas être considérée comme prête pour une exposition publique.

Les limites chiffrées et exemples de payloads en vigueur sont également documentés dans le [README](../README.md). Ne pas changer un code REST pour simplifier la documentation.

### 6.2 Vidéos et classement

| Méthode | Route | Contrat essentiel |
| --- | --- | --- |
| `POST` | `/api/v1/videos` | Ajout synchrone ; `201` + `Location` si créé, `200` si déjà présent ; aucun refresh implicite |
| `GET` | `/api/v1/videos` | `{"videos": [...]}` ; ordre `created_at DESC, id DESC` ; `tag_id` facultatif |
| `GET` | `/api/v1/videos/{id}` | Vidéo, sources, tags et associations directes |
| `GET` | `/api/v1/tags` | Catalogue complet, même inutilisé ; IDs croissants |
| `POST` | `/api/v1/videos/{id}/tags` | `{"names": [...]}` ; ajout additif atomique, retourne tous les tags associés |
| `DELETE` | `/api/v1/videos/{id}/tags/{tag_id}` | `204` idempotent ; supprime l'association seulement |

Les champs `publisher: {id, name}` nullable des sources et `person_ids` directs des vidéos remplacent l'ancien champ `creator`. Les DTO ne créent aucun héritage de tags ou de personnes à partir des publishers.

### 6.3 Notes et transcriptions

| Méthode | Route | Contrat essentiel |
| --- | --- | --- |
| `GET` | `/api/v1/videos/{id}/note` | `200` si présente ; `404 note_not_found` si absente |
| `PUT` | `/api/v1/videos/{id}/note` | `content_md` et `expected_revision` obligatoires ; `201` création, `200` ensuite, `409 note_conflict` si précondition échouée |
| `GET` | `/api/v1/videos/{video_id}/sources/{source_id}/transcript` | Snapshot local seulement ; `404` en l'absence de transcription |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/transcript` | Corps vide ; `200` après acquisition et publication explicites |

Le `PUT` de note ne permet ni écriture forcée ni création automatique à la lecture. Les transcriptions sont sélectionnées selon la provenance et la langue admises ; ambiguïté, absence de piste, indisponibilité distante et erreur de snapshot local sont **des catégories différentes**. Un résultat HTTP incertain ne doit pas déclencher un nouveau POST implicite.

### 6.4 Publishers et personnes

Les services exposent des routes de catalogue, création, détail, édition et association pour `publishers`, `persons`, leurs tags et leurs vidéos. Les parcours incluent :

- `POST/GET /api/v1/publishers`, `GET /api/v1/publishers/{id}`, `GET /api/v1/publishers/{id}/videos` ;
- `POST/GET /api/v1/persons`, `GET/PATCH /api/v1/persons/{id}`, `GET /api/v1/persons/{id}/publishers` et `/videos?relation=direct|publisher|all` ;
- rattachement explicite d'un publisher à une source, d'une personne à un publisher ou à une vidéo ;
- ajout/retrait des tags propres à chacun, à partir du catalogue partagé.

Les relations directes et indirectes restent distinctes ; `all` déduplique les vidéos par identité. Aucune suppression d'entité, attribution de rôle ni rafraîchissement automatique n'est exposé. Voir le [README](../README.md) pour les signatures exactes des routes et les erreurs publiques.

### 6.5 Médias et captures

| Méthode | Route | Contrat essentiel |
| --- | --- | --- |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/download` | `202` en activité, `200` si déjà disponible ; ne requiert pas d'attente HTTP du téléchargement |
| `GET` | `/api/v1/videos/{video_id}/sources/{source_id}/download` | État local `not_downloaded`, `downloading`, `available` ou `failed` |
| `DELETE` | `/api/v1/videos/{video_id}/media-files/{media_file_id}` | Suppression explicite d'une identité exacte, protégée par réservation |
| `GET/HEAD` | `/api/v1/videos/{video_id}/media-files/{media_file_id}/content` | Diffusion par `ServeContent` avec `Range` et requêtes conditionnelles |
| `POST` | `/api/v1/videos/{video_id}/sources/{source_id}/captures` | Demande avec timestamp et clé ; `202 pending`, `200` si répétition terminée |
| `GET` | `/api/v1/videos/{video_id}/assets?page=1` | Catalogue par pages de 12 : `assets`, `page`, `has_more` ; page entière 1–1 000 000 |
| `GET` | `/api/v1/assets/requests/{request_id}` | Retrouver l'Asset d'une demande de capture incertaine |
| `GET` | `/api/v1/assets/{asset_id}` | État, provenance et identité publics |
| `GET` | `/api/v1/assets/{asset_id}/content` | PNG publié, **sans** création implicite |

Les chemins internes des fichiers et les diagnostics des processus ne sont pas exposés. Les réponses de statut de téléchargement et les erreurs de consultation sont distinctes ; `failed` dans un `GET 200` n'est pas la même chose qu'un échec HTTP de ce GET.

## 7. Diffusion locale et gestion des accès fichiers

### 7.1 Ouverture contrôlée

Le `GET/HEAD` du contenu média vérifie la vidéo propriétaire, l'identité du fichier, son état et sa disponibilité avant d'ouvrir le contenu. Le port de stockage retourne un objet `Reader/Seeker/Closer`. L'adapter filesystem borne l'accès à sa racine (`os.OpenRoot`), refuse les liens symboliques finaux et les fichiers non réguliers et valide le **descripteur réellement ouvert** (taille et type), sans construire un chemin à partir d'une valeur envoyée par le navigateur.

Les fichiers marqués `.deleting` ou ambigus sont indisponibles. Le lecteur ne peut pas demander arbitrairement un fichier de `data/media/`.

### 7.2 Réservations et diffusion HTTP

L'ouverture et la prise de réservation sont sérialisées avec la suppression ; le flux se déroule **sans verrou global**. Fermer le lecteur HTTP ferme son descripteur puis libère sa réservation, y compris après annulation ou panique du handler.

`http.ServeContent` fournit le corps, `HEAD`, les réponses `206/416` et les plages. Les en-têtes sont configurés pour éviter interprétations de type et cache non désiré. Aucune transformation des octets n'est réalisée. Une réservation protège **une requête**, pas toute la séance d'un navigateur : une suppression après une requête peut rendre le `Range` suivant indisponible, sans pouvoir révoquer des octets déjà mis en tampon.

Un format validé par `ffprobe` n'est pas nécessairement décodable dans un navigateur : l'erreur de lecture doit être gérée par le frontend sans transcodage ou effacement implicite.

## 8. Frontend : composition et état

### 8.1 SPA et navigation

React/TypeScript/Vite consomme REST avec des chemins relatifs ; Vite proxy `/api` en développement, Go sert les fichiers de production. Les routes React Router gèrent bibliothèque, recherche, ajout et fiche vidéo ; les réponses réseau tardives et lectures annulées ne doivent jamais remplacer les données de la page suivante.

Le data router prend en charge les protections de navigation de la note, y compris l'historique. L'état reste local aux composants et services de session ; pas de store global imposé. La SPA n'a pas d'accès direct à SQLite ni aux fichiers bruts du serveur.

Le fallback vers `index.html` est réservé aux **routes SPA** : il ne doit masquer ni une erreur de `/api`, ni l'absence d'un asset statique. Le répertoire public servi par Go est distinct du répertoire persistant ; son ouverture est bornée côté filesystem.

### 8.2 Workspace et données partagées

La fiche charge la vidéo par REST et détermine sa source de travail. `VideoPlayer` et `VideoTranscript` consomment cette identité commune ; `VideoNote` est associé à la `Video` et reste monté pendant les changements de mode/onglet, de lecteur et de disposition.

Le titre et les tags de la fiche alimentent un emplacement stable de l'en-tête, sans seconde requête dédiée ni copie globale des données. La navigation latérale, le thème et les tags d'en-tête ne doivent ni commander les lecteurs ni détruire la session d'édition.

L'onglet Note/Informations masque visuellement le contenu inactif sans démonter `VideoNote`. Une citation n'ouvre Note **que si l'insertion est admissible** ; les retours de capture asynchrones ne changent pas d'onglet. Le panneau d'informations conserve l'accès à toutes les sources et aux propriétés locales ; le popover du lecteur est limité à son contexte YouTube/Local.

Le layout actuel comprend les surfaces 16:9 (avec exception de hauteur minimale sur petit mobile), la colonne Note et le cadre Lecteur/Transcription jointif sur desktop ; il conserve les trois composants séparés. Les contraintes visuelles précises sont documentées dans [Product & UX](01-product-and-ux.md), pas reproduites comme des étapes de refonte.

### 8.3 Session CodeMirror, sauvegarde et lecture

Une session locale par note porte le texte courant, la dernière version confirmée, sa révision, les délais d'autosauvegarde, les conflits et l'écriture en cours. `MarkdownEditor` conserve son `EditorView` pendant le passage Édition/Lecture, les onglets et les réponses du serveur. Le rendu Lecture utilise GFM sécurisé sans exécuter de HTML brut.

La session travaille en LF ; le service Go normalise au moment de la sauvegarde. Une ancienne note CRLF ne doit pas être écrite simplement parce qu'on l'a ouverte. Le client peut réconcilier une réponse perdue par GET avant une nouvelle tentative ; les conflits suspendent l'autosauvegarde et demandent un choix explicite conditionnel.

La sauvegarde visuelle représente la **confirmation de tout le contenu actuel**, pas la seule fin d'une promesse réseau. Les confirmations partielles ou anciennes ne déclenchent pas de coche de succès. Échec et conflit persistent jusqu'à leur résolution. Les états de présentation ne constituent ni nouveaux champs en base ni nouvelles routes.

### 8.4 Références temporelles et navigation

Le format canonique est une URI Markdown `sillage://videos/{video_id}/sources/{source_id}?start_ms={ms}`. Un parseur pur valide sa structure et ses entiers ; ni libellé affiché ni URL quelconque ne sont interprétés comme une commande temporelle. `end_ms` reste réservé à une future plage.

`VideoDetail` vérifie l'appartenance vidéo/source puis délègue une action impérative au lecteur actif. Les liens en Lecture et les références activables en Édition réutilisent la même validation. Les liens Web restent filtrés/sécurisés ; les liens externes HTTP(S) ouvrent un onglet protégé. Les refus apparaissent près du geste concerné, sans modifier la note.

Après une commande acceptée, le lecteur peut faire défiler **la page** pour rendre la vidéo visible, sans déplacer le focus ni forcer un défilement interne du texte. Un lecteur non prêt ou une identité différente produit un refus explicite, sans commande différée.

#### YouTube et Local

`VideoPlayer` conserve un en-tête et une surface active unique. Chaque surface expose les opérations nécessaires au workspace (`getCurrentTimeMs`, `navigate`, `stop`, visibilité et position transférable). Lors d'une bascule, l'ancienne surface est arrêtée avant la nouvelle ; les callbacks tardifs des instances démontées sont ignorés.

- **Sélection initiale** : attendre la première consultation de disponibilité ; Local si un fichier de la source de travail est disponible, sinon YouTube. Le choix ne change pas à la fin d'un téléchargement et n'est pas persisté.
- **Bascule** : transmettre si possible une position admissible ou préparée, sans autoplay ; une position devenue incertaine ne réutilise jamais l'ancienne cible. `cueVideoById` prépare YouTube ; `loadedmetadata` prépare Local. La mémoire ne sort pas de la session de la fiche/source.
- **Navigation explicite** : YouTube utilise `seekTo` depuis les états connus, en préservant la pause depuis `paused` et en demandant le démarrage sinon ; Local règle `currentTime` sans démarrage automatique. Une préparation de bascule n'est pas une navigation explicite.
- **Annotation/capture** : `getCurrentTimeMs` exige une position courante admissible. YouTube interroge la valeur annoncée dans ses états utilisables, même légèrement ancienne après un seek ; aucun verrou durable `pendingSeek` ni comparaison à la dernière cible. Local refuse le seek en cours ou des données insuffisantes. Un départ simplement préparé n'est jamais annotable.
- **Visibilité** : masquer arrête la lecture ; une pause YouTube non confirmée peut conduire à détruire l'instance pour garantir l'arrêt. Réafficher ne relance pas la lecture.
- **Blocage navigateur** : un événement `onAutoplayBlocked` peut informer l'utilisateur, sans détection par délai, deuxième `playVideo` ni relance automatique. L'absence du signal ne prouve pas que le démarrage a réussi.

Les comportements et scénarios sur l'API YouTube réelle sont consignés dans [la recette manuelle](07-local-playback-validation.md). Les tests de navigateur avec un double YouTube ne remplacent pas cette validation.

### 8.5 Transcription et recherche locale

`VideoTranscript` charge seulement la transcription de la source de travail, sans acquisition implicite. La demande explicite récupère ou actualise ; une réponse perdue peut être clarifiée par lecture GET. Le contenu visible reste indépendant de l'état de l'acquisition et n'est pas effacé sur une erreur distante.

La présentation regroupe les fragments source dans des intervalles **fixes de 10 secondes**, en conservant leur ordre et leur texte exact ; les paragraphes utilisent le retour visuel à la ligne du navigateur. La recherche opère sur la concaténation exacte des fragments chargés, indépendamment des blocs visuels ; elle conserve la correspondance vers les positions pour le surlignage. Aucun index SQL ni recherche globale n'est utilisé ici.

Une occurrence de recherche ne commande pas le lecteur ; seul le timestamp activé le fait. La sélection d'un passage pour citation est une sélection native DOM : l'extraction de texte continu ignore les boutons de temps, tient compte des marques de recherche et rattache la position au premier fragment réellement retenu.

### 8.6 Citations, callouts et décorations

La citation passe de la sélection de transcription à une **transaction CodeMirror** dans la note. Une note non vide exige un emplacement choisi explicitement par l'utilisateur ; un focus automatique ne suffit pas. Une citation inadmissible ne change pas l'onglet ni la note. La transaction est isolée dans Undo/Redo et respecte LF, la révision et l'autosauvegarde.

Le rendu Markdown utilise un traitement Remark ciblé pour `quote` et `quote:tr` avec validation partagée des URI canoniques, sans moteur extensible de callouts. Les en-têtes inconnus ou invalides restent du Markdown ordinaire ; leur contenu n'est pas exécuté comme HTML. Le titre d'une citation de transcription reste du texte littéral.

CodeMirror utilise ses propres arbres syntaxiques pour les décorations de blockquotes et la compaction ciblée de références temporelles, sans transformer le Markdown stocké. Le clic simple révèle la source ; le clavier, les sélections et la composition IME préservent l'édition native. **Ctrl/Cmd+clic** et **Ctrl/Cmd+Entrée** activent seulement les références reconnues et admissibles en réutilisant la navigation du mode Lecture. Les décorations visuelles ne produisent pas de sauvegarde.

### 8.7 Insertion asynchrone des captures

L'éditeur affiche un ancrage visuel pendant l'acceptation de la capture, **sans Markdown temporaire** ni transaction de sauvegarde. Une `StateField` suit ce point à travers les changements de document ; si l'ancrage est détruit ou la session remplacée, la réponse tardive n'insère rien.

L'acceptation persistée produit une unique insertion Markdown isolée dans Undo/Redo. Retirer le lien ou annuler son insertion ne supprime pas l'Asset et n'annule pas son opération serveur. Les images du mode Lecture consultent leur état par identité ; elles ne déclenchent aucune génération et ne commandent pas le lecteur.

### 8.8 Consultation et réinsertion des assets

Images interroge une collection bornée par vidéo, sans reconstruire le catalogue depuis Markdown ni lancer
de GET individuel pour chaque carte. Seules les pages contenant `pending` sont actualisées pendant leur
consultation ; erreur ou état terminal arrête ce suivi, et quitter ou changer de page annule les réponses
obsolètes. VideoNote notifie la fiche après une acceptation confirmée de capture, même si son insertion
asynchrone a été abandonnée : une invalidation locale relit uniquement la page courante d'Images, sans
synchronisation permanente ni changement de page. Les images utilisent les octets PNG existants avec `loading=lazy` et décodage asynchrone.
La page précédente est démontée au changement de page, sans accumulation de la grille entière. Un état
d'affichage partagé, borné à la page, relie miniature et visionneuse : une erreur interdit l'insertion,
seul un réessai explicitement réussi la rétablit. Les événements d'anciennes tentatives sont ignorés.
Aucun contrôle réseau additionnel n'accompagne l'insertion et le statut métier n'est pas modifié.

La fiche possède l'unique NoteSession, toujours démarrée et arrêtée avec VideoNote. Images s'abonne à
son instantané courant et dérive ses compteurs avec la chaîne unified/remark du rendu (GFM, callouts,
résolution des références puis arbre HTML). Seules les images à URL interne canonique sont comptées.
Les recalculs sont programmés après 250 ms sans changement, avec un plafond de 1 s pendant une frappe
continue. Le rendu et la transaction de frappe n'appellent pas le parseur. Avant analyse et publication,
contenu et version d'éditeur sont comparés à l'instantané courant ; les temporisations obsolètes sont
annulées. Un remplacement explicite invalide immédiatement les anciens compteurs. Une analyse individuelle
reste synchrone sur le thread principal, sans worker. Aucun second brouillon, montage React de lecture,
effet réseau ou écriture ne sert à ce calcul.
Le toggle à icône reste hors du tablist et ses messages hors des panneaux masqués ; un jeton synchrone
exclut les ouvertures concurrentes et invalide les réponses d'une préparation annulée.

Un même arbre de sélecteur utilise `dialog.show()` sur desktop et `showModal()` sous 1 100 px. Le panneau
recouvre la colonne droite et rend ses commandes inertes ; ni note, ni lecteurs, ni transcription ne sont
remontés. Une lightbox modale native interne conserve la miniature d'origine et le défilement. Sa navigation
par boutons/flèches filtre les états `available` de la page courante, sans boucle, cache général ou
franchissement de pagination. Une erreur de contenu reste une étape consultable avec réessai ; les états
d'affichage partagés bloquent l'insertion jusqu'au succès. Le fond ferme uniquement la lightbox et ses
commandes ne déclenchent pas cette fermeture. Si la miniature d'origine est retirée après erreur, la carte
conservée fournit le retour de focus. Les modales
natives protègent aussi le focus des dialogues de départ de note. VideoNote signale ce blocage à la fiche :
les adaptations natives responsive d'Images et de la lightbox sont différées jusqu'à la fin de la protection,
sans fermer ni remonter leurs composants. Les gestionnaires Échap respectent la surface modale active et
les événements déjà traités.

La fiche importe Images à la demande après la commande d'ouverture, avec une attente annoncée et annulable.
Le hook responsive reste dans un module léger indépendant ; le sélecteur et sa chaîne de parsing ne sont
pas des dépendances initiales de la fiche. Le jeton d'ouverture invalide aussi un chargement de module tardif.

`prepareImages` et `releaseImages` sont distincts de `stop`, du masquage et des changements de mode.
YouTube confirme une pause dans un budget borné avant ouverture et protège les reprises tardives ; sans
confirmation, la surface reste accessible ou le sélecteur se ferme avec une erreur. Aucune destruction de
secours ni restauration depuis une cible ancienne. Local n'interrompt pas sa lecture.

La réinsertion passe synchroniquement par VideoNote puis le handle de la vue CodeMirror **courante**.
Le contrôle d'emplacement explicite est remis à zéro à chaque remplacement de session. La transaction
ajoute après `selection.main.to`, avance le curseur et s'isole dans l'historique ; elle ne vole pas le focus.
Un plugin de décorations suit la sélection et le point d'ajout pendant Images, sans modification de texte.
NoteSession reçoit le changement normalement, y compris en conflit, sans nouvel endpoint ni ancrage différé.
Sur mobile, le sélecteur est fermé avant de rendre le focus à la note. L'annonce d'insertion appartient à
VideoNote et survit à cette fermeture.

### 8.9 Gestion des tags et en-tête

Les mutations de tags sont des opérations successives et persistées immédiatement ; la fermeture de la modale ne les annule pas. Le frontend fournit une autocomplétion accessible sans réimplémenter la normalisation métier Go. Les fiches affichent les tags dans leur en-tête, avec un préfixe mesuré et un compteur `+n` pour le surplus ; la liste garde l'ordre REST et n'impose pas de quota arbitraire.

Les mesures d'encombrement et changements responsive n'ajoutent ni requête REST, ni association, ni sauvegarde de note. Le volet global utilise un dialogue modal et se ferme avant une navigation protégée afin de ne pas concurrencer le dialogue de sauvegarde.

## 9. Journalisation et observabilité

Le logger `log/slog` est composé au démarrage et transmis aux services via contexte ; il reste indépendant des objets métier. Le middleware Chi produit **un bilan HTTP unique** avec identifiant généré par le serveur et code public contrôlé. Il couvre API et SPA, ne journalise pas les URL arbitraires et récupère les panics HTTP selon l'état réel de la réponse (avant/après engagement du writer).

- Ne jamais journaliser corps de notes ou transcriptions, URL signées, cookies, en-têtes, chemins hôte arbitraires, `stderr` brut ou texte de panic, même en `DEBUG`.
- Les erreurs d'outils gardent des catégories sûres, étapes et codes de sortie sans exposer leurs sorties. Les erreurs métier attendues ne sont pas artificiellement converties en `internal_error`.
- Les opérations média et capture ont leur **propre identité et leur propre contexte serveur**. L'identifiant HTTP à l'origine de l'acceptation est un attribut de corrélation, pas leur durée de vie.
- La récupération d'une capture par sa clé corrèle la nouvelle requête à l'Asset et à son opération, **sans afficher la clé brute**. Un log de début sans fin après crash reste possible ; les logs ne remplacent jamais les états durables.
- Une déconnexion HTTP n'efface pas la gravité d'un échec applicatif déjà constaté. Le writer doit conserver `HEAD`, `Range`, flux progressif et autres capacités HTTP.

Les niveaux, formats et la rotation sont définis dans [Tech stack & decisions](04-tech-stack-and-decisions.md). Le transport et les traitements médias ne changent pas de règles de repli à cause de la manière dont une erreur est journalisée.

## 10. Assemblage, distribution et validation

### 10.1 Serveur et Docker

Le serveur assemble les adapters SQLite, filesystem, `yt-dlp`, `ffmpeg`/`ffprobe`, services Go, handlers HTTP et fichiers frontend. Le build de production sert une SPA statique ; le mode API seul reste possible sans frontend. Le Dockerfile multi-stage fournit l'environnement Go/Web et les outils nécessaires dans une image finale non-root.

Par défaut, Docker publie le port hôte sur `127.0.0.1`, malgré l'écoute interne `0.0.0.0`. Les données du bind mount restent indépendantes de l'image ; les sauvegardes/restaurations à froid doivent être cohérentes. Aucune authentification ne protège actuellement une publication réseau générale.

### 10.2 Arrêt et opérations longues

Les téléchargements et captures vivent au niveau du serveur ; une déconnexion du navigateur ne les annule pas. L'arrêt doit stopper les descendants des outils externes et attendre la finalisation des opérations avant la fermeture de SQLite. Les acquisitions synchrones de métadonnées ou de transcriptions restent au contraire bornées par la requête et son contexte.

Une seule instance doit posséder le répertoire de données. Aucun `Job` générique persistant ni file distribuée n'est requis par l'architecture actuelle ; leur éventuelle introduction est une décision future.

### 10.3 Tests et limites des doubles

La CI déterministe couvre services/SQLite, REST/Postman, React/Playwright et Docker. Les scénarios `yt-dlp` ou `ffmpeg` testent autant que possible de **vrais exécutables avec des données synthétiques** sans dépendance réseau. Le frontend peut simuler l'IFrame API YouTube, tandis que le parcours local peut réellement décoder un média synthétique et utiliser SQLite/Range.

**Ne pas assimiler un double YouTube à une validation navigateur réelle** : politiques d'autoplay, codecs, rendu visuel, plein écran et délais des API réelles demandent les essais ciblés de [la recette manuelle](07-local-playback-validation.md). Les volumes de tests et validations ponctuelles appartiennent aux PR/CI, pas à ce document.

## 11. Extensions futures et règles de maintenance

Les extensions de recherche, MCP, IA/STT, imports locaux, autres providers, sauvegarde avancée et desktop doivent conserver les **frontières métier** ci-dessus. Leur existence dans la roadmap ou dans les questions ouvertes **n'autorise pas** à créer immédiatement ports, routes, jobs ou tables anticipés.

Lorsque le code change :

1. Mettre à jour **la section architecturale existante** et retirer la règle remplacée.
2. Mettre à jour séparément le contrat UX, le modèle métier et/ou les décisions techniques si leur périmètre est affecté.
3. Garder dans [Open questions](06-open-questions.md) seulement les choix encore ouverts, et dans [Roadmap](05-roadmap.md) seulement les étapes prévues ou leur état.
4. Utiliser Git et les PR pour les preuves de validation ; réserver `history/` aux arbitrages dont la motivation restera utile.

Éviter les annexes chronologiques, les anciennes recettes de test, les statuts de branches et les titres de type « phase N implémentée » dans cette spécification d'architecture.
