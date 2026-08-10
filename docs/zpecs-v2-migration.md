# Zpecs v2 migration command

The migration command implements both a deterministic read-only preflight and the reviewed,
one-off v1-to-v2 baseline writer.

Run a preflight from the repository root and capture its canonical JSON report explicitly:

```sh
corepack pnpm --filter @zpecs/api migrate:v2 -- --preflight > zpecs-v2-preflight.json
```

`--preflight` is the default. It reads one mutually consistent PostgreSQL snapshot using
`REPEATABLE READ, READ ONLY`. Exit code `0` means no hard conflicts, `2` means the report contains
conflicts, and `1` means argument parsing or the database read failed. Diagnostics go to stderr so
redirected stdout remains valid JSON.

The preflight reports, per Project:

- deterministic `EPIC-*`/`STR-*`/`TASK-*` to `E-*`/`S-*`/`T-*` mappings that retain the numeric
  component;
- every local v1 id mapped into its final v2 semantic namespace;
- inline Rule occurrences, exact `(legacy id, complete body)` groups, and divergent variants;
- structured-reference rewrites and possible prose mentions (prose is reported, never blindly
  rewritten);
- stored and observed counters plus required post-cutover values;
- canonical JSONB SHA-256 manifests for current rows, immutable revision history, and links;
- parent, link, revision-continuity, current-snapshot, legacy-source, and readiness findings.

## Apply safety gate

Apply always requires the explicit confirmation flag:

```sh
corepack pnpm --filter @zpecs/api migrate:v2 -- --apply --confirm-apply \
  > zpecs-v2-apply-manifest.json
```

The writer is deliberately bound to the production baseline reviewed on 2026-08-10. It is not a
generic repeatable data migration. Inside one `SERIALIZABLE, READ WRITE` transaction it:

1. requires all v2 schema capabilities and locks every affected table against concurrent writers;
2. compares the current E/S/T rows, all legacy revisions, and all links with the reviewed counts and
   hashes;
3. builds and store-schema-validates the complete transformation before writing;
4. inserts canonical Rules and one v2 baseline revision per current E/S/T document;
5. updates entity keys and project counters without changing UUIDs, parents, types, or links;
6. parses every resulting current document and verifies every old row, new revision, Rule
   round-trip, counter, and relational invariant before commit.

Any mismatch throws and rolls the entire transaction back. A successful apply writes a canonical
manifest containing all 99 Rule mappings, all eight reviewed Stream resolutions, post-write hashes,
and verification counts. Running it against an already migrated or otherwise changed database is
expected to fail its source gate.

## Production cutover — 2026-08-10

The production cutover completed successfully:

- a verified custom-format PostgreSQL backup was created first; SHA-256
  `1ab98ca3c00d3bf63434453f2285e95b19b9b0827bcff4afb70045c72507c79d`;
- 95 current E/S/T documents received one new v2 baseline revision;
- 99 Rules were created from 103 exact legacy applications; divergent bodies were kept separate and
  no fuzzy merge was performed;
- all 133 pre-v2 revision rows and all 32 relation rows remained unchanged;
- 36 imported `done` Tasks were marked `execution.trace_state: "pre_v2_not_recorded"`; no historical
  Stream or Rule pins were invented;
- seven completed Streams received explicit, `assumed`, hash-bound target enrichments; S-46 moved
  from `ready` to `planned` because its v1 document did not contain a separate Change target;
- the final state contains 194 current v2 documents and 327 revision rows, with 49 Streams still
  intentionally unassigned to Milestones.

The in-transaction manifest and an independent post-commit read both verified all current documents,
Rule references, typed Task references, legacy hashes, counters, triggers, indexes, constraints, and
the acyclic blocker graph. The v2 application was deployed only after the writer/API path had been
stopped, and production health checks passed after restart.

Canonical hashes refer to recursively key-sorted parsed JSONB values with array order preserved, not
to PostgreSQL's physical JSONB representation. Existing revision rows must never be updated or
deleted.
