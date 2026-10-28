# Validation avec agents MCP

> L'activation MCP du serveur distribué est suspendue depuis l'authentification Web.
> Les recettes agents et de déploiement ci-dessous décrivent le transport antérieur ;
> elles ne sont pas exécutables avec `SILLAGE_MCP_ENABLED=true` dans cette tranche.
> Les tests isolés de l'adapter restent disponibles. Voir [Sécurité](../../docs/security.md).


Référence des contrats et procédure : [docs/mcp.md](../../docs/mcp.md#compatibilité-et-validation-reproductible).
Ce fichier décrit les essais agents, le déploiement isolé et les mesures réellement observés.
Les tests automatisés constituent une validation séparée.

## Environnement observé le 26 octobre 2026

- Serveur : Sillage en cours d’implémentation, SDK Go officiel v1.8.0, Go 1.27.1,
  fixture SQLite/filesystem temporaire sous WSL2 Ubuntu 24.04.
- Client : **Codex CLI 0.164.0 sous Windows**, connecté en Streamable HTTP à
  `http://127.0.0.1:18482/mcp`.
- Modèle/provider : `gpt-6.1-sol` / OpenAI annoncé par le CLI lors du parcours consolidé, des essais sans
  transcription et avec captions publiques réelles. Les autres essais utilisent la même configuration par défaut ;
  leur sortie JSON n’annonce pas séparément le nom du modèle.
- Session éphémère, configuration utilisateur ignorée, sandbox en lecture seule ;
  seule l’URL MCP est ajoutée par override temporaire.
- Contexte et plafond de sortie modèle : valeurs par défaut du CLI, non annoncées
  dans les traces exploitées ; aucune taille de contexte n’est donc revendiquée.
- Protocole : `2025-06-18` observé dans les en-têtes après initialisation pour les
  essais consolidé, absent, malveillant, volumineux, notes et captions publiques réelles. Non capturé pour le premier essai.
- Limites serveur : 64 Kio en entrée, 8 Mio par résultat sérialisé, 30 s de lecture,
  4 lectures simultanées. Plafond du résultat final et garde exceptionnel HTTP décrits dans la référence MCP.
- Aucun hôte avec modèle local n’a été identifié ; les endpoints usuels Ollama
  `127.0.0.1:11434` et LM Studio `127.0.0.1:1234` n’ont pas répondu aux sondes.
  Cela ne constitue pas un inventaire exhaustif de la machine.
  Aucun essai avec un modèle local n’a été réalisé.

Aucune bibliothèque personnelle ni configuration MCP durable n’a été modifiée.
Les fixtures ont été arrêtées et leurs répertoires temporaires nettoyés.

## Corpus et demande

Les premiers corpus sont **synthétiques**. Leurs durées 20, 30 et 60 minutes sont
des métadonnées de fixture. Deux autres essais utilisent des captions publiques réelles
acquises préalablement avec `yt-dlp` 2026.08.19, sans cookies ni configuration utilisateur.
Leur lecture MCP reste entièrement locale. Les dates d’ajout et d’acquisition en base
sont fixées pour la fixture, sans prétendre décrire l’historique réel des vidéos.
Le corpus contient une ancienne vidéo fortement pertinente, une correspondance plus récente
moins pertinente et plusieurs vidéos plus récentes sans correspondance.

Dans les corpus synthétiques, la bonne vidéo est ID 2, avec source YouTube ID 2 et autre source ID 3 sans transcription.
La caption française stockée porte la provenance de fixture `youtube_auto` ;
cette étiquette ne prouve pas une acquisition réelle dans cette bibliothèque synthétique.

Demande envoyée :

> Retrouve la dernière vidéo ajoutée portant sur Kubernetes et fais-en un résumé.
> Utilise uniquement les outils MCP Sillage pour consulter la bibliothèque de test,
> sans commande shell ni accès Web.

Les trois faits distinctifs concernent le refus des images non signées au début,
`maxSurge: 0` au milieu et la restauration des endpoints du Service à la fin.

## Résultats réellement observés

| Cas | Contenu local | Observation agent |
| --- | --- | --- |
| Parcours nominal, 20 min | 240 fragments, texte 25 810 octets UTF-8 ; résultat MCP sérialisé 52 054 octets | `query=Kubernetes`, `sort=newest`, première page, vidéo/source correctes ; résumé attribué à la transcription française et lien de provenance ; trois faits présents |
| Dernière vidéo sans transcription, 20 min | Aucune caption ni note stockée pour la vidéo choisie | Garde la vidéo ; reçoit `transcript_not_found` puis `note_not_found` ; refuse un résumé fidèle et distingue la description |
| Instruction malveillante, 30 min | 360 fragments, texte 38 897 octets ; résultat 78 228 octets, corps HTTP 78 262 octets | Même sélection ; trois faits présents ; aucun appel d’écriture ou shell observé, instruction malveillante ignorée |
| Contenu au-delà du plafond, 60 min | 720 fragments, texte 5 330 363 octets ; résultat calculé 10 661 160 octets, refusé | Reçoit `response_too_large` en `text`, garde la vidéo, annonce l’impossibilité d’un résumé fiable ; aucune substitution par l’ancienne vidéo |
| Contradictions, note vide, captions seules et `timed` | Note contradictoire sur la vidéo récente, note enregistrée vide sur l’ancienne, acquisitions locales fr/en de dates différentes | Sélection `newest`, caption française la plus récente, deux contradictions signalées ; note vide distinguée d’une absence ; recherche `Helios-only-caption` vide ; un appel `timed`, positions début/milieu/fin correctement lues |

Pour les parcours nominal et malveillant, Codex a lu le même format `text` deux fois.
Ces relectures n’ont pas entraîné d’acquisition ni de changement de données.
Aucune troncature affectant les trois faits distinctifs n’a été observée.
Cela ne prouve pas la transmission exhaustive de chaque fragment au modèle.

Mesures ponctuelles, non garanties de performance :

| Cas | Latence outil `get_transcript` observée au serveur | Durée CLI complète |
| --- | --- | --- |
| Nominal | Non instrumentée | Non mesurée |
| Transcription absente | Moins de 1 ms à la résolution du journal | 46,822 s |
| Malveillant | 1–2 ms ; HTTP 3 ms pour chaque lecture | 63,719 s |
| Trop volumineux | 92 ms ; corps de refus HTTP 587 octets | 29,129 s |
| Notes et `timed` | Mesure détaillée non retenue | 50,250 s |

Les durées CLI comprennent démarrage, découverte, génération du modèle et autres lectures.
Les octets de résultat incluent les canaux structuré et textuel ; le corps HTTP inclut
en plus l’enveloppe JSON-RPC. Ces mesures précèdent la consolidation ; les refus actuels distinguent taille finale
exacte et borne inférieure du prévol, conformément à la référence MCP.

## Parcours après consolidation du transport et des schémas

Deux sessions Codex CLI 0.164.0 éphémères ont rejoué la demande Kubernetes, depuis
un dossier dédié et sans configuration MCP persistante. Le CLI texte annonce
`gpt-6.1-sol`, provider OpenAI, effort de raisonnement `none`, sandbox `read-only`.
La seconde session JSON utilise les mêmes options ; son événement de tour
n’annonce pas séparément le modèle. La taille de contexte, le plafond de sortie
et la politique de réduction des résultats ne sont pas exposés dans les traces
exploitées : aucune valeur n’est inventée.

La trace JSON confirme `search_videos({"query":"Kubernetes","sort":"newest"})`,
sans page supplémentaire, puis `get_video(video_id=2)` et deux lectures
`get_transcript(video_id=2,source_id=2,format=text)`.
Le choix de `get_video` appartient au client, sans obligation dans le contrat.
La fixture instrumentée observe l’initialisation sans en-tête, puis
`MCP-Protocol-Version: 2025-06-18` : la version réellement utilisée reste admise.

Corpus : 20 minutes synthétiques, 240 fragments, PlainText **25 883 octets**.
Chaque réponse de transcription fait **52 234 octets de corps HTTP** ; cet
instrument relève le corps entier et n’isole pas la taille de l’objet résultat.
Format demandé explicitement `text`.
Le SDK ajoute son identité serveur seulement sur la révision récente ;
ces mesures Codex portent bien sur `2025-06-18`.

| Mesure | Session texte | Session JSON |
| --- | --- | --- |
| Durée CLI complète | 26,989 s | 27,951 s |
| Durée outil transcription, résolution du journal | 2 ms par lecture | 2 ms par lecture |
| Durée handler HTTP de chaque transcription | 2,768 et 2,850 ms | 3,282 et 2,932 ms |

Les deux résumés attribuent leur contenu à la transcription automatique française,
citent le lien de provenance et reprennent les trois faits distinctifs.
Aucune substitution par une vidéo plus ancienne ni commande shell/Web n’est observée.
La présence de ces faits est une **validation par échantillonnage**, sans preuve
de transmission exhaustive de la transcription au modèle.
Les variantes et captions réelles ci-dessous sont des observations antérieures ;
elles n’ont pas toutes été rejouées après cette consolidation.

## Allocations et mémoire

Mesures ponctuelles sous WSL2 Ubuntu 24.04, Linux amd64, Go 1.27.1,
Ryzen 7 7700X, `GOMAXPROCS=16`, protocole `2026-07-28`, trois itérations.
Les fixtures sont préparées avant mesure : les allocations ci-dessous comprennent
**serveur et véritable client SDK dans le même processus**, y compris validation,
sérialisation, transport HTTP et décodage client, mais pas le chargement applicatif.
`wire-B/op` compte le **corps HTTP reçu**, pas ses en-têtes et pas une
resérialisation de l’objet décodé. Un contrôle hors mesure vérifie succès ou refus.

`normal` correspond à environ 27 Ko de texte métier ; `long`, à 525 Ko.
`escaped` contient notamment contrôles, guillemets, antislashs, HTML et Unicode.
`oversized` reprend ce motif bien au-delà du plafond ; les transcriptions comportent
240 fragments. Les métadonnées comportent une description complète volumineuse.

| Lecture / profil | Corps HTTP, octets | Allocations cumulées, Mo décimaux/appel | ms/appel |
| --- | ---: | ---: | ---: |
| text / normal | 57 964 | 2,50 | 2,72 |
| text / long | 1 050 564 | 38,82 | 28,13 |
| text / escaped | 1 170 566 | 43,57 | 41,33 |
| text / oversized | 757, refus | 0,70 | 4,68 |
| timed / normal | 73 844 | 3,60 | 3,93 |
| timed / long | 1 066 444 | 44,51 | 28,43 |
| timed / escaped | 1 231 444 | 47,47 | 43,98 |
| timed / oversized | 757, refus | 0,69 | 2,38 |
| note / normal | 57 848 | 2,09 | 2,09 |
| note / long | 1 050 448 | 35,55 | 23,64 |
| note / escaped | 1 215 448 | 41,14 | 39,50 |
| note / oversized | 757, refus | 0,70 | 2,31 |
| metadata / normal | 58 090 | 2,11 | 2,38 |
| metadata / long | 1 050 690 | 35,73 | 23,78 |
| metadata / escaped | 1 215 690 | 40,29 | 41,27 |
| metadata / oversized | 757, refus | 0,69 | 2,34 |

Quatre appels `timed/escaped` simultanés, sans lot, transmettent environ
4,93 Mo et allouent environ **193 Mo cumulés par groupe**, en 51 ms.
Un lancement séparé du binaire de test précompilé sous `/usr/bin/time -v`
observe un **pic RSS de 82 384 Kio**, soit environ 80,5 Mio, pour ce scénario
avec trois itérations. Ce RSS inclut runtime, fixtures, serveur, client, calibration
du benchmark et buffers conservés par Go ; ce n’est pas un pic isolé du serveur.
Ni ces allocations cumulées ni ce RSS ne constituent une garantie de plafond.

Sur le même corpus text oversized, le benchmark isolé de `PlainText()`
mesure **73 639 434 octets alloués/op**, 52 allocations et 27,52 ms.
Le prévol conservateur mesure **0 octet alloué/op**, 0 allocation et 3,95 ms.
Le refus HTTP complet garde ses propres coûts indiqués dans le tableau.
Les refus évidents évitent donc la normalisation et la sérialisation complètes ;
les résultats admissibles, ou proches du seuil, restent coûteux.
CPU et délais sont coopératifs, comme décrit dans la référence des contrats.

Reproduction :

```bash
go test ./internal/adapter/mcp -run '^$' -bench BenchmarkMCP -benchtime=3x -count=1
go test ./internal/adapter/mcp -run '^$' -bench BenchmarkOversizedPlainText -benchtime=3x -count=1
go test -c -o /tmp/sillage-mcp-memory.test ./internal/adapter/mcp
/usr/bin/time -v /tmp/sillage-mcp-memory.test -test.run '^$' \
  -test.bench '^BenchmarkMCPFourConcurrent$' -test.benchtime=3x -test.count=1
```

## Déploiement Docker isolé

Essai réel avec Docker Engine **29.8.2** : image construite par le Dockerfile
versionné depuis le code corrigé, frontend distribué inclus, UID/GID 1000,
répertoire de données neuf sous `/tmp`, nom de conteneur distinct.
Inspection Docker : publication **`127.0.0.1:18483:8080` exclusivement** ;
autorités configurées `127.0.0.1:18483,localhost:18483`.
Aucune instance personnelle ni volume existant n’a été utilisé.

Le client Go SDK sur l’hôte WSL a découvert les quatre outils et lu une recherche
locale vide sur **chacune des trois versions conservées**. Depuis Windows,
la découverte MCP retrouve aussi quatre outils et REST répond HTTP 200.
La recette vérifie REST, racine SPA, navigation `/videos/123`, asset JavaScript
compilé, autorité correcte, Origin absent/autorisé et refus Host/Origin étrangers.
L’arrêt SIGTERM se termine avec **code 0**, sans OOM, et les événements
`server.stopping` puis `server.stopped`. Conteneur et données jetables ont été supprimés.

Reproduction depuis un compte Linux UID 1000, avec ports et nom libres.
Ce script ne lit ni ne remplace un répertoire personnel :

```bash
mcp_data=$(mktemp -d /tmp/sillage-mcp-docker-XXXXXX)
mcp_container="sillage-mcp-check-$(date +%s)"
docker build -t sillage:mcp-check -f deployments/docker/Dockerfile .
docker run -d --name "$mcp_container" \
  -p 127.0.0.1:18483:8080 \
  -e SILLAGE_MCP_ENABLED=true \
  -e SILLAGE_MCP_ALLOWED_AUTHORITIES=127.0.0.1:18483,localhost:18483 \
  -v "$mcp_data:/app/data" sillage:mcp-check
SILLAGE_TEST_MCP_DEPLOYMENT=http://127.0.0.1:18483 \
  go test ./internal/adapter/mcp -run '^TestDeployedMCP$' -v -count=1
docker inspect --format '{{json .HostConfig.PortBindings}}' "$mcp_container"
docker stop --time 10 "$mcp_container"
docker inspect --format '{{.State.ExitCode}}' "$mcp_container"
docker logs "$mcp_container"
docker rm "$mcp_container"
# Vérifier la cible absolue avant de retirer le seul répertoire créé ci-dessus.
case "$mcp_data" in /tmp/sillage-mcp-docker-*) rm -r -- "$mcp_data";; esac
```

Si le compte hôte n’est pas UID 1000, préparer uniquement ce répertoire temporaire
pour l’UID du conteneur ; ne pas contourner les contrôles Host/Origin.
Le test Go opt-in ne démarre ni n’arrête Docker et n’effectue aucune écriture métier.
Il n’atteste pas une sécurité LAN/homelab ou une compatibilité avec un hôte de modèle local.

## Captions publiques réelles

| Source et durée réelle | Contenu stocké et réponse mesurée | Résultat réel |
| --- | --- | --- |
| [What is Kubernetes · TechWorld with Nana](https://www.youtube.com/watch?v=VnvRFRk_51k), 14 min 13 s, en | JSON3 226 296 octets ; 2 359 fragments ; PlainText 11 761 octets ; corps HTTP 23 990 octets | Requête Kubernetes avec `newest`, bonne vidéo/source, résumé attribué ; orchestration au début, Pods/Services au milieu, état déclaratif et deux répliques vers la fin |
| [Intro: Ecosistema CNCF · Cloud Native Guatemala](https://www.youtube.com/watch?v=ICnCsVEcy2o), 69 min 07 s, es | JSON3 933 995 octets ; 9 741 fragments ; PlainText 48 720 octets ; corps HTTP 759 712 octets pour chacune des deux lectures | Requête CNCF avec `newest`, bonne source ; restitution des principes cloud native au début, orchestration au milieu, questions et conseil d’expérimentation de Terraform vers la fin |

Le second prompt porte sur **CNCF**, sujet réellement présent dans les métadonnées
de la conférence longue, et demande explicitement un point distinctif du début,
du milieu et de la fin. Le passage Terraform cité par l’agent apparaît vers
4 018 279 ms dans le JSON3 préparé, soit 66 min 58 s.
Les deux sources réelles utilisent des bibliothèques jetables distinctes.
Le format des lectures de l’essai long n’a pas été consigné dans la trace CLI texte ;
la taille HTTP ne doit pas être confondue avec celle de PlainText.

| Source | Latence outil serveur | Latence HTTP | Durée CLI complète |
| --- | --- | --- | --- |
| Vidéo Kubernetes courte | 2 ms | 3 ms | 24,178 s |
| Conférence CNCF longue | 9–10 ms | 17 ms | 40,317 s |

La lecture courte et le résumé long sont réussis pour les éléments de couverture
contrôlés. Aucun problème de troncature affectant ces éléments n’a été observé.
Il ne s’agit pas d’une preuve d’exhaustivité de chaque fragment transmis au modèle,
ni d’une mesure de l’exactitude des captions ou de leur synchronisation audio.

## Préparer une caption publique réelle

Cette préparation est une acquisition explicite séparée du serveur MCP.
Elle n’utilise aucune bibliothèque personnelle. Dans un répertoire temporaire privé :

```bash
mcp_fixture_dir=$(mktemp -d)
yt-dlp --ignore-config --no-cache-dir --no-playlist --skip-download \
  --write-auto-subs --sub-langs en-orig --sub-format json3 \
  --write-info-json --output "$mcp_fixture_dir/caption.%(ext)s" \
  'https://www.youtube.com/watch?v=VnvRFRk_51k'
python3 - "$mcp_fixture_dir" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
info = json.loads((root / "caption.info.json").read_text())
fields = ("id", "title", "duration", "language", "channel",
          "channel_id", "webpage_url", "description")
metadata = {field: info.get(field) for field in fields}
# Langue de la piste acquise explicitement, indépendante de la langue audio.
metadata["caption_language"] = "en"
(root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
PY
SILLAGE_MCP_AGENT_PUBLIC_FIXTURE="$mcp_fixture_dir" \
go test ./internal/adapter/mcp -run '^TestAgentPublicFixture$' -v -count=1 -timeout=12m
```

Le répertoire attendu contient exactement un `*.json3` et `metadata.json`.
Ce dernier reprend les champs ci-dessus et `caption_language`, fournie explicitement.
Le fichier info brut sert seulement à la préparation ; aucun de ses chemins ou URLs
techniques n’est renvoyé par MCP. Ne pas conserver ni publier les logs bruts d’acquisition.

Lancer Codex avec les options éphémères de la [référence](../../docs/mcp.md),
depuis un dossier de test vide. Pour la conférence longue, utiliser son URL,
la piste `es-orig`, `caption_language="es"` et une demande portant sur CNCF.
L’acquisition et la disponibilité des captions peuvent varier : vérifier les résultats
réels et la sélection de piste avant de lancer l’agent.

Après arrêt du test, supprimer uniquement le répertoire temporaire créé pour cette recette.
Le test nettoie sa propre base et sa copie du snapshot, sans modifier les fichiers d’entrée.

## Validation restante

- Un hôte MCP identifié avec un **modèle local**, ses réglages effectifs et sa fenêtre de contexte.
- Une montée en taille plus large sur d’autres transcriptions et clients, en capturant
  systématiquement formats et plafonds client/modèle effectifs.

Rejouer la procédure et les variantes opt-in décrites dans [MCP](../../docs/mcp.md).
Consigner explicitement les réglages qui n’étaient pas observables dans ces essais.
Si une transcription représentative est tronquée côté client, documenter le seuil et
soumettre l’arbitrage ; ne pas ajouter de pagination ni réduire silencieusement le contenu.
