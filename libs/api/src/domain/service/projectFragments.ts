import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { epicRepository } from "../repository/epic";
import { milestoneRepository } from "../repository/milestone";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";
import { readFragments, type SectionId, type SpecFragmentModel } from "./specFragment";

/**
 * Specification fragments as a queryable collection.
 *
 * A fragment is not a row. `FR-1`, `AC-2` and `CHG-1` live inside `content` as
 * jsonb, so they have no identity the database can filter, count or rank by — which
 * is why the browser used to hold every document in order to page a list of them.
 *
 * This reads the documents once and expands them here. Filtering, counting and
 * paging then happen over a materialised array rather than over the wire.
 *
 * ## Why not SQL
 *
 * `jsonb_array_elements` over a lateral join of the known section paths would push
 * this into the query planner, and the shape is written down in `specFragment.ts`
 * already. But the *text* of a fragment is not a jsonb field — it is assembled from
 * three or four of them by the readers there (a criterion is given/when/then, a
 * transition is current→desired). Expanding in SQL would mean writing those
 * assemblies a second time, in a second language, and a search that disagreed with
 * the renderer about what a fragment says is worse than a slower one that agrees.
 *
 * So the documents are read and the readers run once per request. The cost is
 * proportional to the project rather than to the page — see `bench` figures in the
 * plan — and the escalation, if a project ever outgrows it, is a projection table
 * behind this same function rather than a different shape above it.
 */

export interface FragmentFilter {
  readonly offset: number;
  readonly limit: number;
  readonly section?: SectionId;
  readonly owner?: string;
  /** Case-insensitive substring over the anchor and the fragment's own text. */
  readonly q?: string;
}

/** One fragment, with the owner that makes its local id mean anything. */
export interface FragmentEntry extends SpecFragmentModel {
  readonly ownerType: VersionedEntityType;
  readonly ownerTitle: string;
  /** `S-46#CHG-1` — the only globally unique form. */
  readonly anchor: string;
  /** Tasks whose `implements` edge names this fragment. Empty where none does. */
  readonly implementedBy: readonly string[];
}

export interface FragmentPage {
  readonly fragments: readonly FragmentEntry[];
  /** Matches after filtering, before the page was cut. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /**
   * Count per section across the *unfiltered* project, so the chip row shows the
   * same numbers whichever chip is active. A control built from the filtered set
   * offers options that vanish when you turn it.
   */
  readonly sectionCounts: readonly { readonly section: string; readonly count: number }[];
  readonly ownerCount: number;
}

/** Every fragment of one project, in reading order, owners resolved. */
async function loadAll(
  scope: WorkspaceScope,
  projectId: string,
): Promise<readonly FragmentEntry[]> {
  const [epics, streams, tasks, milestones] = await Promise.all([
    epicRepository.listByProject(scope, projectId),
    streamRepository.listByProject(scope, projectId),
    taskRepository.listByProject(scope, projectId),
    milestoneRepository.listByProject(scope, projectId),
  ]);

  // Which Tasks name which fragment. Built from the Tasks already in hand, so the
  // backlink costs no extra query — and it is the one relation a fragment carries
  // that is not inside its own document.
  const implementedBy = new Map<string, string[]>();
  for (const task of tasks) {
    for (const anchor of taskTargetAnchors(task.document, task.streamId, streams)) {
      const bucket = implementedBy.get(anchor);
      if (bucket) bucket.push(task.key);
      else implementedBy.set(anchor, [task.key]);
    }
  }

  const owners: readonly {
    readonly type: VersionedEntityType;
    readonly rows: readonly { key: string; title: string; document: Record<string, unknown> }[];
  }[] = [
    { type: "epic", rows: epics },
    { type: "stream", rows: streams },
    { type: "task", rows: tasks },
    { type: "milestone", rows: milestones },
  ];

  return owners.flatMap(({ type, rows }) =>
    rows.flatMap((row) =>
      readFragments(row.key, row.document).map((fragment) => {
        const anchor = `${fragment.owner}#${fragment.id}`;
        return {
          ...fragment,
          ownerType: type,
          ownerTitle: row.title,
          anchor,
          implementedBy: implementedBy.get(anchor) ?? [],
        };
      }),
    ),
  );
}

/** The anchors one Task's `implements` names, resolved against its parent Stream. */
function taskTargetAnchors(
  document: Record<string, unknown>,
  streamId: string,
  streams: readonly { id: string; key: string }[],
): readonly string[] {
  const parent = streams.find((stream) => stream.id === streamId);
  if (!parent) return [];
  const content = document.content;
  const implementsValue =
    typeof content === "object" && content !== null && !Array.isArray(content)
      ? (content as Record<string, unknown>).implements
      : undefined;
  if (typeof implementsValue !== "object" || implementsValue === null) return [];
  return Object.entries(implementsValue as Record<string, unknown>).flatMap(([field, value]) =>
    field === "stream_id" || !Array.isArray(value)
      ? []
      : value
          .filter((id): id is string => typeof id === "string")
          .map((id) => `${parent.key}#${id}`),
  );
}

function matches(entry: FragmentEntry, filter: FragmentFilter): boolean {
  if (filter.section && entry.section !== filter.section) return false;
  if (filter.owner && entry.owner !== filter.owner) return false;
  if (filter.q) {
    const needle = filter.q.trim().toLowerCase();
    if (!`${entry.anchor} ${fragmentText(entry)}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** One line of a fragment, whatever shape it is in. The same assembly the UI renders. */
export function fragmentText(fragment: SpecFragmentModel): string {
  const { shape } = fragment;
  switch (shape.kind) {
    case "statement":
      return shape.text;
    case "criterion":
      return `Given ${shape.given} · When ${shape.when} · Then ${shape.then}`;
    case "condition":
      return `${shape.condition} → ${shape.outcome}`;
    case "transition":
      return `${shape.from} → ${shape.to}`;
    case "workflow":
      return shape.steps.map((step) => step.action).join(" · ");
  }
}

export async function loadFragmentPage(
  scope: WorkspaceScope,
  projectId: string,
  filter: FragmentFilter,
): Promise<FragmentPage> {
  const all = await loadAll(scope, projectId);
  const filtered = all.filter((entry) => matches(entry, filter));

  const counts = new Map<string, number>();
  for (const entry of all) {
    counts.set(entry.section, (counts.get(entry.section) ?? 0) + 1);
  }

  return {
    fragments: filtered.slice(filter.offset, filter.offset + filter.limit),
    total: filtered.length,
    offset: filter.offset,
    limit: filter.limit,
    sectionCounts: [...counts.entries()].map(([section, count]) => ({ section, count })),
    ownerCount: new Set(filtered.map((entry) => entry.owner)).size,
  };
}

/** How many fragments the project holds. The size of the corpus, without its text. */
export async function countProjectFragments(
  scope: WorkspaceScope,
  projectId: string,
): Promise<number> {
  return (await loadAll(scope, projectId)).length;
}

/** Every fragment of one entity, for the page that renders that entity's document. */
export async function loadEntityFragments(
  scope: WorkspaceScope,
  projectId: string,
  key: string,
): Promise<readonly FragmentEntry[]> {
  const all = await loadAll(scope, projectId);
  return all.filter((entry) => entry.owner === key);
}
