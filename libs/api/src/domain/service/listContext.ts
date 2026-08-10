import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { parseVersionedKey } from "../keys";
import {
  type ListContextEntityRow,
  type ListContextParentEntity,
  type ListContextProjectRow,
  listContextRepository,
} from "../repository/listContext";
import { referenceService } from "./reference";

/**
 * `list_context` answers discovery without loading any entity document.
 *
 * With no selector it lists project names. Any project, entity, status, hierarchy
 * parent or milestone selector switches to compact entity rows. Milestones are an
 * overlay on Streams and their Tasks, never another parent in the work tree. The
 * cursor is deliberately owned by this service rather than the MCP tool:
 * pagination is domain behaviour, while rendering a page as text is transport
 * behaviour.
 */

export const DEFAULT_LIST_CONTEXT_LIMIT = 50;
export const MAX_LIST_CONTEXT_LIMIT = 200;

const MAX_CURSOR_OFFSET = 1_000_000;

export type ListContextInput = {
  readonly project?: string;
  readonly entity?: VersionedEntityType;
  readonly status?: string;
  readonly parent?: string;
  readonly milestone?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type ListContextPage =
  | {
      readonly ok: true;
      readonly mode: "projects";
      readonly projects: readonly ListContextProjectRow[];
      readonly rows: readonly [];
      readonly nextCursor: string | null;
    }
  | {
      readonly ok: true;
      readonly mode: "entities";
      readonly projects: readonly [];
      readonly rows: readonly ListContextEntityRow[];
      readonly nextCursor: string | null;
    };

export type ListContextFailure =
  | {
      readonly ok: false;
      readonly reason: "invalid_cursor";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unknown_project";
      readonly ref: string;
    }
  | {
      readonly ok: false;
      readonly reason: "not_a_key";
      readonly key: string;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found";
      readonly key: string;
    }
  | {
      readonly ok: false;
      readonly reason: "ambiguous";
      readonly key: string;
      readonly projectNames: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_parent_kind";
      readonly key: string;
      readonly entity: VersionedEntityType;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_milestone_kind";
      readonly key: string;
      readonly entity: VersionedEntityType;
    };

export type ListContextResult = ListContextPage | ListContextFailure;

type CursorMode = ListContextPage["mode"];

type CursorPayload = {
  readonly version: 1;
  readonly mode: CursorMode;
  readonly offset: number;
  readonly filter: string;
};

const modeOf = (input: ListContextInput): CursorMode =>
  input.project === undefined &&
  input.entity === undefined &&
  input.status === undefined &&
  input.parent === undefined &&
  input.milestone === undefined
    ? "projects"
    : "entities";

/** The cursor is bound to the selectors that produced it, so it cannot drift to another list. */
const filterOf = (input: ListContextInput): string =>
  JSON.stringify({
    project: input.project ?? null,
    entity: input.entity ?? null,
    status: input.status ?? null,
    parent: input.parent ?? null,
    milestone: input.milestone ?? null,
  });

const encodeCursor = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodeCursor = (
  value: string | undefined,
  mode: CursorMode,
  filter: string,
): { readonly ok: true; readonly offset: number } | ListContextFailure => {
  if (value === undefined) {
    return { ok: true, offset: 0 };
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("cursor payload is not an object");
    }
    const payload = decoded as Record<string, unknown>;
    if (
      payload.version !== 1 ||
      payload.mode !== mode ||
      payload.filter !== filter ||
      typeof payload.offset !== "number" ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset < 0 ||
      payload.offset > MAX_CURSOR_OFFSET
    ) {
      throw new Error("cursor payload does not match this list");
    }
    return { ok: true, offset: payload.offset };
  } catch {
    return {
      ok: false,
      reason: "invalid_cursor",
      message:
        "The cursor is invalid or belongs to different filters. Start again without cursor, then repeat the same filters with the returned cursor.",
    };
  }
};

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_CONTEXT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_CONTEXT_LIMIT);
};

const nextCursor = (
  hasMore: boolean,
  mode: CursorMode,
  filter: string,
  offset: number,
  returned: number,
): string | null =>
  hasMore ? encodeCursor({ version: 1, mode, filter, offset: offset + returned }) : null;

async function listProjects(
  scope: WorkspaceScope,
  offset: number,
  limit: number,
  filter: string,
): Promise<ListContextPage> {
  const found = await listContextRepository.listProjects(scope, {
    limit: limit + 1,
    offset,
  });
  const hasMore = found.length > limit;
  const projects = found.slice(0, limit);
  return {
    ok: true,
    mode: "projects",
    projects,
    rows: [],
    nextCursor: nextCursor(hasMore, "projects", filter, offset, projects.length),
  };
}

async function listEntities(
  scope: WorkspaceScope,
  input: ListContextInput,
  offset: number,
  limit: number,
  filter: string,
): Promise<ListContextResult> {
  let projectId: string | undefined;
  if (input.project !== undefined) {
    const project = await referenceService.resolveProject(scope, input.project);
    if (!project.ok) {
      return project;
    }
    projectId = project.project.id;
  }

  let parent: { readonly entity: ListContextParentEntity; readonly id: string } | undefined;
  if (input.parent !== undefined) {
    const parsed = parseVersionedKey(input.parent);
    if (parsed === null) {
      return { ok: false, reason: "not_a_key", key: input.parent };
    }
    if (parsed.entity !== "epic" && parsed.entity !== "stream") {
      return {
        ok: false,
        reason: "invalid_parent_kind",
        key: input.parent,
        entity: parsed.entity,
      };
    }
    const candidates = await listContextRepository.findByKey(scope, {
      entity: parsed.entity,
      key: input.parent,
      projectId,
    });
    const [only, ...rest] = candidates;
    if (!only) {
      return { ok: false, reason: "not_found", key: input.parent };
    }
    if (rest.length > 0) {
      return {
        ok: false,
        reason: "ambiguous",
        key: input.parent,
        projectNames: candidates.map((candidate) => candidate.project),
      };
    }
    projectId ??= only.projectId;
    parent = { entity: parsed.entity, id: only.id };
  }

  let milestoneId: string | undefined;
  if (input.milestone !== undefined) {
    const parsed = parseVersionedKey(input.milestone);
    if (parsed === null) {
      return { ok: false, reason: "not_a_key", key: input.milestone };
    }
    if (parsed.entity !== "milestone") {
      return {
        ok: false,
        reason: "invalid_milestone_kind",
        key: input.milestone,
        entity: parsed.entity,
      };
    }
    const candidates = await listContextRepository.findByKey(scope, {
      entity: "milestone",
      key: input.milestone,
      projectId,
    });
    const [only, ...rest] = candidates;
    if (!only) {
      return { ok: false, reason: "not_found", key: input.milestone };
    }
    if (rest.length > 0) {
      return {
        ok: false,
        reason: "ambiguous",
        key: input.milestone,
        projectNames: candidates.map((candidate) => candidate.project),
      };
    }
    projectId ??= only.projectId;
    milestoneId = only.id;
  }

  const found = await listContextRepository.listEntities(scope, {
    projectId,
    entity: input.entity,
    status: input.status,
    parent,
    milestoneId,
    limit: limit + 1,
    offset,
  });
  const hasMore = found.length > limit;
  const rows = found.slice(0, limit);
  return {
    ok: true,
    mode: "entities",
    projects: [],
    rows,
    nextCursor: nextCursor(hasMore, "entities", filter, offset, rows.length),
  };
}

async function listContext(
  scope: WorkspaceScope,
  input: ListContextInput,
): Promise<ListContextResult> {
  const mode = modeOf(input);
  const filter = filterOf(input);
  const cursor = decodeCursor(input.cursor, mode, filter);
  if (!cursor.ok) {
    return cursor;
  }
  const limit = clampLimit(input.limit);
  return mode === "projects"
    ? await listProjects(scope, cursor.offset, limit, filter)
    : await listEntities(scope, input, cursor.offset, limit, filter);
}

export const listContextService = { listContext };
