# Recherche globale

Référence technique du sous-système de recherche actuellement implémenté dans Sillage.
Elle décrit les contrats et les mécanismes à préserver lors d'une intervention sur le moteur.
Les choix visuels restent dans [Product & UX](01-product-and-ux.md) ; les identités et relations
restent dans le [modèle métier](02-domain-model.md).

## Sommaire

- [Périmètre et invariants](#périmètre-et-invariants)
- [Responsabilités et code](#responsabilités-et-code)
- [Constitution du document indexé](#constitution-du-document-indexé)
- [Synchronisation et cycle de vie](#synchronisation-et-cycle-de-vie)
- [Interprétation et pertinence](#interprétation-et-pertinence)
- [Lecture et contrat public](#lecture-et-contrat-public)
- [Explications et extraits](#explications-et-extraits)
- [Intégration Web](#intégration-web)
- [Modifier et valider](#modifier-et-valider)

## Périmètre et invariants

La recherche retourne des `Video`, une seule fois chacune, à partir de toutes leurs sources,
des publishers de ces sources, des tags directement associés et de leur note principale.
Une correspondance peut être répartie entre plusieurs champs et plusieurs sources.

Les transcriptions stockées et les tags de personnes ou de publishers sont exclus.
Une citation copiée dans une note est cependant recherchable comme texte de note.
Un `MediaFile` n'ajoute pas une source et n'alimente pas l'index.
La recherche locale dans une transcription ouverte utilise un autre mécanisme.

Les garanties essentielles sont les suivantes :

- L'index est dérivé et entièrement reconstructible depuis les données originales.
- Toute écriture métier recherchable acceptée et sa projection sont publiées ensemble.
- La recherche et la reconstruction ne réécrivent ni Markdown, ni dates, ni révisions des notes.
- Total, page, données détaillées et explications appartiennent au même instantané de lecture.
- La saisie ne donne accès à aucune syntaxe SQL ou FTS ; les explications sont du texte littéral.
- L'identité affichée reste celle de la vidéo, indépendamment des sources contributrices.

## Responsabilités et code

| Responsabilité | Point d'entrée |
| --- | --- |
| Service, port, types et limites communes | [internal/search/search.go](../internal/search/search.go) |
| Schéma et ouverture | [0010_search.sql](../internal/adapter/sqlite/migrations/0010_search.sql), [db.go](../internal/adapter/sqlite/db.go) |
| Projection et reconstruction | [search_projection.go](../internal/adapter/sqlite/search_projection.go) |
| Extraction Markdown | [search_markdown.go](../internal/adapter/sqlite/search_markdown.go) |
| Tokenisation, total et classement | [search_repository.go](../internal/adapter/sqlite/search_repository.go) |
| Provenance et extraits | [search_explanations.go](../internal/adapter/sqlite/search_explanations.go) |
| Adaptation REST | [handlers/search.go](../internal/http/handlers/search.go) |
| Commande de maintenance | [cmd/search-rebuild/main.go](../cmd/search-rebuild/main.go) |
| Client, page et extraits Web | [searchApi.ts](../web/src/searchApi.ts), [Search.tsx](../web/src/Search.tsx), [SearchExcerpt.tsx](../web/src/SearchExcerpt.tsx) |

`search.Service` valide les bornes et le choix typé `search.Sort`, indépendant du moteur et du transport, puis appelle un port spécialisé.
Le repository SQLite assure la tokenisation, la projection et les garanties de lecture.
Le handler traduit les paramètres et la réponse HTTP ; React consomme ce contrat.
Une autre interface doit réutiliser le service, sans dupliquer le moteur dans son transport.
Le service ne publie ni score SQLite ni expression MATCH.

Deux flux structurent le sous-système :

- Écriture : mutation métier acceptée → reconstruction du document vidéo → commit commun.
- Lecture : saisie → service → tokenizer → total et sélection → détails et explications → réponse.

## Constitution du document indexé

`video_search` est une table FTS5 ordinaire, avec son propre contenu textuel.
Son `rowid` est l'ID de la vidéo : le décompte des lignes correspond donc au décompte des vidéos.
Elle n'est ni une table external-content ni une nouvelle entité métier.

| Colonne | Contenu | Poids BM25 |
| --- | --- | --- |
| `titles` | Titres de toutes les sources | 8 |
| `tags` | Noms des tags directs de la vidéo | 10 |
| `note` | Texte dérivé de la note principale | 3 |
| `publishers` | Noms des publishers des sources | 2 |
| `descriptions` | Descriptions de toutes les sources | 0,5 |

Sources et tags sont lus séparément : une jointure sources × tags multiplierait artificiellement
les occurrences et fausserait le classement. Les sources sont ordonnées par ID, les tags par ID.
Chaque liste est dédupliquée par égalité textuelle stricte en conservant la première occurrence,
puis jointe avec des séparations de blocs. Les valeurs absentes donnent du texte vide.
Cette agrégation ne choisit pas de source principale et ne crée aucune association héritée.

### Texte dérivé du Markdown

Goldmark avec GFM analyse la structure plutôt que de retirer la syntaxe par expressions régulières.
L'extraction conserve les séparations utiles entre blocs et l'ordre du contenu.

| Conservé | Exclu |
| --- | --- |
| Texte des paragraphes, titres, listes et tableaux | Marqueurs structurels Markdown |
| Libellés des liens et textes alternatifs des images | Destinations, titres de liens et autoliens |
| Code inline et corps des blocs de code | Délimiteurs et langage des blocs |
| Attributions littérales et corps des citations Sillage | Marqueurs de callout et URI de leur en-tête |

Le HTML brut est ignoré ; le texte ordinaire entre balises inline reste lisible.
Les échappements et entités du texte sont décodés, mais le code conserve son contenu technique.
Une URL ou un chemin explicitement écrit dans du code reste donc recherchable : l'extraction
n'applique pas un filtre général supprimant les chaînes d'apparence technique.

Les en-têtes de citations Sillage sont repérés dans les blockquotes, hors blocs de code,
puis leur attribution est restituée à sa position sans être réinterprétée comme du Markdown.
Cet ordre importe pour la fidélité du contexte et des extraits.
L'extracteur travaille sur une représentation dérivée ; la note enregistrée reste inchangée.

## Synchronisation et cycle de vie

### Écritures et cohérence

`rebuildSearchVideo` reconstruit un document à partir des données visibles dans la transaction
métier courante. Il remplace sa ligne FTS avant le commit, sans tâche asynchrone ni trigger SQL.
Les chemins d'écriture actuellement raccordés sont :

| Écriture | Adapter responsable |
| --- | --- |
| Création d'une vidéo et de sa source | [video_repository.go](../internal/adapter/sqlite/video_repository.go) |
| Sauvegarde effective de la note | [note_repository.go](../internal/adapter/sqlite/note_repository.go) |
| Ajout ou retrait de tags directs | [tag_repository.go](../internal/adapter/sqlite/tag_repository.go) |
| Remplacement/retrait du publisher associé à une source | [publisher_repository.go](../internal/adapter/sqlite/publisher_repository.go) |

Les transactions d'écriture prennent un verrou immédiat. Si la projection échoue, la mutation
métier est annulée avec elle. Une sauvegarde de note en conflit ou sans changement ne publie
pas de nouvelle projection ; la protection par révision reste celle du repository de notes.

Les renommages généraux de tags/publishers et les rafraîchissements de sources ne sont pas
implicitement fournis par ce mécanisme. Lorsqu'on ajoute un chemin d'écriture recherchable,
il faut identifier toutes les vidéos affectées et reconstruire leurs documents dans sa transaction.
Une écriture SQL directe contournant les adapters peut désynchroniser l'index.

### Initialisation et versions

L'ouverture SQLite applique les migrations SQL, puis initialise la projection en Go.
La migration crée le schéma ; `searchProjectionVersion` décrit la représentation dérivée attendue.
Le marqueur persistant est `search_projection.version` sur l'unique ligne d'ID 1.

L'initialisation ouvre une transaction immédiate avant de lire ce marqueur :

1. Si la version correspond et qu'aucune reconstruction forcée n'est demandée, elle termine.
2. Sinon, elle efface les documents FTS et les reconstruit depuis les vidéos et leurs relations.
3. Elle écrit la version attendue et publie le tout dans le même commit.

Deux ouvertures concurrentes ne peuvent donc pas publier chacune un état partiel : la seconde
relit la version après acquisition du verrou. Une erreur ou une interruption annule la transaction.
Une prochaine ouverture retente l'initialisation si la version persistante l'exige toujours.

Changer l'extraction ou l'agrégation impose de mettre à jour la version de projection et de tester
la conversion d'une base existante. Changer la définition de la table ou son tokenizer exige aussi
une migration adaptée : incrémenter le marqueur ne modifie pas le schéma FTS existant.
Une modification de classement, de présentation ou de bornage des extraits ne change pas le texte
stocké et ne nécessite pas, à elle seule, de reconstruire la projection.

### Reconstruction explicite

Depuis la racine, arrêter le serveur puis exécuter :

```bash
go run ./cmd/search-rebuild -db data/sillage.db
```

La commande ouvre la base et force ensuite la même reconstruction, avec le même extracteur.
Le verrou d'écriture sérialise cette opération avec les mutations ; ce n'est pas une indexation
en arrière-plan. Les données originales, révisions et dates restent intactes.
Un échec conserve l'état précédemment validé ; après l'échec d'une reconstruction forcée d'une
version déjà courante, relancer explicitement la commande, car le marqueur reste courant.

La commande interne FTS `rebuild` ne remplace pas cette maintenance : elle ne réextrait pas
les notes et ne réagrège pas les relations métier. La projection ne remplace pas une sauvegarde.

## Interprétation et pertinence

Le tokenizer est `unicode61 remove_diacritics 2 tokenchars '+#'`.
La saisie est insérée comme donnée dans une table FTS temporaire ; `fts5vocab(instance)` fournit
les tokens dans leur ordre. Cette méthode évite une segmentation Go différente de celle de l'index.
Les tables temporaires restent attachées à une connexion réservée pour la requête.

Chaque token est cité séparément. Seuls les tokens entièrement composés de lettres ou chiffres
Unicode, de longueur au moins quatre, reçoivent un astérisque contrôlé. Les tokens sans lettre
ni chiffre sont écartés. Les autres termes restent entiers ; tous sont combinés par ET.

| Saisie | Interprétation |
| --- | --- |
| `kube` | Préfixe pouvant retrouver Kubernetes |
| `Go`, `API`, `SQL` | Tokens entiers, sans préfixe automatique |
| `C++`, `C#`, `C` | Trois tokens distincts, entiers |
| `.NET` | Token entier `net` |
| `node.js` | Préfixe `node` ET token entier `js` |
| `#devops`, `a+b` | Ponctuation conservée ; tokens entiers |

Les guillemets ne demandent pas une expression exacte ; les mots ressemblant à des opérateurs
restent des termes. Il n'y a ni correction de fautes, ni stemming, ni liste de stop words.
La casse et les accents latins courants composés ou décomposés sont traités par SQLite unicode61.
Cela ne garantit pas une normalisation linguistique universelle : `Straße`/`STRASSE`,
`œuvre`/`oeuvre` et caractères pleine chasse/ASCII ne sont pas des équivalences promises.

Deux classements sont disponibles, sans modifier les correspondances :

- `relevance`, par défaut : BM25 avec les poids du tableau des colonnes, puis ID vidéo croissant.
  Chez FTS5, le meilleur score numérique est le plus petit : le tri SQL est croissant.
  Ces poids favorisent des champs, sans promettre qu'un titre devance toujours une note.
  La longueur des documents et la fréquence des termes interviennent aussi dans le classement.
- `newest` : `Video.CreatedAt` décroissant, puis ID vidéo décroissant à date égale, comme la bibliothèque.
  Il s'agit de la date d'ajout dans Sillage, jamais de publication ou de modification.

Ce choix ne modifie ni le texte projeté ni sa version : aucune migration ou reconstruction
de projection n'est nécessaire pour utiliser le tri chronologique.

## Lecture et contrat public

### Instantané, total et pagination

Après la tokenisation, le repository ouvre explicitement un `BEGIN` différé sur la connexion.
Utiliser ici `BeginTx` prendrait le verrou immédiat configuré pour les écritures.
Le premier SELECT fixe l'instantané ; la fermeture utilise un rollback pour terminer cette lecture.
SQLite est utilisé sans activation de WAL : cette transaction n'élimine pas toute contention.

Le total est un `COUNT(*)` sur `video_search MATCH ?`, avec la même expression ET que la sélection.
Il ne nécessite ni jointure, ni DISTINCT, ni classement BM25. Son coût dépend des correspondances.
Le total est indépendant du tri. La sélection classée lit 21 IDs pour restituer 20 vidéos et calculer `has_more`.
Pour `newest`, les correspondances FTS sont jointes à `videos` par leur identité ; les dates UTC
canoniques à largeur fixe et à la milliseconde se classent lexicalement. `created_at DESC, id DESC`
est appliqué avant LIMIT/OFFSET dans le même instantané. Aucune jointure avec les sources ou tags
ne multiplie les résultats, aucun tri en mémoire ne reclasse une page déjà sélectionnée.
Les variantes SQL sont internes et contrôlées ; aucune expression de classement ne vient de la saisie.
Les détails sont chargés par lots, remis dans l'ordre des IDs classés, puis expliqués.
Une page vide conserve le total exact. Une saisie sans token exploitable évite MATCH et donne zéro.

Total, détails, explications et index sont lus dans le même instantané, avec un nombre constant
de lectures SQL par page. Deux appels ne partagent pas d'instantané : des modifications peuvent
changer l'ordre ou le total pendant la pagination. Les départages par ID rendent chaque sélection
déterministe sur une base stable, sans garantir l'absence de doublons ou d'omissions entre appels
si la bibliothèque change. OFFSET rend les pages profondes plus coûteuses.

### Service, REST et MCP

`Search(ctx, query, page, sort)` retourne une `search.Page` ou une erreur.
Le service résout le choix vide (`search.Sort("")`) vers `search.SortRelevance` et rejette tout autre
mode inconnu avec `ErrInvalidInput` avant d'appeler le moteur. L’interface MCP
partage donc le même défaut. Le port reçoit le choix typé résolu.
Le service valide aussi UTF-8, taille de saisie et page ; le nombre de tokens est validé après
segmentation dans l'adapter. Le handler ajoute les contraintes de forme des paramètres HTTP.

L’outil MCP `search_videos` appelle la même instance de service que REST, avec les mêmes
règles lexicales, tris, bornes, total et explications. Sa représentation compacte omet
les descriptions complètes des sources, disponibles par `get_video` ; aucune transcription
n’est ajoutée à l’index. Les entrées et sorties détaillées figurent dans [MCP](mcp.md).

| Entrée | Contrat |
| --- | --- |
| Route | `GET /api/v1/search` |
| `q` | Facultatif, vide par défaut ; UTF-8 valide, au plus 1 024 octets |
| `page` | Entier de 1 à 1 000 ; 1 si absent |
| `sort` | Exactement `relevance` ou `newest` ; `relevance` si absent, valeur explicitement vide interdite |
| Tokens | Au plus 32 tokens produits, avant exclusion des tokens sans lettre/chiffre |
| Paramètres REST | Seuls `q`, `page` et `sort`, chacun au plus une fois |

Une entrée invalide donne HTTP 400 (`bad_request`), notamment un tri vide, inconnu, de casse différente
ou répété. Une erreur interne n'expose pas le détail SQL. Le corps de réponse ne contient pas de champ `sort`.
La limite de saisie porte sur les octets UTF-8, pas sur le nombre de caractères du champ Web.

| Champ REST | Sens |
| --- | --- |
| `results` | Tableau de résultats, au plus 20 |
| `total` | Nombre exact de vidéos correspondantes, indépendant de la page et du tri |
| `page` | Numéro demandé, ajouté par le handler |
| `has_more` | Présence de résultats après la page courante |
| `results[].video` | Représentation vidéo REST habituelle |
| `results[].note_excerpt` | Tableau de segments `{text, highlight}`, vide sans correspondance de note |
| `results[].source_matches` | Contributions `{source_id, title, description, publisher}` |

Par exemple, une page dépassant les derniers résultats peut retourner :

```json
{"results": [], "page": 4, "has_more": false, "total": 41}
```

Les trois indicateurs d'une contribution sont des booléens, pas des scores.
La structure complète de `video` reste celle de l'[API existante](../README.md#api-rest).

## Explications et extraits

Le ET sélectionne les vidéos ; une expression OU des mêmes termes reconnaît ensuite les
contributions partielles. Une source n'a pas à satisfaire toute la requête pour être mentionnée.
Les sources de la page sont insérées par lot dans une table FTS temporaire ; `highlight`
identifie les champs contributeurs avec le même tokenizer, sans test par sous-chaîne.

Pour les notes, `snippet` sélectionne jusqu'à 64 tokens dans la colonne dédiée.
Un texte peut être retourné même sans correspondance dans cette colonne : seuls les extraits
contenant une marque sont conservés. Les délimiteurs sont choisis absents des textes concernés,
puis convertis en segments texte/surlignage. Ils ne sont jamais interprétés comme HTML.

Après cette conversion, l'extrait est borné à 4 096 points de code Unicode, hors ellipses ajoutées.
La fenêtre conserve la première correspondance, avec du contexte précédent ; un token immense
peut être coupé tout en gardant une portion surlignée. Le découpage respecte les caractères UTF-8,
sans promettre une segmentation par graphèmes. Les extraits déjà sous le plafond restent intacts.
Ce plafond borne la réponse et le travail du navigateur, pas le traitement initial de `snippet`.
Un nombre de tokens ne constitue pas une borne de taille en caractères.

L'extrait explique du contexte, pas toutes les occurrences ou tous les termes de la requête.
Il aide à décider d'ouvrir la vidéo ; il ne sert pas à lire toute la note dans les résultats.

## Intégration Web

[SearchForm.tsx](../web/src/SearchForm.tsx) sépare saisie et requête soumise dans l'URL.
L'URL est la source de vérité pour la requête, la page et le tri : absence de `sort` ou lien explicite
`sort=relevance` signifie « Pertinence » ; `sort=newest` signifie « Ajout le plus récent ».
Un sélecteur natif « Trier par », compact près du compteur, reste monté pendant le chargement pour
préserver son focus, et disponible sur les pages vides. Un mode invalide est signalé, même sans requête ;
l'invitation ne doit pas le masquer et il n'est pas converti en pertinence.

Changer le tri conserve la requête soumise, jamais le brouillon du champ, et supprime `page`.
Revenir à Pertinence retire `sort` des URL produites. La pagination conserve requête et tri ;
rechargement et historique restaurent les trois paramètres.
La soumission est explicite, conserve le tri courant depuis `/search` et revient à la première page.
Depuis un autre parcours, une recherche commence en pertinence ; aucune préférence globale n'est stockée.
Une soumission identique crée une nouvelle navigation et relit les données ; les réponses obsolètes
sont annulées ou ignorées, y compris après des changements rapides de tri.
Les tags ouvrent la bibliothèque filtrée par leur ID.

La première source REST fournit l'identité visuelle. Sa chaîne et la date d'ajout `video.created_at`
sont affichées sur la même ligne, avec une date française abrégée dans le fuseau du navigateur.
Les explications complémentaires conservent leur contenu dans un popover natif, ouvert par une icône
d'information après la date. L'icône est absente si seule la première source contribue par son titre.
Le survol ouvre après 300 ms et un passage plus bref est ignoré. Clic, Entrée et Espace ouvrent
immédiatement ; Échap ou clic extérieur ferment la couche.
Le panneau est borné au viewport, défilable au clavier et au toucher ; les interactions ne font aucun appel réseau.

`SearchExcerpt` réduit les blancs, mesure deux lignes autour d'une marque et recalcule
selon les dimensions. Sa sonde est hors du flux et de l'arbre accessible.
« Voir plus » utilise uniquement l'extrait reçu, sans appel réseau ; son état est propre au résultat
et réinitialisé lorsque la recherche ou l'extrait change.

La navigation depuis une fiche respecte le garde de note avant de focaliser le champ.
Les actions d'interface ne doivent ni sauvegarder la note ni dégrader sa session d'édition.
Les règles visuelles et d'accessibilité sont définies dans [Product & UX](01-product-and-ux.md).

## Modifier et valider

Avant une modification, identifier si elle affecte le texte stocké, la sélection, le contrat
ou seulement sa présentation. Préserver les transactions et mettre à jour cette référence
lorsque le comportement change ; ne pas exposer de détail moteur dans les interfaces.

| Modification | Régressions à vérifier dans `internal/adapter/sqlite/` sauf indication |
| --- | --- |
| Tokenizer, préfixes, classement | `search_test.go`, `search_corpus_test.go` : termes techniques, Unicode, corpus et exclusions |
| Projection et écritures | Mêmes fichiers : révisions, rollback, concurrence, ouverture, interruption et crash |
| Extraction Markdown | `search_markdown_test.go`, `search_explanations_test.go` : code, callouts, ordre et version précédente |
| Tri, total et pagination | `search_sort_test.go`, `search_total_test.go`, `search_test.go` : dates indépendantes des IDs, égalités, différence avec BM25, ensemble et explications identiques, frontières de pages, pages partielles/vides et instantané commun sous mutations pour les deux modes |
| Service | `internal/search/search_test.go` : défaut, transmission du type et rejet avant le moteur |
| Extraits et provenance | `search_explanations_test.go` : multi-sources, collisions, UTF-8, tokens géants, note intacte |
| REST et confidentialité | `internal/http/search_test.go`, `internal/http/search_logging_test.go` |
| Intégration Web | `web/tests/search.spec.ts`, `search-excerpts.spec.ts`, `search-tags.spec.ts` : réseau contrôlé et REST/SQLite réels, URL, historique, rechargement, soumissions, brouillon, réponses tardives, clavier/focus, thèmes, petits écrans et zoom |

Commandes depuis la racine, à sélectionner selon le changement :

```bash
make test
make test-web
go test -race ./internal/adapter/sqlite ./internal/http
go test ./internal/adapter/sqlite -run '^$' -bench 'Benchmark(SearchLibrary|LimitSearchExcerpt)' -benchmem
git diff --check
```

Les benchmarks utilisent des données temporaires : bibliothèque de 2 000 vidéos, requêtes
sélectives/fréquentes et pages profondes/vides dans les deux modes, reconstruction, sauvegarde et bornage de tokens géants.
Comparer les mesures dans un même environnement ; elles ne constituent pas une garantie de latence.
Les tests navigateur avec doubles externes ne prouvent pas le comportement réel de YouTube.

Pour diagnostiquer, distinguer une limite de tokenisation, une projection désynchronisée,
une page devenue vide et une explication partielle. Ne pas contourner les adapters pour corriger
une donnée sans reconstruire sa projection. La maintenance rapporte un bilan sans contenu privé.
Les journaux doivent identifier la route et l'opération, jamais la saisie brute, les notes,
les destinations de liens ou les détails SQLite susceptibles de contenir des données utilisateur.
