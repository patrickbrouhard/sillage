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
playback/pause and preparing unstarted or ended videos without autoplay. Navigation
is immediate only: unavailable players require another explicit click, never a queued
command. Step 6.2 inserts `[12:42](sillage://videos/5/sources/5?start_ms=762345)`:
`videos` is the logical authority, both Sillage IDs are explicit, milliseconds
are preserved, and `end_ms` is reserved. Insert after the CodeMirror selection
without replacing it, as an isolated undo transaction with normal autosave.
Read current time only in ready playing/paused/ended states, including a hidden
paused instance; reject cued, unstarted, buffering and unavailable states without
deferred work or player commands. Step 6.5 activates strictly validated references in Reading mode only.
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
