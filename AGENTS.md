# Sillage — Codex repository instructions

## Purpose and environment

Sillage is a self-hosted video knowledge base. It combines video sources, local media, Markdown notes, transcripts, timestamps, screenshots and tags; global search is available; MCP and AI are planned extensions.

- Work with Linux paths, shells and tooling (native Linux or WSL2). Use Windows-specific commands only when the task requires them.
- Follow the toolchain versions declared in `go.mod` and `web/package.json`.
- Prefer small, coherent changes. Avoid unrelated refactors, dependencies or infrastructure.
- Do not treat a proposed feature as approved or implemented merely because it appears in a planning document.

## Where to find information

Read only the documents relevant to the task; do not load the entire documentation by default.

| File | Purpose |
| --- | --- |
| `README.md` | Setup, execution, HTTP API and test commands |
| `docs/00-project-brief.md` | Vision, scope and product principles |
| `docs/01-product-and-ux.md` | Current user-visible behavior and UX contracts |
| `docs/02-domain-model.md` | Domain entities, identities and invariants |
| `docs/03-architecture.md` | Services, adapters, persistence and API boundaries |
| `docs/search.md` | Primary reference for global-search changes: projection lifecycle, queries, contracts, excerpts and validation |
| `docs/04-tech-stack-and-decisions.md` | Current technical choices and their rationale |
| `docs/05-roadmap.md` | Completed milestones, planned work and priorities |
| `docs/06-open-questions.md` | Unresolved decisions and exploratory possibilities |
| `docs/07-local-playback-validation.md` | Reusable manual regression scenarios |
| `docs/history/` | Selected historical decisions, not current specifications |

The code and tests establish what is implemented; the current documentation describes the intended contracts. When they disagree, identify the discrepancy rather than silently treating an old statement as authoritative. Follow the user's decision on any consequential change of behavior.

## Architecture and domain invariants

- Keep the application core independent of HTTP, React, Chi, SQLite, `yt-dlp`, `ffmpeg`, MCP and AI providers. HTTP handlers translate requests and responses; application services own use cases; adapters handle external formats and systems.
- Reuse application services across interfaces. Prefer narrow, purpose-specific ports to speculative generic abstractions.
- `Video` is the knowledge object; `VideoSource` is provenance; `MediaFile` is a physical local representation. Downloading does not create another `Video` or `VideoSource`.
- Keep user-authored data and explicit associations separate from source metadata. Re-importing or refreshing a source must not silently overwrite notes, tags or user-managed relationships.
- A `Transcript` belongs to a `VideoSource`. JSON3 is source input and may be saved as a snapshot, but its fragments are not individual SQLite entities. Reading a stored transcript must not silently initiate a remote acquisition.
- Each video has at most one principal Markdown `Note`. Preserve the raw Markdown except for canonical LF line endings on save; require revision-based, atomic conflict protection. Do not normalize or write notes simply by reading them.
- Media positions and durations are integer milliseconds; calendar dates are separate UTC timestamps. Temporal references preserve the video and source identities. Never assume timelines from different sources are synchronized.
- Preserve retained files when SQL and filesystem state diverge. Do not automatically delete orphaned media, assets, snapshots or intentionally conserved data. Deletion and recovery need explicit, safe policies.
- Preserve the note editor session, selection, undo/redo, conflict state and autosave during player, tab and layout changes; UI-only actions must not cause unintended writes.
- For timestamp insertion and captures, read an admissible current player position, not a requested seek target or a merely prepared start. Do not reintroduce a persistent `pendingSeek` confirmation protocol. Navigation commands must not be silently queued for an unavailable player.
- Long-running media and capture work belongs to application-owned operations, not the lifetime of the initiating HTTP request. Preserve operation identity, idempotency and shutdown/recovery guarantees.
- Do not log secrets, signed URLs, request bodies, arbitrary paths or raw external-tool output. Use structured, sanitized diagnostics and safe request/operation correlation.

Refer to the relevant domain, architecture, technical and UX documents for exact contracts. Do not duplicate their implementation details here.

## Documentation maintenance

Keep each document focused on its purpose:

- Update current specifications when behavior or an approved decision changes. Consolidate or replace obsolete statements rather than appending another chronological addendum.
- Keep `05-roadmap.md` about progress and future milestones, and `06-open-questions.md` about genuinely unresolved topics. Move resolved decisions to the appropriate current specification.
- Do not append implementation reports, test counts, branch statuses, CI results or routine task summaries to specification files, the roadmap or open questions.
- Git commits and pull requests provide the ordinary change history. Add to `docs/history/` only for significant milestones or superseded approaches whose rationale would be useful later; do not create a development journal by default.
- When renaming or moving a document, update the links that refer to it. Avoid unnecessary documentation edits for unrelated code changes.

## Implementation and validation

- Prefer small end-to-end slices; keep the code idiomatic and focused. Respect the boundaries of the requested work.
- For Go changes, format modified code and run targeted tests. `make test` runs Go tests, `go vet`, a Go build and the frontend TypeScript check.
- For frontend behavior changes, run relevant Playwright tests; `make test-web` performs the application build and the browser suite. Use `make build` to verify the distributable frontend and Go server when relevant.
- Extend validation when changing concurrency, storage, REST contracts, migrations or cross-component flows. Use deterministic tests where possible; real YouTube/browser checks are complementary and must be reported separately.
- For documentation-only changes, check links, terminology and `git diff --check`; application tests are not necessary unless the change also affects code or configuration.
- Report what changed, which checks actually ran, their outcomes and any checks not performed. Never present simulated-player tests as proof of real YouTube behavior.

## Scope and handoff

Follow the user's requested scope, approvals and Git workflow. Do not merge into `master`, silently broaden a feature or implement open questions without explicit authorization. Prefer pointing to the current documentation over copying its rules into this file.
