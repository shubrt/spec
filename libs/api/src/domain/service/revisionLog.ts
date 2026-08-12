import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { entityRevisionRepository } from "../repository/entityRevision";

/** How many entries one document section held before and after a revision. */
export type SectionDelta = {
  readonly section: string;
  readonly from: number;
  readonly to: number;
};

/**
 * What kind of change a revision records, in priority order: its first snapshot,
 * a status transition, a section-count change, or another textual/column change.
 */
export type RevisionKind = "created" | "status" | "structure" | "text";

export type RevisionEntry = {
  readonly entityType: VersionedEntityType;
  readonly entityKey: string;
  readonly title: string;
  readonly revision: number;
  readonly kind: RevisionKind;
  readonly status: string;
  readonly statusChanged: boolean;
  readonly sectionDeltas: readonly SectionDelta[];
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly createdAt: string;
};

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

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const asActors = (value: unknown): readonly { readonly actor: string; readonly count: number }[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const actor = asRecord(item).actor;
        const count = asNonNegativeInteger(asRecord(item).count);
        return typeof actor === "string" && count !== null ? [{ actor, count }] : [];
      })
    : [];

/**
 * One revision page from the compact database projection.
 *
 * Adjacent section counts are diffed, filters are applied, and the requested
 * slice is cut inside one SQL statement. Full immutable snapshots remain in
 * `entity_revision` but are not selected for this read. The repository returns
 * one metadata-only row when the page is empty, which is why nullable page fields
 * are discarded here rather than leaking into the public response shape.
 */
export async function loadRevisionPage(
  scope: WorkspaceScope,
  projectId: string,
  filter: RevisionFilter,
): Promise<RevisionPage> {
  const rows = await entityRevisionRepository.pageByProject(scope, projectId, filter);
  const summary = rows[0];

  return {
    revisions: rows.flatMap((row) =>
      row.entityType === null || row.createdAt === null
        ? []
        : [
            {
              entityType: row.entityType,
              entityKey: row.entityKey,
              title: row.title,
              revision: row.revision,
              kind: row.kind,
              status: row.status,
              statusChanged: row.statusChanged,
              sectionDeltas: row.sectionDeltas,
              changedBy: row.changedBy,
              changeReason: row.changeReason,
              createdAt: row.createdAt.toISOString(),
            },
          ],
    ),
    total: summary?.total ?? 0,
    offset: filter.offset,
    limit: filter.limit,
    actors: asActors(summary?.actors),
    reasonCount: summary?.reasonCount ?? 0,
    earliest: summary?.earliest ?? null,
    latest: summary?.latest ?? null,
  };
}
