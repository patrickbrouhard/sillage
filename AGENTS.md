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

The frontend technology is not decided yet.

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

