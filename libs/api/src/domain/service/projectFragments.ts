import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { projectFragmentRepository } from "../repository/projectFragment";
import {
  readFragments,
  SECTION_ORDER,
  type SectionId,
  type SpecFragmentModel,
} from "./specFragment";

export { fragmentText } from "./specFragment";

/**
 * Specification fragments as a queryable collection.
 *
 * The authoritative fragments still live inside each document. A transactional
 * projection expands them once per write with the same TypeScript reader used by
 * detail pages. Reads can therefore filter, count and page in SQL without copying
 * the document-shape rules into SQL or transferring the rest of the project.
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

type FragmentDocument = {
  readonly key: string;
  readonly document: Record<string, unknown>;
};

type FragmentOwner = FragmentDocument & {
  readonly entityType: VersionedEntityType;
  readonly title: string;
};

type ImplementingTask = FragmentDocument & {
  readonly streamId: string;
};

/**
 * Indexes Task implementation edges by their globally addressable Stream fragment.
 *
 * The Stream rows supplied by the caller define the boundary: a detail request can
 * pass one parent and query only its Tasks, while the project-wide fragment page
 * can pass the complete collections it already loaded.
 */
export function indexImplementationBacklinks(
  tasks: readonly ImplementingTask[],
  streams: readonly { readonly id: string; readonly key: string }[],
): ReadonlyMap<string, readonly string[]> {
  const streamKeyById = new Map(streams.map((stream) => [stream.id, stream.key]));
  const implementedBy = new Map<string, string[]>();
  for (const task of tasks) {
    const streamKey = streamKeyById.get(task.streamId);
    if (streamKey === undefined) continue;
    for (const anchor of taskTargetAnchors(task.document, streamKey)) {
      const bucket = implementedBy.get(anchor);
      if (bucket) bucket.push(task.key);
      else implementedBy.set(anchor, [task.key]);
    }
  }
  return implementedBy;
}

/** Extracts one already-loaded entity's fragments and attaches known backlinks. */
export function extractDocumentFragments(
  owner: FragmentOwner,
  implementedBy: ReadonlyMap<string, readonly string[]> = new Map(),
): readonly FragmentEntry[] {
  return readFragments(owner.key, owner.document).map((fragment) => {
    const anchor = `${fragment.owner}#${fragment.id}`;
    return {
      ...fragment,
      ownerType: owner.entityType,
      ownerTitle: owner.title,
      anchor,
      implementedBy: implementedBy.get(anchor) ?? [],
    };
  });
}

/** The anchors one Task's `implements` names, resolved against its parent Stream. */
function taskTargetAnchors(
  document: Record<string, unknown>,
  streamKey: string,
): readonly string[] {
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
          .map((id) => `${streamKey}#${id}`),
  );
}

export async function loadFragmentPage(
  scope: WorkspaceScope,
  projectId: string,
  filter: FragmentFilter,
): Promise<FragmentPage> {
  const page = await projectFragmentRepository.loadPage(scope, projectId, filter);

  return {
    fragments: page.rows.map((row) => ({
      ...row.fragment,
      ownerType: row.ownerType,
      ownerTitle: row.ownerTitle,
      anchor: row.anchor,
      implementedBy: row.backlinks.map((backlink) => backlink.key),
    })),
    total: page.total,
    offset: filter.offset,
    limit: filter.limit,
    sectionCounts: [...page.sectionCounts].sort(
      (left, right) =>
        SECTION_ORDER.indexOf(left.section as SectionId) -
        SECTION_ORDER.indexOf(right.section as SectionId),
    ),
    ownerCount: page.ownerCount,
  };
}
