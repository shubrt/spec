import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { entityRevisionRepository, type EntityRevisionRow } from "../repository/entityRevision";

/**
 * The revision log, projected into what a reader can act on.
 *
 * ## Why this is a projection and not the rows
 *
 * `entity_revision` stores a **full document snapshot** per revision. Handing
 * those to a browser means shipping the whole history of the project — for the
 * live workspace, several hundred complete documents — so that the client can
 * compute a diff the server already has both sides of. This computes it here and
 * puts the derived answer on the wire instead.
 *
 * ## What a revision is, and what it is not
 *
 * A revision is immutable and numbered. It is not an activity post: there is
 * nothing to approve, comment on or restore, and nothing tracks what anyone has
 * already seen. Every field below is either stored on the row or computed from
 * two adjacent snapshots — none of it is inferred from elapsed time.
 *
 * ## One reason often spans several entities, and they stay separate
 *
 * A single recorded reason routinely writes revisions on several entities at
 * once. They are deliberately **not** collapsed into a change set: the database
 * stores no batch, and inventing one would draw a unit of review that cannot be
 * opened, approved or reverted. A consumer that wants the siblings groups by
 * `reason` itself, and what it gets is a list of entities rather than an object.
 */

/**
 * How many entries one section of the document held, before and after.
 *
 * Section-level counts rather than a field-level diff: the counts answer "what
 * grew and what shrank" in one line per section, which is the question a reader
 * of a 40-section document actually has. The full snapshots remain in the table
 * for anything that needs more.
 */
export type SectionDelta = {
  /** Dotted path inside `content`, such as `scope.included`. */
  readonly section: string;
  readonly from: number;
  readonly to: number;
};

/**
 * What kind of change this revision was, in priority order.
 *
 * - `created` — the first revision. It has no predecessor to differ from.
 * - `status` — the stored status moved. Reported even if sections moved too,
 *   because a status change is the one a reader scanning for state cares about.
 * - `structure` — a section gained or lost entries.
 * - `text` — the revision exists, so something changed, but no section count
 *   moved and the status held. Wording inside an existing clause, or a field
 *   outside the document entirely (the Milestone assignment and the Roadmap rank
 *   are columns, not document JSON, and this projection cannot see them).
 */
export type RevisionKind = "created" | "status" | "structure" | "text";

export type RevisionEntry = {
  readonly entityType: VersionedEntityType;
  readonly entityKey: string;
  readonly title: string;
  readonly revision: number;
  readonly kind: RevisionKind;
  /** `meta.status` as this revision left it. */
  readonly status: string;
  readonly statusChanged: boolean;
  readonly sectionDeltas: readonly SectionDelta[];
  /** The actor id on the row: a Clerk user, or the identity that acted for them. */
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly createdAt: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Entry counts for every addressable section of one document.
 *
 * Two levels deep from `content`, descending into plain objects and never into
 * arrays. That is exactly the set of section arrays — `acceptance_criteria` at the
 * top, `scope.included` and `requirements.functional` one level down — and it
 * excludes the arrays *inside* an item, such as a workflow's steps. A step count
 * belongs to its workflow, not to the document, and hoisting it would make one
 * reworded step read as a structural change to the whole specification.
 *
 * Deliberately generic: a section added to the schema tomorrow is counted here
 * without this file being touched, which is the opposite of a hand-kept list that
 * silently stops reporting the newest section.
 */
function sectionCounts(document: Record<string, unknown>): Map<string, number> {
  const counts = new Map<string, number>();

  const walk = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (Array.isArray(value)) {
        counts.set(path, value.length);
      } else if (depth > 0 && typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, path, depth - 1);
      }
    }
  };

  walk(asRecord(document.content), "", 1);

  // Sources live beside `content`, not in it, but a Source appearing or being
  // superseded is a structural change to the document's evidence and belongs in
  // the same diff.
  const sources = asRecord(document.provenance).sources;
  if (Array.isArray(sources)) counts.set("provenance.sources", sources.length);

  return counts;
}

/** Sections whose entry count moved, in a stable order. Unchanged ones are omitted. */
function deltasBetween(
  before: Map<string, number>,
  after: Map<string, number>,
): readonly SectionDelta[] {
  const sections = [...new Set([...before.keys(), ...after.keys()])].sort();
  return sections.flatMap((section) => {
    const from = before.get(section) ?? 0;
    const to = after.get(section) ?? 0;
    return from === to ? [] : [{ section, from, to }];
  });
}

function kindOf(
  revision: number,
  statusChanged: boolean,
  deltas: readonly SectionDelta[],
): RevisionKind {
  if (revision <= 1) return "created";
  if (statusChanged) return "status";
  return deltas.length > 0 ? "structure" : "text";
}

/** What one page of the log may be narrowed by, before it is cut. */
export type RevisionFilter = {
  readonly offset: number;
  readonly limit: number;
  /** `YYYY-MM-DD`, inclusive, compared in UTC. */
  readonly from?: string;
  readonly to?: string;
  readonly entityType?: VersionedEntityType;
  readonly kind?: RevisionKind;
  readonly actor?: string;
  readonly entityKey?: string;
};

export type RevisionPage = {
  readonly revisions: readonly RevisionEntry[];
  /** Matches after filtering, before the page was cut. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** Every actor in the filtered set, so a control cannot offer a vanishing option. */
  readonly actors: readonly { readonly actor: string; readonly count: number }[];
  readonly reasonCount: number;
  readonly earliest: string | null;
  readonly latest: string | null;
};

const day = (iso: string): string => iso.slice(0, 10);

function matches(entry: RevisionEntry, filter: RevisionFilter): boolean {
  if (filter.from && day(entry.createdAt) < filter.from) return false;
  if (filter.to && day(entry.createdAt) > filter.to) return false;
  if (filter.entityType && entry.entityType !== filter.entityType) return false;
  if (filter.kind && entry.kind !== filter.kind) return false;
  if (filter.actor && entry.changedBy !== filter.actor) return false;
  if (filter.entityKey && entry.entityKey !== filter.entityKey) return false;
  return true;
}

/**
 * One page of the log, plus what a filter control needs to describe the whole of it.
 *
 * Filtering and paging happen after the diff because the diff is what `kind`
 * classifies: "structure" is not a stored column, it is the outcome of comparing
 * two snapshots. The cost is bounded by the project's history rather than by the
 * page, which is the trade this makes deliberately — and it is why the page, not
 * the log, is what crosses the wire.
 */
export async function loadRevisionPage(
  scope: WorkspaceScope,
  projectId: string,
  filter: RevisionFilter,
): Promise<RevisionPage> {
  const all = await loadRevisionLog(scope, projectId);
  const filtered = all.filter((entry) => matches(entry, filter));

  const counts = new Map<string, number>();
  for (const entry of filtered) {
    counts.set(entry.changedBy, (counts.get(entry.changedBy) ?? 0) + 1);
  }

  const days = all.map((entry) => day(entry.createdAt)).sort();

  return {
    revisions: filtered.slice(filter.offset, filter.offset + filter.limit),
    total: filtered.length,
    offset: filter.offset,
    limit: filter.limit,
    actors: [...counts.entries()]
      .map(([actor, count]) => ({ actor, count }))
      .sort((left, right) => right.count - left.count),
    reasonCount: new Set(
      filtered.flatMap((entry) => (entry.changeReason ? [entry.changeReason] : [])),
    ).size,
    // The bounds of the whole log, not of the filtered set: they are the limits a
    // date input should allow, and narrowing them to the current filter would make
    // the control fight the filter it is part of.
    earliest: days[0] ?? null,
    latest: days.at(-1) ?? null,
  };
}

/**
 * Every revision in one project, newest first.
 *
 * One query. The per-entity history is reconstructed in memory because the diff
 * needs revision N-1 beside revision N, and asking the database for adjacent pairs
 * is either a window function whose result still has to be walked, or one query
 * per entity.
 */
async function loadRevisionLog(
  scope: WorkspaceScope,
  projectId: string,
): Promise<readonly RevisionEntry[]> {
  const rows = await entityRevisionRepository.listByProject(scope, projectId);

  // Grouped by entity so each revision is compared with its own predecessor.
  // `listByProject` orders by (entity_type, entity_id, revision), so a bucket is
  // already in ascending revision order and needs no second sort.
  const histories = new Map<string, EntityRevisionRow[]>();
  for (const row of rows) {
    const id = `${row.entityType}:${row.entityId}`;
    const bucket = histories.get(id);
    if (bucket) bucket.push(row);
    else histories.set(id, [row]);
  }

  const entries: RevisionEntry[] = [];
  for (const history of histories.values()) {
    let previousStatus: string | null = null;
    let previousCounts = new Map<string, number>();

    for (const row of history) {
      const meta = asRecord(row.document.meta);
      const status = asText(meta.status);
      const counts = sectionCounts(row.document);
      const first = row.revision <= 1 || previousStatus === null;
      const statusChanged = !first && status !== previousStatus;
      const sectionDeltas = first ? [] : deltasBetween(previousCounts, counts);

      entries.push({
        entityType: row.entityType,
        // `meta.key` is stamped by the server on every write, so a revision names
        // the entity as it was called at the time rather than as it is called now.
        entityKey: asText(meta.key),
        title: asText(meta.title),
        revision: row.revision,
        kind: kindOf(row.revision, statusChanged, sectionDeltas),
        status,
        statusChanged,
        sectionDeltas,
        changedBy: row.changedBy,
        changeReason: row.changeReason,
        createdAt: row.createdAt.toISOString(),
      });

      previousStatus = status;
      previousCounts = counts;
    }
  }

  // Newest first across the whole project, which is the order the surface reads
  // in. The revision number breaks a tie, since a change set writes several
  // revisions inside one transaction and they share a timestamp.
  return entries.sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      right.revision - left.revision ||
      left.entityKey.localeCompare(right.entityKey),
  );
}
