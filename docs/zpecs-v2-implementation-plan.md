# Zpecs v2 implementation plan

## Objective

Zpecs v2 removes the structural dead ends and high-token write patterns found during real project use. The release is a coordinated cutover: implementation can proceed incrementally, but current documents are migrated once and only v2 is read or written afterwards.

The current v1 revision snapshots remain byte-identical as raw history. The current planning state is preserved as a new v2 baseline revision; there is no dual-read or dual-write compatibility layer.

## Implementation status — 2026-08-10

- Phases 1–8 are implemented across domain schemas, persistence, change sets, MCP reads, work discovery, generated contracts, migration tooling, and the web UI.
- Phase 7 completed its production cutover on 2026-08-10. The hash-bound atomic writer migrated 95 E/S/T baselines, created 99 Rules, retained all 133 legacy revisions and 32 links unchanged, and emitted a complete apply manifest.
- Static release verification is green: `vp check` (218 files), Sherif, all TypeScript projects, 22 generated-schema drift checks, API build, and web production build.
- The serialized MCP `tools/list` payload is 11,989 bytes against the 12,288-byte limit (299 bytes reserve).
- No automated tests were added or run, in accordance with repository policy.
- A verified production export preceded the schema/data cutover. Independent post-commit reads and the deployed v2 application's health checks are green.

## Decisions

### Identity

- Entity keys are server-generated and project-scoped:
  - Epic: `E-1`
  - Stream: `S-1`
  - Task: `T-1`
  - Milestone: `M-1`
  - Rule: `R-1`
- Project remains a name-addressed technical container without a public key.
- Local section identity is `(owner, semantic namespace, local id)`, never project-global.
- Local ids have no zero padding and use the agreed prefixes: `SCP`, `OUT`, `MET`, `FR`, `NFR`, `AC`, `WF`, `STEP`, `EC`, `RA`, `ASM`, `OQ`, `SRC`, `EXIT`, `VER`, `BC`, `CHG`, `HYP`, `RQ`, `SC`, `DR`, `IQ`, `REF`, `INV`, `QG`, `MG`, and `RSK`.
- Domain actors remain local labels. Assignees/authors remain external actor references.

### Entity boundaries

- Versioned documents: Epic, Stream, Task, Rule, Milestone.
- Ownership hierarchy: Epic -> Stream -> Task.
- Hard dependency endpoints: Stream -> Stream and Task -> Task only.
- Rule and Milestone are not hierarchy nodes or `blocked_by` endpoints.
- Scope, requirements, acceptance criteria, workflows, steps, edge cases, outcomes, metrics, type-specific stream targets, task verification, assumptions, open questions, and sources remain embedded and locally addressable.

### Traceability

- Every ready-or-later Task references at least one allowed target in its parent Stream.
- References are field-typed id arrays, not mixed `{kind,id}` unions.
- Business Rules constrain work but do not satisfy Task readiness on their own.
- Acceptance Criteria use typed Requirement and Rule references.
- A Task records the parent Stream revision it starts against and pins the actually used Stream and Rule revisions when it becomes terminal.

### Rules

- Rule is a project-scoped, independently revisioned entity.
- Epic and Stream documents carry local `RA-*` applications containing `applies_when` and application notes, never local Rule text overrides.
- Semantic variants become new Rules linked with `derived_from`, `exception_to`, or `supersedes` as appropriate.
- Active work resolves current Rule revisions. Terminal work preserves pinned revisions.
- Referenced Rules cannot be hard-deleted. Deprecation/supersession is explicit and never silently rewrites consumers.

### Milestones

- Milestone is a versioned project entity parallel to the Epic hierarchy.
- A Stream belongs to zero or one Milestone. Tasks inherit that placement.
- Milestone order and Stream rank are advisory; equal ranks mean parallel work.
- `blocked_by` remains the only hard prerequisite.
- Milestones have `draft | planned | active | completed | cancelled`, a goal, and local `EXIT-*` criteria.
- Completion is explicit and requires all criteria `met` or justified `waived` and no open assigned Streams.
- v2 intentionally has no dates, sprints, deadlines, or capacity planning.

### Provenance

- Evidence attaches to addressable claims, not fragile document paths.
- `basis` is `stated | verified | inferred | assumed`; there is no subjective low/medium/high confidence field.
- `stated`, `verified`, and `inferred` cite document-local immutable `SRC-*` entries.
- `inferred_fields` and duplicate provenance-level assumptions/open questions are removed.
- Freshness is derived as `fresh | stale | unknown` from explicit local Source supersession; it is not stored as a mutable boolean.
- Known stale sole support blocks active readiness. Unknown freshness is visible but is not guessed to be stale.

### Work discovery

- `list_context` provides compact, pageable rows and a human tree/roadmap rendering.
- `get_next_work` supports Project, Milestone, Epic, and Stream scopes.
- Results distinguish executable Tasks from Stream planning/decomposition work.
- Availability checks Epic, Stream, Task, hard blockers, roadmap ordering, and optional executor kind.
- Roadmap order sorts work but never hides technically available later work unless a Milestone is explicitly selected.

## Implementation phases

### 0. Deployment and baseline audit

- Verify that the deployed version contains the existing `QueryResult.rows` unwrapping fix and the detailed revision-conflict response.
- Export current rows, revisions, links, counters, and hashes before migration work.
- Record current query counts, generated schema sizes, and serialized MCP tool-list size.

### 1. v2 identity and entity foundation

- Split the overloaded entity type into explicit versioned, hierarchical, dependency, searchable, and move-capable type sets.
- Add E/S/T/M/R key prefixes, Rule/Milestone project counters, parser support, and project-scoped uniqueness.
- Add Rule and Milestone persistence/revision repositories without making them dependency endpoints.
- Add typed local-id schemas, namespace uniqueness validation, typed references, and reverse-reference primitives.
- Freeze v2 schema versions and the deterministic v1 -> v2 transformation manifest.

### 2. Change-set safety and efficiency

- Add a shared preflight used by both validate and apply that collects all independently determinable issues.
- Preserve ordered stateful simulation for temp ids, OCC, dependent writes, and cycle checks; report poisoned dependents as `not_evaluated`.
- Extend one owner-level `update` with a bundled `items` array of complete-element `add | replace | remove` actions.
- Keep section replacement; apply the same removal, reverse-reference, and destructive-confirmation rules to it.
- Add semantic before/after diffs for every operation, including cascades, schedules, pins, and downstream Rule impact.
- Add an OCC-protected `schedule` operation for Milestone assignment and ordering.

### 3. Complete Stream and Task model

- Implement dedicated content schemas for all seven Stream types.
- Introduce the agreed local targets and typed Task reference arrays.
- Fix Task readiness for all Stream types and validate every referenced id against the parent Stream.
- Type `acceptance_criteria.verifies` into Requirement and Rule references.
- Keep `task_type` as work form; do not add `refactor`.
- Add optional Stream `size: small | medium | large`.
- Add Task `executor_kind: human | agent | either`, with absence meaning unknown.
- Record/rebase/pin the parent Stream revision used by a Task.

### 4. Rule and claim-evidence model

- Implement Rule schema, persistence, lifecycle, relations, context lookup, and revision pinning.
- Replace inline Rule definitions with local Rule applications.
- Add compact claim/evidence and local Source schemas to agreed business assertions.
- Remove old coarse provenance fields and duplicate unknowns.
- Keep existing `SRC-*` observations append-only; corrections add a new Source that explicitly supersedes the old one.
- Add Source reverse-reference checks and derived freshness reporting.
- Batch-resolve inherited Rules in context; never issue one query per Rule.
- Require an explicit impact confirmation for Rule changes affecting ready/in-progress consumers.

### 5. Milestones and scheduling

- Implement Milestone schema, persistence, revision history, exit criteria, and completion gates.
- Add optional Stream placement and advisory rank with non-unique equal ranks.
- Implement atomic schedule/unschedule/reorder behavior and cross-project/terminal guards.
- Keep unassigned Streams in a visible Backlog.

### 6. Discovery, context, and next work

- Add `list_context` backed by compact repository projections rather than document JSON.
- Support project/entity/status/parent/milestone filters and cursor pagination.
- Include Rules and Milestones while preserving the real Epic -> Stream -> Task hierarchy.
- Project only referenced local claims, inherited Rules/evidence, dependencies, and compact Milestone context from `get_context`.
- Rework `get_next_work` to check the complete parent/status/dependency chain and return typed `task_execution` and `stream_planning` items.
- Add Project/Milestone/Epic/Stream scopes, roadmap sorting, reason counts, and executor filtering.

### 7. Migration and cutover

- Run a write-free preflight that produces entity-key, local-id, Rule, reference, blocker, and historical-pin mappings plus conflicts.
- Preserve existing E/S/T numeric components and every internal UUID/parent/link endpoint.
- Canonicalize each exact `(legacy id, complete body)` group. Identical occurrences share a Rule; divergent bodies remain separate Rules with deterministic identities. Never fuzzy-merge.
- Rewrite structured references only. Report possible prose references without blind replacement.
- Append one system-authored v2 baseline revision to each current E/S/T entity.
- Leave every old v1 revision snapshot byte-identical and expose it as raw history with its original schema version.
- Backfill terminal pins from revision timestamps when provable; otherwise store
  `execution.trace_state: "pre_v2_not_recorded"` without Stream or Rule pins.
- Start existing Streams in Backlog unless an explicit Milestone mapping exists.
- Validate counters, indexes, reverse references, entity/link/revision counts, and all current v2 documents before atomic cutover.
- After cutover, reject v1 writes and old public key prefixes.

Current state: production cutover is complete. The command remains intentionally bound to the reviewed baseline and is expected to reject a retry against the migrated database; see `docs/zpecs-v2-migration.md` for the manifest and safety semantics.

### 8. Static verification and release

- Run `vp check`, `vp run sherif`, `vp run typecheck`, `vp run -F @zpecs/api schema:check`, `vp run build`, and focused offline migration/query/tool-size benchmarks.
- Do not add or run an automated test suite unless separately requested.
- Keep serialized MCP tool schemas within the existing budget and avoid union expansion/N+1 reads.
- Update generated schemas, MCP descriptions/resources, documentation, errors, UI labels, and key examples together.
- Verify after deployment that search/list/context/revision-conflict behavior matches the deployed version.

## Release acceptance criteria

- Two independent invalid operations report both actionable errors in one validation call.
- Several item edits to one owner use one expected revision and produce one revision bump.
- Section replacement reports every removed id and blocks referenced removals.
- A ready Task under every Stream type can name and resolve a valid type-specific target.
- No Task below a non-workable Epic or Stream appears as available work.
- A ready Stream without executable Tasks appears as planning work, not `No available work`.
- One Rule definition is projected to every consumer without inline duplication or N+1 reads.
- Active Rule consumers follow current revisions; terminal consumers resolve pinned revisions.
- Milestone/Stream ranks sort work but never create or imply dependencies.
- `list_context` can discover a project tree and roadmap without full-text search or full document reads.
- Every current document parses only as v2 after cutover; every old revision remains raw and unchanged.
- Migration writes nothing while any Rule, reference, blocker, key, or pin conflict remains unresolved.
