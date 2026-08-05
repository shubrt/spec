# Self-service project creation — rollout runbook

Stand: 2026-08-05, Europe/Berlin

This runbook covers the database invariant and the deliberately narrow
session-authenticated `POST /workspace/projects` write. A Project is an empty,
unversioned container. Epic, Stream and Task writes remain MCP-only, through the
validated and atomic change-set path. The admin `project:bootstrap` command
remains an idempotent operations tool.

## Before the schema push

Pause every invocation of `project:bootstrap` before starting the preflight and
keep it paused through the schema, API and web deployments. Before the new API
is deployed, that command is the only Project writer, so this closes the race
between the scan and creation of the new unique index.

Run both queries against the target database from a restricted operator
terminal. Their result contains project names and must not be piped into CI,
request logs, shared tickets or chat:

```sql
-- Names that the new CHECK constraint would reject.
SELECT id, workspace_id, name, char_length(name) AS name_length
FROM project
WHERE name <> btrim(
        name,
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      )
   OR char_length(name) NOT BETWEEN 1 AND 120
ORDER BY workspace_id, id;

-- Rows that would collide in the new case-insensitive unique index.
SELECT
  workspace_id,
  lower(name) AS normalized_name,
  count(*) AS project_count,
  array_agg(id ORDER BY id) AS project_ids,
  array_agg(name ORDER BY id) AS project_names
FROM project
GROUP BY workspace_id, lower(name)
HAVING count(*) > 1
ORDER BY workspace_id, normalized_name;
```

If either query returns a row, stop the rollout. Obtain the relevant owners'
approval for explicit replacement names, then apply only those approved renames
as a reviewed data correction. Never merge or delete Projects automatically.
Re-run both queries and continue only when both return zero rows. Projects with
the same normalized name in different workspaces are valid and must remain
separate.

## Deployment order

Deploy in this order:

1. Push the database schema, adding the trimmed/non-empty/120-character check and
   the unique `(workspace_id, lower(name))` index. Keep the existing exact-name
   unique index.
2. Deploy the API with the case-insensitive conflict handling and the
   session-protected `POST /workspace/projects` contract. Verify its health
   before proceeding.
3. Deploy the web application with the header and empty-state creation flows,
   then complete the API and web release checks below.
4. Only after the new web and API are healthy, resume `project:bootstrap`. Its
   new implementation shares the same validation and uniqueness boundary and
   remains safe to retry or run concurrently.

Do not deploy the API or web ahead of the schema. Do not resume the old
bootstrap implementation after the new index exists: its explicit exact-index
conflict target cannot make a case-insensitive collision idempotent.

## Release verification

Before exposing the UI broadly, verify at least these cases through the deployed
boundary:

- `201` creates one trimmed Project and returns only its `id` and `name`;
- `409 project_name_taken` covers exact and case-only duplicates;
- `422` covers blank, overlong and structurally invalid bodies, including an
  extra `workspaceId` field;
- `401` covers a missing or expired session;
- `403` covers a signed-in session without an active organization;
- two concurrent same-name creates produce at most one row;
- the same name remains valid in two different organizations;
- the created Project opens at `/?project=<uuid>`, preserves only `workspace`,
  clears Epic/Stream/Task drawer parameters, and survives reload and browser
  Back/Forward navigation;
- switching organizations reloads the project list from the new session scope
  and never treats the `workspace` query parameter as tenant authority.

Also exercise creation from an empty workspace and from an existing Project,
the inline duplicate error, Enter/Escape behavior, focus, pending double-submit
protection and the responsive header.

## Monitoring and log safety

Monitor counts and rates for `POST /workspace/projects` grouped only by HTTP
status. Interpret `201` as success, `409` as an expected name conflict, `422` as
client validation, `401` as session expiry or absence, and `403` as no active
organization. Alert on any `5xx`; investigate sustained changes in the other
rates without turning user input into metric labels.

Keep observability coarse: request ID, method, normalized route, status,
duration, auth principal and the existing actor/workspace correlation fields
are sufficient. Never emit the Project name, request or response body,
validation input, raw query string, cookie or session token. The runtime's body
redaction is defense in depth, not permission to add names to custom events.
Use a sentinel Project name in the runtime logging regression test and assert
that neither it nor the serialized body appears in the captured event.

During the observation window, compare `201` responses with the growth in
Project row count and watch `5xx` closely. A rollback of API or web does not
remove the database invariants; keep bootstrap paused unless the running
version uses conflict handling compatible with both unique indexes.
