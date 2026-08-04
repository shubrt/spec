import { z } from "zod";
import { ENTITY_TYPE, STREAM_TYPE, type EntityType, type StreamType } from "../enums";
import { epicContent } from "./epic/content";
import {
  documentEnvelope,
  epicLinks,
  epicMeta,
  streamLinks,
  streamMeta,
  STORED_ONLY_META_KEYS,
  taskLinks,
  taskMeta,
} from "./envelope";
import { streamReadinessIssues, taskReadinessIssues } from "./readiness";
import { ruleIssue, shapeIssue, type DocumentIssue } from "./rules";
import { streamBaseContent } from "./stream/base";
import { STREAM_CONTENT } from "./stream/registry";
import { taskContent, taskExecution } from "./task/content";

/**
 * `parseDocument` — the only way into this layer.
 *
 * Everything else in `domain/schema/**` is an ingredient. Repositories, services,
 * the change-set engine and the MCP tools all go through this one function, for
 * three reasons that each cost a bug if bypassed:
 *
 * 1. **Schema selection happens before parsing.** A stream's content schema is
 *    chosen from `meta.stream_type` via `stream/registry.ts`. A call site that
 *    reached for `featureStreamContent` directly would validate a bug stream
 *    against the wrong schema.
 * 2. **The readiness gates run after the shape parses.** They are plain functions,
 *    not `.refine()` (see `readiness.ts`), so a raw `schema.parse()` skips every
 *    domain spec §11 gate silently.
 * 3. **The meta tier is chosen here.** `source: "agent"` is the default, so a
 *    forgotten argument fails closed and server-owned fields stay unforgeable.
 *
 * `test/domain/schema/document.test.ts` asserts this module's runtime export
 * surface and scans `src/` for imports that reach past it.
 */

export const EPIC_SCHEMA_VERSION = "pm.epic.v1";
export const STREAM_SCHEMA_VERSION = "pm.stream.v1";
export const TASK_SCHEMA_VERSION = "pm.task.v1";

/**
 * Where the document came from.
 *
 * - `agent` — written by an MCP client. `meta` is the input tier: `title`,
 *   `status`, `priority` and the type discriminator only.
 * - `store` — read back from the database or from `entity_revision`. `meta` is
 *   the stored tier and additionally carries the server-assigned fields.
 */
export type DocumentSource = "agent" | "store";

/* ----------------------------------------------------------------- schemas */

const epicDocument = {
  agent: documentEnvelope({
    entity: "epic",
    schemaVersion: EPIC_SCHEMA_VERSION,
    meta: epicMeta.input,
    content: epicContent,
    links: epicLinks,
  }),
  store: documentEnvelope({
    entity: "epic",
    schemaVersion: EPIC_SCHEMA_VERSION,
    meta: epicMeta.stored,
    content: epicContent,
    links: epicLinks,
  }),
} as const;

const streamDocument = <Meta extends z.ZodType, Content extends z.ZodType>(
  meta: Meta,
  content: Content,
) =>
  documentEnvelope({
    entity: "stream",
    schemaVersion: STREAM_SCHEMA_VERSION,
    meta,
    content,
    links: streamLinks,
  });

/**
 * One document schema per *distinct* content schema, not per stream type: the
 * four types that still use the base share one schema instance.
 *
 * `test/domain/schema/registry.test.ts` asserts that `STREAM_CONTENT` contains
 * exactly these four distinct content schemas, so adding an `experiment` content
 * schema to the registry without wiring it up here fails a test rather than
 * quietly validating experiments against the base.
 */
const streamDocuments = {
  agent: {
    feature: streamDocument(streamMeta.input, STREAM_CONTENT.feature),
    bug: streamDocument(streamMeta.input, STREAM_CONTENT.bug),
    investigation: streamDocument(streamMeta.input, STREAM_CONTENT.investigation),
    base: streamDocument(streamMeta.input, streamBaseContent),
  },
  store: {
    feature: streamDocument(streamMeta.stored, STREAM_CONTENT.feature),
    bug: streamDocument(streamMeta.stored, STREAM_CONTENT.bug),
    investigation: streamDocument(streamMeta.stored, STREAM_CONTENT.investigation),
    base: streamDocument(streamMeta.stored, streamBaseContent),
  },
} as const;

/**
 * The task document is the envelope plus one extra top-level section,
 * `execution` (domain spec §7). Measured on Zod 4.4.3: `.extend()` on a
 * `strictObject` returns a `strictObject`, so `additionalProperties: false`
 * survives — a test pins that rather than trusting it.
 */
const taskDocument = {
  agent: documentEnvelope({
    entity: "task",
    schemaVersion: TASK_SCHEMA_VERSION,
    meta: taskMeta.input,
    content: taskContent,
    links: taskLinks,
  }).extend({ execution: taskExecution.optional() }),
  store: documentEnvelope({
    entity: "task",
    schemaVersion: TASK_SCHEMA_VERSION,
    meta: taskMeta.stored,
    content: taskContent,
    links: taskLinks,
  }).extend({ execution: taskExecution.optional() }),
} as const;

/**
 * Every document schema this layer can produce, keyed the way `get_entity_schema`
 * and the `zpecs://schema/*` resources address them.
 *
 * This is an **inside-the-layer** export: `jsonSchema.ts` needs the schema
 * objects to convert them, and nothing else does. No call site outside
 * `domain/schema/` may parse through this map — `parseDocument` is the entry
 * point, and `test/domain/schema/document.test.ts` scans `src/` to enforce it.
 */
export const DOCUMENT_SCHEMAS = {
  epic: epicDocument,
  "stream.feature": { agent: streamDocuments.agent.feature, store: streamDocuments.store.feature },
  "stream.bug": { agent: streamDocuments.agent.bug, store: streamDocuments.store.bug },
  "stream.investigation": {
    agent: streamDocuments.agent.investigation,
    store: streamDocuments.store.investigation,
  },
  /** The schema the four not-yet-modelled stream types validate against. */
  "stream.base": { agent: streamDocuments.agent.base, store: streamDocuments.store.base },
  task: taskDocument,
} as const satisfies Record<string, Record<DocumentSource, z.ZodType>>;

export type DocumentSchemaTarget = keyof typeof DOCUMENT_SCHEMAS;

/** Stable order for snapshots, `get_entity_schema` and the schema resources. */
export const DOCUMENT_SCHEMA_TARGETS = Object.keys(
  DOCUMENT_SCHEMAS,
) as readonly DocumentSchemaTarget[];

/**
 * The document types, per tier.
 *
 * The two tiers are genuinely different types rather than one optional-field
 * type: a stored document *has* an id, a key and a revision, and code that reads
 * `document.meta.revision` should not have to null-check it. So the stored types
 * are what `jsonbObject<T>()` gets parameterized with, while `ZpecsDocument` — the
 * union `parseDocument` returns — spans both, because what comes back depends on
 * the `source` the caller asked for.
 */
export type EpicDocumentInput = z.infer<typeof epicDocument.agent>;
export type EpicDocument = z.infer<typeof epicDocument.store>;

export type StreamDocumentInput =
  | z.infer<typeof streamDocuments.agent.feature>
  | z.infer<typeof streamDocuments.agent.bug>
  | z.infer<typeof streamDocuments.agent.investigation>
  | z.infer<typeof streamDocuments.agent.base>;
export type StreamDocument =
  | z.infer<typeof streamDocuments.store.feature>
  | z.infer<typeof streamDocuments.store.bug>
  | z.infer<typeof streamDocuments.store.investigation>
  | z.infer<typeof streamDocuments.store.base>;

export type TaskDocumentInput = z.infer<typeof taskDocument.agent>;
export type TaskDocument = z.infer<typeof taskDocument.store>;

/** A validated document as it is stored. Discriminated on `entity`. */
export type ZpecStoredDocument = EpicDocument | StreamDocument | TaskDocument;

/** Any validated document, either tier. What `parseDocument` returns. */
export type ZpecsDocument =
  | ZpecStoredDocument
  | EpicDocumentInput
  | StreamDocumentInput
  | TaskDocumentInput;

/* ------------------------------------------------------------- selection */

const isEntityType = (value: unknown): value is EntityType =>
  ENTITY_TYPE.some((candidate) => candidate === value);

const isStreamType = (value: unknown): value is StreamType =>
  STREAM_TYPE.some((candidate) => candidate === value);

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Picks the stream document schema for a type.
 *
 * Written as explicit cases rather than a lookup table because the table would
 * be a second copy of the type → content mapping that `stream/registry.ts`
 * already owns, and two copies drift. The `base` fallback is guarded by the
 * registry test named above.
 */
const streamSchemaFor = (source: DocumentSource, streamType: StreamType) => {
  const set = streamDocuments[source];
  if (streamType === "feature") return set.feature;
  if (streamType === "bug") return set.bug;
  if (streamType === "investigation") return set.investigation;
  return set.base;
};

/* -------------------------------------------------------------- reporting */

/**
 * Maps Zod issues onto rule ids where a rule genuinely applies.
 *
 * An `unrecognized_keys` issue is the runtime face of
 * `additionalProperties: false`, so it is the domain spec §14 rule. When the
 * rejected key is one of the server-owned `meta` fields it gets the more specific
 * rule instead, because "you cannot invent fields" is unhelpful feedback for an
 * agent that tried to write `meta.revision` — it needs to be told to use
 * `expected_revision`. Every other Zod issue is a plain shape failure and
 * carries no rule id.
 */
const toIssues = (error: z.ZodError): readonly DocumentIssue[] =>
  error.issues.flatMap((issue): readonly DocumentIssue[] => {
    const path = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => {
        const keyPath = path === "" ? key : `${path}.${key}`;
        return path === "meta" && STORED_ONLY_META_KEYS.includes(key)
          ? ruleIssue("server_owned_meta_is_not_writable", keyPath)
          : ruleIssue("no_invented_fields", keyPath);
      });
    }
    return [shapeIssue(path, issue.message)];
  });

export type ParseDocumentOptions = {
  /** Defaults to `"agent"`, the strict tier, so a forgotten option fails closed. */
  readonly source?: DocumentSource;
};

export type ParseDocumentResult =
  | { readonly ok: true; readonly document: ZpecsDocument }
  | { readonly ok: false; readonly issues: readonly DocumentIssue[] };

/**
 * Validates one epic, stream or task document.
 *
 * The order is load-bearing: read the discriminators, select the schema, parse
 * the shape, then run the readiness gates. Gates only run on a document that
 * parsed, because a gate reading a field of the wrong type would report a
 * confusing rule violation on top of a plain shape error.
 */
export const parseDocument = (
  candidate: unknown,
  options: ParseDocumentOptions = {},
): ParseDocumentResult => {
  const source = options.source ?? "agent";
  const entity = property(candidate, "entity");

  if (!isEntityType(entity)) {
    return {
      ok: false,
      issues: [
        shapeIssue(
          "entity",
          `Invalid input: expected one of ${ENTITY_TYPE.join(", ")}, received ${JSON.stringify(entity)}`,
        ),
      ],
    };
  }

  const meta = property(candidate, "meta");
  const status = property(meta, "status");

  if (entity === "epic") {
    const result = epicDocument[source].safeParse(candidate);
    return result.success
      ? { ok: true, document: result.data }
      : { ok: false, issues: toIssues(result.error) };
  }

  if (entity === "task") {
    const result = taskDocument[source].safeParse(candidate);
    if (!result.success) return { ok: false, issues: toIssues(result.error) };
    const issues = taskReadinessIssues(String(status), result.data.content);
    return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
  }

  const streamType = property(meta, "stream_type");
  if (!isStreamType(streamType)) {
    return {
      ok: false,
      issues: [
        shapeIssue(
          "meta.stream_type",
          `Invalid input: expected one of ${STREAM_TYPE.join(", ")}, received ${JSON.stringify(streamType)}`,
        ),
      ],
    };
  }

  const result = streamSchemaFor(source, streamType).safeParse(candidate);
  if (!result.success) return { ok: false, issues: toIssues(result.error) };
  const issues = streamReadinessIssues(streamType, String(status), result.data.content);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
};
