# Sillage — Codex instructions

## Environment

This project is developed and executed in a Linux environment, either a native Linux distribution or WSL2.

Use Linux paths, shell conventions, and tooling for this repository.
Do not use Windows paths or PowerShell commands unless explicitly required for a Windows-specific task.

## Project

Sillage is a personal knowledge base centered on video.

The application turns video content into durable, structured knowledge through metadata, Markdown notes, timestamps, annotations, transcripts, tags, screenshots, search, and AI-assisted workflows.

YouTube is the first supported source, but `Video` is the central domain object and must not be coupled to YouTube.

## Documentation

The project documentation in `docs/` is authoritative for product and architectural decisions.

Before making domain or architectural changes, read the relevant files:

* `docs/00-project-brief.md` — vision and scope
* `docs/01-product-and-ux.md` — product workflows and UX
* `docs/02-domain-model.md` — domain model and invariants
* `docs/03-architecture.md` — architecture
* `docs/04-tech-stack-and-decisions.md` — technical decisions
* `docs/05-roadmap-and-open-questions.md` — roadmap and unresolved questions

Do not turn an open question or exploratory idea into a project decision without explicit approval.

## Architecture

Keep the application core independent from interfaces and technical dependencies.

```text
Web / REST / MCP / future desktop
            ↓
    Application Services
            ↓
      ports / adapters
            ↓
SQLite / yt-dlp / ffmpeg / filesystem / AI
```

Rules:

* Keep HTTP handlers thin.
* Do not put business logic in HTTP handlers.
* Domain/application code must not depend directly on Chi, SQLite, yt-dlp, ffmpeg, or MCP.
* REST and MCP must reuse the same application services.
* Normalize external formats at adapter boundaries.
* Prefer small, purpose-specific interfaces.
* Avoid unnecessary abstraction and speculative infrastructure.

## Domain rules

* `Video` is the central domain object.
* `Video` and `VideoSource` are distinct concepts.
* A local media file does not create another `Video`.
* User-created data must remain separate from source metadata.
* Store timestamps canonically as integer milliseconds.
* YouTube JSON3 is an input format, not an internal domain format.
* Do not persist raw yt-dlp metadata by default.

## Current stack

Current choices or strong preferences:

* Go
* `net/http`
* Chi
* SQLite
* yt-dlp as an external executable
* ffmpeg for media operations
* Docker
* REST API
* MCP planned later

SQLite FTS5 is planned for later full-text search.

React, TypeScript and Vite are selected for the initial Web SPA.
The frontend consumes the existing REST API; Go serves its compiled static files
alongside the API in production. No permanent Node.js server or SSR is required.
Keep local access as the default while authentication is absent.

The Markdown note is the stable main workspace area. The player is flexible and
the transcript is an independent panel. Step 5.2 integrates CodeMirror 6,
safe GFM reading and autosave with mandatory optimistic revision checks.
LF is canonical for notes: normalize CRLF and CR to LF in the application service
before persistence, preserving every other character. This supersedes the 5.2
mixed-line-ending preservation decision. Do not migrate existing notes or change
them on GET. CodeMirror uses native line splitting and LF serialization; opening
or leaving a legacy note must not trigger a normalization write. Explicit saving
or normal editing/autosave may normalize it under the usual revision checks.
Notes use no persistent
browser drafts. Step 5.3 integrates the YouTube IFrame Player API directly and
the existing local transcript GET / explicit acquisition POST. Both panels use
the first usable YouTube source in REST order; this is not a persisted primary
source. Keep the note mounted across layout and player visibility changes.
Transcript grouping is presentation only and preserves source order and whitespace.
Step 6.1 connects transcript timestamp buttons to the same YouTube player, preserving
playback/pause. Explicit navigation now starts unstarted/cued/ended videos;
cue-only preparation without playback is reserved for switches. Navigation
is immediate only: unavailable players require another explicit click, never a queued
command. Step 6.2 inserts `[12:42](sillage://videos/5/sources/5?start_ms=762345)`:
`videos` is the logical authority, both Sillage IDs are explicit, milliseconds
are preserved, and `end_ms` is reserved. Insert after the CodeMirror selection
without replacing it, as an isolated undo transaction with normal autosave.
Read current time only in ready playing/paused/ended states, including a hidden
paused instance; reject cued, unstarted, buffering and unavailable states without
deferred work or player commands. Step 6.5 originally activated references in Reading only; UX 1.2b.2 also activates recognized editor references.
Step 6.3 searches the exact continuous transcript text locally, ignoring case,
across fragment and display-block boundaries. Highlight occurrences and scroll to
the active result with circular previous/next navigation, without player commands.
Reset search on video/source changes. Presentation grouping is fixed at 10 seconds,
without a selector or user preference. Natural segmentation is future research.
Step 6.4 extracts native transcript selections across fragments, blocks and search marks.
Copy only transcript text, collapsing whitespace in the excerpt without adding fragment
separators. A stable citation button inserts escaped Markdown using the first retained fragment's
start_ms, without end_ms. UX 1.1 supersedes the original 6.4 generated format:
insert > [!quote:tr](sillage://...) followed by the quoted escaped text, without
a stored timestamp label. Existing citations retain their separate working reference.
Nonempty notes require an explicitly chosen editor position; automatic focus is insufficient.
Insert after the selection without replacing text, in one isolated undo transaction with
normal autosave. Reading mode refuses; empty editing notes may insert at zero.
Invalidate stale excerpts, preserve them during focus transfer to the citation button,
and never command the player. Step 6.5 accepts only canonical sillage:// links with safe positive video/source IDs
and a safe nonnegative start_ms; reject extra parameters including end_ms.
Allow these only for Markdown link hrefs, retain default URL filtering elsewhere.
Render native buttons, compare with the current video/work source, and share
player.navigate with transcript timestamps. After accepted navigation only,
measure the revealed video and scroll the page instantly if necessary, preserving
focus and inner panel scroll positions. No deferred player command.
Ranges and synchronized scrolling remain future work.

Do not introduce PostgreSQL, Redis, a vector database, microservices, or another major infrastructure component without a concrete requirement.

## Development approach

Prefer small vertical slices that work end-to-end.

Current development direction:

```text
yt-dlp
→ Go model
→ SQLite
→ REST API
→ transcripts
→ notes and tags
→ minimal Web UI
→ timestamps
→ downloads and screenshots
→ search
→ MCP
→ integrated AI
```

This order is guidance, not a rigid constraint.

Prefer simple, idiomatic Go and avoid premature abstractions.

## Validation

Before considering a code change complete:

1. format modified Go code;
2. run relevant tests;
3. run the full test suite when practical;
4. verify that the affected binaries build;
5. report any validation step that could not be performed.

## UX 1.1 — Markdown citation callouts

Reading recognizes only unescaped lowercase quote and quote:tr headers on the first
content line of a blockquote without a blockquote ancestor. Lists are allowed;
nested callout headers remain literal and inert. Quote attribution is plain text;
quote:tr accepts a canonical URI followed by an optional plain-text title on the same
line, separated by spaces/tabs. Missing or whitespace-only titles display
“Transcription”; generated citations still omit the title. Invalid known headers
are inert, including links crossing into the body; unknown markers retain normal
Markdown behavior. QuoteCallout shares presentation only; reuse TimeButton and 6.5
navigation. Preserve raw notes, GFM, shared definitions, URL filtering, editor session
and autosave. No migration, new domain entity or generic callout registry.
Editor presentation follows UX 1.2a below.

## UX 1.2a — Markdown editor presentation

Use CodeMirror's Markdown syntax tree for all blockquote line decorations, including
lazy continuations, lists and nesting. Code examples outside blockquotes stay plain.
Share only parseCalloutHeader with Remark; each parser checks its own block context.
Valid callouts may have mark/line decorations; all source text and URIs remain visible.
Preserve editor identity, selections, history and autosave. No widgets, replacement
ranges or player interactions. Compact canonical temporal references everywhere
are reserved for UX 1.2b, not implemented in this increment.

## UX 1.2b.1 — Compact temporal links

Compact only single-line direct Markdown links with simple labels and strictly
canonical temporal destinations. Keep all known callout headers literal, including
invalid/nested headers and plain-text titles/attributions. Body links may compact.
Use CodeMirror replacement widgets without atomic ranges or document changes.
Click or keyboard entry reveals source; boundary deletion reveals before deleting.
Intersecting selections reveal source, including fully covered links. Preserve raw
Markdown copy, insertion, history, autosave and editor identity. Suspend replacements
during IME composition. No new tab stops or dependencies. UX 1.2b.2 below extends
this baseline with eligible quote:tr URI compaction and protected navigation.

## UX 1.2b.2 — Editor temporal navigation

UX 1.2b.1 is manually validated. Compact the URI only in eligible quote:tr headers,
preserving parentheses, marker and title; derive timestamp from start_ms.
Reuse parseCalloutHeader and the existing selection/deletion protections.
Ctrl-click (Cmd on macOS) activates compact or revealed references without changing
selection. Mod-Enter requires one empty selection strictly inside a recognized
range. Shift/Alt combinations and non-temporal content retain native editor behavior.
Reuse VideoNote.onNavigate and all 6.5 identity/player/scroll guards. No navigation
transactions, remount, autosave, tab stops or iframe focus. Report refusals in a
stable accessible status near the editor. Invalid/nested headers and literal titles
remain inert. No domain, persistence or REST changes.

## Step 7.1 — Corrective policy (implemented)

Preserve explicit conservation, provenance, source/video ownership and one file per
source. Migration 0007 opens format without losing data or AUTOINCREMENT history.
Use native yt-dlp sorting res:1080 without format-sort-force, custom MP4 preference
or codec/container allowlists. Trust native bv*+ba/b audio selection, including combined formats and possible dubs.
Do not change transcript selection. Validate finished audio+video with ffprobe.
Preserve timeline, no reencoding. Duration tolerance remains max(1s,min(3s,0.1%)).
Keep published or abandoned files regardless of missing SQL references. Startup
may safely restore referenced .deleting files but never erase abandoned files.
Live explicit deletion may remove bytes after SQL confirmation; live operations
may clean their own temporary directory. Isolate media anomalies from knowledge.
Expose downloading until finalization releases activity; available must allow deletion.
One server per data directory, application-owned jobs, 6h default timeout, no queue.
Screenshots and local playback are implemented in later increments below; imports and interactive storage maintenance remain future.

## Step 7.1 — Acquisition metadata (implemented)

Use one yt-dlp invocation with native identity/finished filters before acquisition
and minimal structured output. Keep existing temporal and auxiliary-stream checks;
unknown remote duration is allowed, known references remain checked.
Migration 0008 adds nullable video_codec, audio_codec, width, height, fps,
audio_language. ffprobe measures technical properties; yt-dlp alone supplies
selected audio language (never the aggregate language, probe tags or source original).
No startup backfill. Share download state with the distinct local-file metadata
section; no extra polling, player commands or editor remounts.

## Structured logging

Use log/slog directly through the contextual logger in internal/logging.
Never log arbitrary error text, bodies, query strings, headers, external tool
arguments or raw output, even at DEBUG. Keep safe tool diagnostics at adapter
boundaries. HTTP handlers enrich one request summary; asynchronous services own
their terminal event. Keep the server cancellation context and copy only safe
correlation attributes when accepting work. No logger interface, persistent log
table or job framework. Successful reads, polling and note autosaves are DEBUG.

## Local playback — local-first enabled

Use one logical player area with YouTube / Local. Initial selection waits for
media availability without mounting YouTube first: choose Local when available,
otherwise YouTube, including on availability lookup failure. Do not persist a
preference or add a flag. Notes and transcript remain accessible while waiting.
Download completion never changes the selected mode.

Local uses native video controls and the exact media content REST identity.
Keep the current work source for playback, transcripts, time links and captures.
Switches stop the previous instance and may apply one initial position when ready,
without autoplay; ordinary timestamp navigation remains immediate only.
Pause on hide, keep notes/transcript mounted, and preserve the server capture fallback.
Playback errors remain Local without conversion, deletion or automatic fallback.
Confirmed deletion unloads the local element first and leaves Local empty on success.
Reservations protect HTTP requests, not entire viewing sessions.

## Player panel — phase 1, visual approval required before phase 2

Keep the panel and segmented native buttons mounted across surface switches.
Without available media, Local opens one shared conservation dialog without changing
mode or commanding YouTube. The Local-empty state after deletion uses that same dialog.
Keep one useVideoDownload consultation. Activity survives refresh through server state;
success/failure indicators last five seconds and never persist across openings.
Unknown availability, deletion and decoder errors are not download failures.
Contextual information and confirmed deletion preserve all sources in the existing
metadata section. Confirmed deletion from YouTube must not stop the remote player.
Retain video padding, aspect ratios and height limits. Stop before edge-to-edge work;
phase 2 requires explicit user approval of phase 1. Clips are exploratory only,
with no chosen entity, schema, endpoint, cutting or export implementation.

## Session position transfer

Keep getCurrentTimeMs strict for time insertion and capture. Surface-only transfer
snapshots distinguish confirmed, prepared, empty and uncertain. Preserve a still-valid
cued target across switches, including accepted cue navigation, but never fall back
to an old target after activity/error makes it uncertain. Ordinary navigation stays
immediate-only. No progress polling, persistence or layout changes. Brave validation
is required before proceeding to panel phase 2.

## YouTube annotation time — no durable seek confirmation

Use the current time reported by YouTube in an admissible state, never the requested
seek target or a prepared departure. Do not restore pendingSeek, target tolerances,
confirmation timers or temporal polling. An immediately stale getter is an accepted
API limitation. Keep prepared departures separate and non-annotatable, and retain
readiness/state/value/error/visibility guards. Local keeps its seeking/data guards.
Explicit YouTube navigation now uses seekTo from every known state: paused stays
paused; unstarted/cued/ended start playback. Keep cueVideoById only for switch
initialization without playback. Local behavior remains unchanged.
Prioritize annotations, then playback/navigation, then switching comfort.

## Explicit YouTube navigation

Delegate autoplay to the iframe but keep autoplay: 0 on opening and cue-only
switch initialization. Handle onAutoplayBlocked only when emitted, non-fatally,
and clear its message on playing. The API does not explicitly guarantee that
event after seekTo. No synthetic detection, retry, timer or polling. Preserve
visibility/disposal guards and annotation time semantics. Await manual Brave
validation; panel phase 2 remains deferred.

## Player panel phase 2 — authorized, manual visual validation pending

Phase 1 and explicit YouTube navigation were manually validated in Brave.
Phase 2 now extends only the video surfaces to the side and bottom inner edges.
Keep header/messages padded, panel overflow visible for popovers, and rounded
lower media corners. Existing ratios, height limits and responsive breakpoints
remain unchanged. No player behavior, workspace structure or persistence changes.
The previous phase-1 padding freeze is superseded only for this presentation work.

## Video workspace — tranche A

The title belongs in the main header, rendered from the existing VideoDetail data;
retain first REST source semantics, one line desktop and up to two lines mobile.
No title_override implementation. Only video pages omit the footer.
Keep three grid children and mobile order player, note, transcript. Tags belong in the header, above the workspace; local Note/Informations tabs
remain at the top of the note panel. Keep VideoNote, NoteSession and CodeMirror mounted,
with mode, selection, history and independent panel scroll preserved. Autosave
continues while hidden; errors/conflicts and the leave dialog stay accessible.
An accepted citation reveals Note before insertion/focus; refusals never switch tabs.
Capture completion must not reveal the note or steal focus. Move all existing
metadata into Informations, retaining the contextual player popover and one shared
download consultation. No generic tabs, domain/API changes or title editing.
Player dimensions remain unchanged; 16:9 is tranche B after manual Brave validation.

Desktop height uses the actual header row plus remaining viewport space, with
8px top and 16px bottom main padding and a 38rem workspace minimum allowing page overflow.
Keep current grid widths and the 1100px breakpoint; mobile retains normal flow.
Tranche A requires manual Brave validation before starting tranche B.

## Video workspace — Note presentation refinements

Video pages use a transparent header, compact home logo with visible Sillage wordmark and no
vertical title separator. Keep local line tabs and their keyboard behavior.
Note controls stay outside the shared edit/read scroll surface on desktop; mobile
uses page scrolling and sticky controls. Keep the 700px useful text width and
CodeMirror identity. Do not restore nested editor frames or vertical scrollbars.

NoteSession.confirmationCount is presentation-only and increments exclusively on
actual PUT/reconciliation confirmations, never initial reads or server adoption.
Save feedback waits until running is released and all current edits are confirmed.
Partial confirmations and no-op saves never create success; success lasts five
seconds and is invalidated by edits/new saves. Errors/conflicts remain persistent
and accessible, including under Informations. Keep save rules/timing unchanged.
Brave validation remains pending; no player sizing changes before tranche B.

## Header tags and global navigation

Keep one stable VideoDetail portal for the first-REST-source title and loaded tags.
No mirrored video state or extra header requests. Neutral tag pills preserve REST
order; measure the longest fitting prefix plus the exact +n counter, without a
fixed tag limit or skipping long names. Keep measurement copies inert, hidden and
contained. Hidden tags use a native consultation-only popover; the existing
management dialog retains mutations and its existing refreshes. Restore visible
focus when resizing hides a focused link. Below 1100px tags use their own header
row; the title remains capped at two lines on small mobile screens.

SiteNavigation is global and independent of video data. Use a closed-by-default
native modal overlay, without resizing the workspace or commanding players.
Keep keyboard focus contained, Escape/outside dismissal, and stable scrollbar
space. Close before router navigation can open the note leave guard. Keep the
single theme selector in the navigation; no fake account/settings features or
persisted drawer state. CodeMirror and player identities remain unchanged.
Manual Brave validation is pending; no 16:9 work is authorized by this increment.

## Compact header and conditional centering

Desktop video headers use a 56px minimum, 8px vertical padding and no title
separator. Keep the workspace minimum at 38rem; main reserves 24px total vertical
padding and continues to overflow naturally on short windows. Player sizes do
not change. Keep mobile layout below 1100px and the two-line small-mobile title.

Prioritize the full title without 70ch/62% caps; reserve tag management and +n
before truncating it. Compute the maximal tag prefix using all space after the
navigation, independently of placement. Center the actual title/tag group only
when it fits without collisions or reducing visible content; otherwise align
left. Never feed the centered width back into the tag budget. Keep the portal,
CodeMirror, players, focus protections and existing API reads unchanged.

## Video workspace — tranche B authorized and implemented, Brave validation pending

This supersedes earlier freezes on player dimensions and the lower-corners-only
presentation. YouTube and Local share full-width 16:9 surfaces without viewport
height clamps, retaining a common 200px minimum on small mobile. Use contain for
local video, black bars for nonmatching formats, and four rounded media corners.
Keep the player panel overflow visible and anchor its information popover below
the actual toolbar. Nonblocking informational messages follow the surface; errors
with actions remain near the player. No global notifications or preparatory bus.

Keep the three React/grid children, desktop column ratio 1.2/1 and mobile order.
Join the right-panel borders only on desktop with a transcript, without a row gap
or horizontal divider. Keep full standalone borders when no transcript exists.
Desktop controls remain about 40px, with flexible 56–58px bars. Transcript text
keeps a 12rem minimum excluding controls/search/messages; only text scrolls.
Allow page overflow when these minima exceed the viewport. Size containment on
desktop scrolling documents excludes their text length from intrinsic sizing,
without changing sessions or minimum writing space. Hiding releases media space.
Do not add a resizable separator or persist dimensions in this slice.
