# MCP — lectures locales de Sillage

Cette référence définit la première tranche MCP. Le serveur fournit les données ;
le client choisit les appels et le modèle produit son résumé. Aucune IA ne tourne dans Sillage.

## Périmètre et assemblage

L’adapter `internal/adapter/mcp` utilise le SDK Go officiel
[`github.com/modelcontextprotocol/go-sdk` v1.8.0](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0),
épinglé dans `go.mod`, compatible avec Go 1.27.1.
Le [guide du SDK](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/server.md)
et son [transport](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/streamable.go)
définissent les comportements protocolaires utilisés.

Le point de composition `cmd/server` partage les instances de `search.Service`,
`video.Service`, `transcript.Service` et `note.Service` avec REST.
Les interfaces de l’adapter ne donnent accès qu’à `Search`, `GetVideo` et aux deux
lectures `Get`. Il n’appelle jamais REST, `Fetch`, un provider distant ou une écriture.
Le SDK et les DTO MCP restent hors du cœur applicatif.

Le seul endpoint est `/mcp`, en **Streamable HTTP stateless**, avec réponses JSON.
Il ne crée aucune session applicative ni stockage de reprise. Le SDK gère découverte,
initialisation historique, négociation et erreurs de protocole. Aucun transport STDIO
ou HTTP+SSE historique n’est ajouté. GET et DELETE ne proposent pas de flux autonome.
La route et ses sous-chemins sont réservés avant la SPA : désactivé, `/mcp` renvoie
404 ; activé, les méthodes non prises en charge sont refusées par le SDK.
REST, les fichiers statiques et les navigations Web gardent leurs routes.

Exactement quatre tools sont annoncés, annotés comme lectures idempotentes,
non destructives et sans accès distant. Aucune resource, prompt, subscription,
capacité de logging MCP, notification de changement de liste ou autre capacité
optionnelle n’est annoncée.

## Contrats communs

Les entrées sont des objets à propriétés fermées. Les IDs sont des entiers positifs
sur l’espace des identités Sillage ; un ID externe n’est pas un `source_id`.
Les options absentes reçoivent leur défaut ; `null`, chaîne vide pour une enum,
valeur inconnue, mauvais type et propriété supplémentaire sont invalides.
Les dates civiles sont des chaînes **UTC RFC 3339** ; les positions et durées sont
des entiers en **millisecondes**. Une durée inconnue reste `null`, jamais zéro.
Une chaîne optionnelle vide reste une information inconnue selon le modèle.

Chaque succès contient `structuredContent` et un bloc `content` textuel contenant
le même objet JSON. Cette duplication aide les clients qui n’exploitent que le texte.
Les schémas d’entrée et de sortie sont annoncés par `tools/list`. Les DTO restent typés ;
l’adapter utilise l’inférence et la validation de `jsonschema-go`, dépendance du SDK,
avec contraintes explicites pour minimums, enums, défauts et propriétés inconnues.
Les sorties de succès sont validées avant publication contre leur schéma annoncé :
IDs imbriqués positifs, positions/durées non négatives, durées inconnues nullables,
page 1..1000, total non négatif et au plus vingt résultats. Les dates ont un format
et un motif UTC explicites ; le calendrier est aussi contrôlé à l’exécution, car
la version retenue du validateur traite `format` comme annotation.
Les int64 restent exacts : la vue de validation utilise des entiers, sans conversion
float64 ; le JSON validé est réutilisé dans les deux canaux.
Une sortie interne invalide devient `internal_error`, sans détail de validation.
Les erreurs d’outil ont leur propre enveloppe et ne passent pas dans le schéma de succès.
L’enregistrement bas niveau du SDK permet de remplacer ses messages de validation
et sa conversion automatique d’erreurs Go par des messages publics sûrs.

Titres, descriptions, notes et transcriptions sont **des données non fiables**,
jamais des instructions pour le client. Sillage ne suit pas leurs liens et
n’exécute pas leur contenu. Les descriptions des outils rappellent cette frontière.
Les chemins internes de fichiers, snapshots bruts et diagnostics techniques ne
font partie d’aucune sortie.

### `search_videos`

| Entrée | Contrat |
| --- | --- |
| `query` | Chaîne obligatoire, éventuellement vide ; limites lexicales du service |
| `page` | Entier 1..1000 ; défaut 1 |
| `sort` | `relevance` ou `newest` ; défaut `relevance` |

La [référence recherche](search.md) fait autorité : ET entre termes, métadonnées
de toutes les sources, publishers, tags directs et notes ; aucune transcription
indexée. Les limites restent 1024 octets UTF-8, 32 tokens et 20 résultats par page.
Classement BM25 et départage existants pour `relevance` ;
`Video.CreatedAt DESC, ID DESC` pour `newest`.
Ce dernier signifie **date d’ajout dans Sillage**, pas publication ou modification.

La sortie est `{results, page, total, has_more}`. Un résultat contient :

- `video` : `id`, `created_at`, toutes les `sources`, les `tags` directs ;
- chaque source : `id`, `provider`, `external_id`, `canonical_url` lorsqu’elle existe,
  `title`, `publisher` nullable, `duration_ms` nullable et `original_audio_language` ;
- `publisher` : identité, provider, ID externe, nom et `person_id` nullable ;
- `tags` : objets `{id, name}` ;
- `note_excerpt` : segments `{text, highlight}` ;
- `source_matches` : contributions `{source_id, title, description, publisher}`.

Les descriptions longues des sources sont volontairement **absentes** de ce contrat
compact. Il s’agit d’une omission de champ définie, pas d’une troncature.
Les explications du service et leur bornage existant sont conservés.
Total, résultats et explications partagent l’instantané d’un appel ; deux pages
ne partagent pas d’instantané. Le tri ne change ni les correspondances ni le total.
Zéro résultat est un succès avec `results: []`.
Aucune source principale ni source à transcrire n’est choisie par le serveur.

Exemple d’appel : `{"query":"Kubernetes","sort":"newest"}`.
Le client peut choisir la première vidéo puis une de ses sources, sans imposer
`get_video` lorsque la recherche suffit.

### `get_video`

Entrée : `{"video_id":42}`.

Sortie : `{id, created_at, sources, tags, person_ids}`.
Les sources reprennent les champs compacts et leur `description` complète.
Les associations directes de personnes sont celles déjà chargées par `GetVideo`.
Le publisher appartient à sa source ; ses relations ne deviennent pas des tags
ou personnes directs de la vidéo.

Aucune note, transcription, disponibilité de transcription, représentation média
ou capture n’est chargée. Les langues disponibles ici sont celles du modèle source,
notamment la langue audio originale ; il n’y a pas de catalogue de captions supplémentaire.

### `get_transcript`

| Entrée | Contrat |
| --- | --- |
| `video_id` | ID vidéo obligatoire |
| `source_id` | ID source obligatoire, appartenant à cette vidéo |
| `format` | `text` ou `timed` ; défaut `text` |

Cet outil lit **la dernière acquisition locale sélectionnée par la politique actuelle
du service**, après vérification de l’appartenance. Il ne change ni de source,
ni de langue, ni de version et ne lance jamais `Fetch`.
La [politique de transcription](03-architecture.md#24-transcriptions) reste celle du service.

Les deux formats fournissent `video_id`, `source_id`, `transcript_id`, `language`,
`provenance`, `last_fetched_at`, `format`, `complete: true`.

- `text` impose `text` non nul et interdit `fragments`. Sa valeur vient de `TranscriptContent.PlainText()` :
  concaténation et normalisation des blancs du service, sans ponctuation ajoutée,
  réécriture ni synthèse.
- `timed` impose `fragments: [{start_ms, text}, ...]` non nul et interdit `text` :
  ordre et blancs d’origine, timestamps égaux ou décroissants conservés.
  Aucun tri, `end_ms`, locuteur, découpage en phrases ou regroupement n’est inventé.

Le schéma impose `complete: true` pour chaque succès. `complete` signifie tous les éléments stockés, **sans garantie de couverture
exhaustive ni d’exactitude de l’audio**. La transcription appartient à cette source ;
les timelines de plusieurs sources ne sont pas nécessairement synchronisées.
La langue des captions peut différer de celle de l’audio.
`transcript_id` n’est pas une identité de version immuable.
Il n’y a ni pagination, ni troncature, ni bascule automatique de format.

### `get_note`

Entrée : `{"video_id":42}`.

Sortie : `{video_id, content_md, revision, created_at, updated_at}`.
Le Markdown enregistré est restitué sans transformation supplémentaire, rendu HTML
ou suivi de références. Une note absente produit `note_not_found` ; une note sauvegardée
vide réussit avec `content_md: ""`. La lecture ne crée ni note ni révision et ne change
aucun horodatage. Les règles de sauvegarde existantes restent dans
[l’architecture](03-architecture.md#23-notes-et-concurrence).

## Erreurs et journalisation

Une erreur d’outil a `isError: true` et, dans les deux canaux,
`{"error":{"code":"…","message":"…"}}`. Elle peut être transportée avec **HTTP 200**.

| Code stable | Situation |
| --- | --- |
| `invalid_arguments` | Forme, ID, enum ou limite du service invalide |
| `video_not_found` | Vidéo inconnue |
| `source_not_found` | Source inconnue ou appartenant à une autre vidéo |
| `note_not_found` | Aucune note enregistrée |
| `transcript_not_found` | Aucune acquisition locale sélectionnable |
| `transcript_read_failed` | Snapshot référencé absent, corrompu, invalide ou hors de sa limite existante |
| `response_too_large` | Résultat sérialisé dépassant le plafond |
| `deadline_exceeded` | Délai de lecture dépassé |
| `canceled` | Annulation du client ou du serveur |
| `busy` | Concurrence de lectures saturée |
| `internal_error` | Autre échec, sans diagnostic technique public |

Une acquisition absente et un snapshot illisible sont distincts. Aucune erreur
ne déclenche de réparation ni d’acquisition. Les causes Go restent utilisables
dans les services ; elles ne sont jamais retournées telles quelles au client.

Les erreurs protocolaires, la négociation et les méthodes inconnues restent au SDK.
En HTTP, Host/Origin refusés donnent 403, corps trop grand 413, transport saturé ou
arrêt en cours 503 avec refus immédiat ; saturation : `Retry-After: 1`.
Les lots sont refusés avec HTTP 400 avant le SDK et avant tout appel métier, quelle
que soit la présence de l’en-tête de version. Ce refus de transport ne constitue
pas une erreur d’outil `response_too_large`.

Le bilan `http.completed` reste distinct de `mcp.tool_completed`.
Ce dernier contient seulement le nom contrôlé, la durée, le code de résultat
et la corrélation HTTP du dépôt. Aucun argument, recherche, Markdown,
transcription, chemin, URL ou diagnostic arbitraire n’est journalisé.
Les logs internes du SDK sont désactivés ; son protocole de logging n’est pas annoncé.

## Limites expérimentales

| Limite | Valeur retenue |
| --- | --- |
| Corps HTTP, longueur connue ou chunked | 64 Kio = 65 536 octets, avant inspection du préfixe puis par le SDK |
| Résultat d’un outil sérialisé | 8 Mio = 8 388 608 octets |
| Corps HTTP de réponse global | 8 782 848 octets : résultat + 6 × requête maximale pour les échappements des IDs JSON-RPC + 1024 octets de réserve |
| Lecture du corps HTTP | 15 secondes |
| Lecture applicative | 30 secondes |
| Marge HTTP de finalisation/envoi | 5 secondes supplémentaires ; budget HTTP total 50 secondes |
| Concurrence | 4 lectures et 4 requêtes HTTP actives ; aucune file d’attente |
| Snapshot local | Limite existante de 16 Mio conservée |

Ces valeurs généreuses sont **révisables**, fixées dans l’adapter sans nouvelles
variables de réglage. Le délai REST des acquisitions ne borne pas MCP.
Le budget HTTP réserve séparément lecture réseau, traitement et envoi : un corps lent
ne consomme pas la marge nécessaire à la réponse d’erreur applicative.

Le plafond d’outil s’applique aux **octets UTF-8 de l’objet JSON final `result`**
d’une réponse JSON-RPC, sans espaces ajoutés : `structuredContent`, blocs `content`,
échappements, `isError` lorsqu’il est présent et champs ajoutés par le SDK.
Pour `2026-07-28`, cela inclut `resultType` et `_meta` avec l’identité serveur.
L’enveloppe `{"jsonrpc":…,"id":…,"result":…}` et le corps HTTP complet sont
distincts et exclus de ce plafond d’outil. Notes et métadonnées y sont aussi soumises.

La mesure se fait dans un middleware receveur après `callTool`, lorsque le SDK a
fixé `resultType`. Le middleware renseigne l’identité via `Meta` ; le SDK conserve
cette valeur au stade final. Les tests observent les octets effectivement reçus pour
chaque version et aux trois frontières : juste sous le plafond, au plafond, au-dessus.
Ils constituent une protection contre un changement de sérialisation du SDK épinglé.

Un prévol spécifique aux DTO peut refuser un résultat déjà manifestement trop grand,
sans produire sa sérialisation complète. Il compte une **borne inférieure**, incluant
des échappements garantis et les éléments des listes timed. Avant `PlainText()`,
un prévol supplémentaire ne compte que les caractères ASCII non blancs conservés ;
Unicode et séparateurs sont ignorés dans cette borne. Le contenu admissible continue
d’utiliser exactement `PlainText()`.
L’erreur annonce `limit_bytes` et soit `serialized_bytes` (mesure exacte du résultat
final refusé), soit `serialized_bytes_at_least` (borne inférieure du prévol).
Elle ne retourne aucun morceau du contenu. En `timed`, le client peut demander
explicitement `text` ensuite ; aucun changement automatique de format.

Les lots ne sont jamais exécutés : il n’existe plus de cumul de résultats terminés.
La réponse HTTP est retenue jusqu’à sa validation dans un buffer borné.
Son garde final est une **défense exceptionnelle** de l’enveloppe, pas le chemin
normal d’un résultat trop grand. Un débordement de ce garde signale un défaut interne :
HTTP 500, code sûr `internal_error`, aucun contenu initial envoyé. Cette réponse
de transport n’est pas présentée comme une erreur d’outil ni une réponse JSON-RPC corrélée.

Ces bornes ne promettent pas un plafond mémoire strict. Les services ont déjà chargé
leurs données ; conversion des DTO, validation des sorties, SDK et buffers HTTP
allouent aussi de la mémoire. Le prévol évite notamment les grandes allocations
`PlainText`/JSON sur les refus évidents ; les résultats proches du seuil peuvent
encore être sérialisés entièrement avant refus. Un nombre de fragments déjà inadmissible est refusé avant copie des DTO timed ;
les autres parcours timed allouent leurs DTO.
Les [mesures reproductibles](../tests/mcp/README.md#allocations-et-mémoire) distinguent
volume transmis, allocations cumulées serveur/client et pic RSS du processus de test.
Quatre réponses échappées simultanées d’environ 1,23 Mo chacune ont notamment coûté
environ 193 Mo d’allocations cumulées ; ce chiffre n’est pas un pic mémoire serveur.
Les limites restent généreuses et révisables ; pas de pagination ou de troncature.

Les contextes annulent les lectures, y compris les clients historiques pour lesquels
le SDK détache nativement l’annulation HTTP. L’option SDK
`PropagateRequestCancellation` reste activée pour le protocole récent.
Les délais et annulations restent coopératifs pour les opérations CPU : un encodage
JSON ou un `PlainText` déjà lancé n’est pas interrompu de force. Le contexte est
revérifié avant publication ; les délais réseau bornent les lectures/envois.
L’arrêt interdit les nouveaux appels, annule ceux en cours et attend les handlers
avant fermeture des services et de SQLite. Aucune transaction SQLite ne reste
ouverte pendant l’envoi réseau.

Un résultat accepté par le serveur peut être coupé, réduit ou ignoré par le client
avant d’atteindre le modèle. La fenêtre de contexte du modèle constitue encore
une autre limite. `complete: true` décrit la réponse Sillage, pas ce que le modèle a reçu.
La vérification de marqueurs début/milieu/fin est un contrôle par échantillonnage lors des essais agents.
Un problème client sur des transcriptions représentatives demande un arbitrage ;
il n’autorise pas l’ajout implicite d’une pagination.

## Activation et sécurité locale

MCP est **désactivé par défaut**. Dans un environnement Linux/WSL local :

```bash
make build
SILLAGE_MCP_ENABLED=true SILLAGE_WEB_DIR=web/dist ./bin/sillage
```

Le client utilise l’URL **`http://127.0.0.1:8080/mcp`**, en transport Streamable HTTP.
Le serveur reste à l’écoute sur `127.0.0.1:8080` par défaut.

| Variable | Sens |
| --- | --- |
| `SILLAGE_MCP_ENABLED` | Activation explicite ; défaut `false` |
| `SILLAGE_MCP_ALLOWED_AUTHORITIES` | Liste séparée par virgules de `hôte:port`, sans espaces, URL ni wildcard |

Hors Docker, la liste par défaut est `127.0.0.1:PORT,localhost:PORT,[::1]:PORT`,
avec le port de `SILLAGE_HTTP_ADDR`.
Seuls `localhost` et les IP loopback avec port numérique explicite sont admissibles.
Une configuration activée invalide empêche le démarrage.

Chaque Host doit appartenir à cette liste. Un Origin absent est accepté pour les
clients natifs ; un Origin présent doit être **exactement** `http://AUTORITÉ` pour
une autorité configurée, sans slash final, identifiants, query ou fragment.
Origin vide, `null`, multiple, HTTPS ou non autorisé est refusé.
Le contrôle explicite précède `http.CrossOriginProtection` ; les signaux
`Sec-Fetch-Site` ne permettent pas de contourner l’allowlist.
Aucun en-tête `Forwarded` ou `X-Forwarded-*` ne fait autorité.
La protection SDK contre le DNS rebinding loopback reste activée.

En Docker, garder la publication `127.0.0.1:PORT:8080` du Compose fourni.
Son écoute interne `0.0.0.0` ne change pas les autorités HTTP autorisées.
Par exemple pour publier sur le port hôte 8081 :

```bash
SILLAGE_PORT=8081 SILLAGE_MCP_ENABLED=true \
SILLAGE_MCP_ALLOWED_AUTHORITIES='127.0.0.1:8081,localhost:8081,[::1]:8081' \
docker compose -f deployments/docker/compose.yaml up -d --build
```

Le contrôle est dans l’adapter et fonctionne aussi lorsque l’adresse locale observée
dans le conteneur n’est pas loopback. Il ne dépend donc pas uniquement de la protection
automatique du SDK. Ne pas désactiver globalement les protections pour Docker.
La recette Docker isolée a vérifié une image construite depuis le code corrigé,
la publication loopback sur un port hôte personnalisé, les trois protocoles avec
le client SDK depuis WSL, la découverte depuis Windows, une lecture locale, REST,
SPA, asset distribué, les refus Host/Origin et l’arrêt SIGTERM propre.
Elle utilise uniquement une bibliothèque temporaire ; détails et reproduction dans
la [recette de déploiement](../tests/mcp/README.md#déploiement-docker-isolé).

**Host et Origin ne sont pas une authentification.** Un programme pouvant joindre
le serveur peut forger ces en-têtes. Cette V1 sans authentification suppose un accès
effectivement restreint au développement local. MCP est en lecture seule, mais
**REST sur le même serveur possède des écritures**. Un client local peut transmettre
notes, métadonnées et transcriptions à un modèle distant.
Toutes les réponses MCP imposent `Cache-Control: no-store, private` ;
les résultats de découverte/listes ont aussi un scope privé et TTL nul dans le SDK.

Cette V1 n’est pas destinée à une exposition LAN générale ou publique.
Un déploiement homelab exige un cadrage séparé de la sécurité de **tout le serveur,
REST compris**. OAuth, Authelia, clés API, reverse proxy de confiance et HTTPS
ne sont pas introduits dans cette tranche.

## Compatibilité et validation reproductible

Les tests du vrai endpoint avec le client Go du SDK v1.8.0 vérifient
`2026-07-28`, `2025-11-25` et `2025-06-18`.
`ServerOptions.SupportedProtocolVersions` restreint explicitement l’annonce et la
négociation à ces trois révisions. Une ancienne version explicitement envoyée est
refusée par le SDK ; Sillage ne réimplémente ni découverte ni négociation.
Une requête objet sans en-tête reste transmise au SDK pour préserver l’initialisation
historique normale. Le SDK v1.8.0 choisit encore son repli historique pour les
requêtes sans en-tête, même avec une liste restreinte : ce comportement n’étend pas
la compatibilité annoncée. Sillage inspecte uniquement le premier octet JSON après
les blancs, sous le plafond de requête, pour refuser les tableaux avant décodage.
Cela ferme le chemin des lots sans en-tête ; ni gestion de lots ni reconstruction
JSON-RPC ne sont ajoutées.
Les schémas annoncés, les formats, les erreurs, les seuils HTTP/résultats,
la concurrence, les annulations et l’arrêt sont vérifiés sur ce transport.
Les tests de routage couvrent activation/désactivation, API seule et SPA ;
l’assemblage peut aussi être vérifié avec le frontend réellement compilé :

```bash
make test
go test -race ./internal/adapter/mcp ./internal/http ./internal/transcript ./cmd/server ./internal/adapter/sqlite
make build
SILLAGE_TEST_DISTRIBUTED_WEB="$PWD/web/dist" go test ./cmd/server -run TestRunMCP -count=1
git diff --check
```

Pour les vrais agents, utiliser la bibliothèque jetable du test opt-in :

```bash
SILLAGE_MCP_AGENT_FIXTURE=1 \
go test ./internal/adapter/mcp -run '^TestAgentFixture$' -v -count=1 -timeout=12m
```

Elle sert `http://127.0.0.1:18482/mcp`, n’utilise aucune donnée personnelle et
s’arrête après dix minutes, Ctrl+C ou SIGTERM. Elle contient une ancienne vidéo
Kubernetes très pertinente, une correspondance plus récente moins pertinente,
des vidéos encore plus récentes sans correspondance et deux sources pour la vidéo
sélectionnée. Sa transcription synthétique locale a trois faits distinctifs
ORION-DEBUT, LYRA-MILIEU et VEGA-FIN. La durée est une métadonnée de simulation :
ce corpus ne constitue pas une transcription représentative d’un audio réel.

Dans un autre terminal, Codex CLI peut être lancé sans configuration persistante :

```bash
codex exec --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only \
  -c 'mcp_servers.sillage.url="http://127.0.0.1:18482/mcp"' \
  'Retrouve la dernière vidéo ajoutée portant sur Kubernetes et fais-en un résumé. Utilise uniquement les outils MCP Sillage pour consulter la bibliothèque de test, sans commande shell ni accès Web.'
```

Lancer ce client depuis un dossier de test vide ; aucun `codex mcp add` n’est requis.
Ces overrides temporaires sont décrits par la
[documentation officielle de Codex](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli).
Ne pas modifier sa configuration durable pour une recette.
Pour un modèle local, identifier **l’hôte MCP**, par exemple Codex CLI connecté
à un provider Ollama/LM Studio déjà installé ; le modèle seul n’est pas un client.
Choisir explicitement un modèle local disponible selon la documentation du client,
sans installer une infrastructure dans le cadre de cette recette.

Arrêter puis relancer la fixture avec `SILLAGE_MCP_AGENT_MINUTES=10`, `30`, `60`
jusqu’à `240` pour augmenter progressivement le corpus.
`SILLAGE_MCP_AGENT_SCENARIO` accepte `missing`, `empty_note`,
`contradictory_note`, `oversized` et `malicious`.
Ces variables concernent uniquement le test opt-in, jamais le serveur produit.
Le terme `Helios-only-caption` n’apparaît que dans le contenu de transcription :
une recherche globale de ce terme doit être vide.

Pour chaque client/modèle :

1. Consigner version de l’hôte, modèle/provider, contexte et plafond de sortie configurés,
   protocole s’il est observable, corpus et limites serveur.
2. Envoyer la demande Kubernetes ; vérifier requête ciblée et `sort=newest`,
   choix de la première bonne vidéo dès la première page et identification de source.
3. Vérifier la lecture locale puis un résumé attribué à cette source et à sa transcription.
   `get_video` reste facultatif si la recherche suffit.
4. Mesurer octets texte, taille JSON complète, fragments et latences serveur/client ;
   la fixture instrumente protocole observable, nom contrôlé, format demandé
   (y compris le défaut), octets HTTP et durée, sans imprimer les arguments.
   Le mode CLI JSON permet de vérifier les arguments sur ce corpus jetable ;
   vérifier les trois faits distinctifs dans le contenu réellement accessible au modèle.
5. Avec transcription absente, garder la vidéo choisie et annoncer l’absence.
   Ne pas remplacer par une ancienne vidéo ni qualifier les métadonnées de résumé de transcription.
6. Vérifier plusieurs sources/langues, note absente/vide/contradictoire, sujet seulement
   dans les captions, dépassement explicite et instructions malveillantes traitées comme données.
7. Compléter avec de vraies transcriptions représentatives de 10–30 minutes, puis plus longues,
   dans une bibliothèque de test distincte. Arrêter et supprimer seulement cette bibliothèque
   jetable après l’essai, sans toucher aux données personnelles.

Une acquisition publique réelle peut aussi être préparée explicitement **hors MCP**,
puis relue par `TestAgentPublicFixture`. La préparation et le contrat du répertoire
d’entrée figurent dans la [recette agents](../tests/mcp/README.md#préparer-une-caption-publique-réelle).
Ce test ne récupère rien sur le réseau : il copie le snapshot déjà préparé dans
sa propre bibliothèque temporaire.

Les [résultats d’essais agents](../tests/mcp/README.md) distinguent ce qui a été réellement
observé des validations restantes. La réussite des tests Go n’établit ni la qualité
d’un résumé, ni la capacité d’un client à transmettre une longue transcription à son modèle.
