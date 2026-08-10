import { z } from "zod";
import {
  STREAM_TYPE,
  VERSIONED_ENTITY_TYPE,
  type StreamType,
  type VersionedEntityType,
} from "../enums";
import { epicContent } from "./epic/content";
import {
  documentEnvelope,
  epicLinks,
  epicMeta,
  milestoneLinks,
  milestoneMeta,
  ruleLinks,
  ruleMeta,
  streamLinks,
  streamMeta,
  STORED_ONLY_META_KEYS,
  taskLinks,
  taskMeta,
} from "./envelope";
import { documentIntegrityIssues } from "./integrity";
import { milestoneContent } from "./milestone/content";
import { milestoneReadinessIssues, streamReadinessIssues, taskReadinessIssues } from "./readiness";
import { ruleContent } from "./rule/content";
import { ruleIssue, shapeIssue, type DocumentIssue } from "./rules";
import { STREAM_CONTENT } from "./stream/registry";
import {
  PRE_V2_TRACE_NOT_RECORDED,
  taskContent,
  taskExecutionInput,
  taskExecutionStored,
} from "./task/content";

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
 * Callers outside `domain/schema/` must use this module rather than importing
 * concrete schema ingredients directly.
 */

export const EPIC_SCHEMA_VERSION = "pm.epic.v2";
export const STREAM_SCHEMA_VERSION = "pm.stream.v2";
export const TASK_SCHEMA_VERSION = "pm.task.v2";
export const RULE_SCHEMA_VERSION = "pm.rule.v2";
export const MILESTONE_SCHEMA_VERSION = "pm.milestone.v2";

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
    links: epicLinks.input,
  }),
  store: documentEnvelope({
    entity: "epic",
    schemaVersion: EPIC_SCHEMA_VERSION,
    meta: epicMeta.stored,
    content: epicContent,
    links: epicLinks.stored,
  }),
} as const;

const ruleDocument = {
  agent: documentEnvelope({
    entity: "rule",
    schemaVersion: RULE_SCHEMA_VERSION,
    meta: ruleMeta.input,
    content: ruleContent,
    links: ruleLinks.input,
  }),
  store: documentEnvelope({
    entity: "rule",
    schemaVersion: RULE_SCHEMA_VERSION,
    meta: ruleMeta.stored,
    content: ruleContent,
    links: ruleLinks.stored,
  }),
} as const;

const milestoneDocument = {
  agent: documentEnvelope({
    entity: "milestone",
    schemaVersion: MILESTONE_SCHEMA_VERSION,
    meta: milestoneMeta.input,
    content: milestoneContent,
    links: milestoneLinks.input,
  }),
  store: documentEnvelope({
    entity: "milestone",
    schemaVersion: MILESTONE_SCHEMA_VERSION,
    meta: milestoneMeta.stored,
    content: milestoneContent,
    links: milestoneLinks.stored,
  }),
} as const;

const streamDocument = <Meta extends z.ZodType, Content extends z.ZodType, Links extends z.ZodType>(
  meta: Meta,
  content: Content,
  links: Links,
) =>
  documentEnvelope({
    entity: "stream",
    schemaVersion: STREAM_SCHEMA_VERSION,
    meta,
    content,
    links,
  });

/**
 * One envelope per stream type, even when several types share the same base
 * content. Narrowing `meta.stream_type` to a literal is what makes each public
 * schema exact: a feature schema must reject a bug document before content is
 * considered, just as `parseDocument` selects by that discriminator at runtime.
 */
const streamDocumentPair = <const Type extends StreamType, Content extends z.ZodType>(
  streamType: Type,
  content: Content,
) => {
  const discriminator = { stream_type: z.literal(streamType) };
  return {
    agent: streamDocument(streamMeta.input.extend(discriminator), content, streamLinks.input),
    store: streamDocument(streamMeta.stored.extend(discriminator), content, streamLinks.stored),
  };
};

const streamDocuments = {
  feature: streamDocumentPair("feature", STREAM_CONTENT.feature),
  bug: streamDocumentPair("bug", STREAM_CONTENT.bug),
  investigation: streamDocumentPair("investigation", STREAM_CONTENT.investigation),
  change: streamDocumentPair("change", STREAM_CONTENT.change),
  experiment: streamDocumentPair("experiment", STREAM_CONTENT.experiment),
  refactor: streamDocumentPair("refactor", STREAM_CONTENT.refactor),
  maintenance: streamDocumentPair("maintenance", STREAM_CONTENT.maintenance),
} as const;

/**
 * The task document is the envelope plus one extra top-level section,
 * `execution` (domain spec §7). Measured on Zod 4.4.3: `.extend()` on a
 * `strictObject` returns a `strictObject`, so `additionalProperties: false`
 * survives in the generated contract.
 */
const taskDocument = {
  agent: documentEnvelope({
    entity: "task",
    schemaVersion: TASK_SCHEMA_VERSION,
    meta: taskMeta.input,
    content: taskContent,
    links: taskLinks.input,
  }).extend({ execution: taskExecutionInput.optional() }),
  store: documentEnvelope({
    entity: "task",
    schemaVersion: TASK_SCHEMA_VERSION,
    meta: taskMeta.stored,
    content: taskContent,
    links: taskLinks.stored,
  }).extend({ execution: taskExecutionStored.optional() }),
} as const;

/**
 * Every document schema this layer can produce, keyed the way `get_entity_schema`
 * and the `zpecs://schema/*` resources address them.
 *
 * This is an **inside-the-layer** export: `jsonSchema.ts` needs the schema
 * objects to convert them, and nothing else does. No call site outside
 * `domain/schema/` may parse through this map — `parseDocument` is the entry
 * point.
 */
export const DOCUMENT_SCHEMAS = {
  epic: epicDocument,
  "stream.feature": streamDocuments.feature,
  "stream.bug": streamDocuments.bug,
  "stream.investigation": streamDocuments.investigation,
  "stream.change": streamDocuments.change,
  "stream.experiment": streamDocuments.experiment,
  "stream.refactor": streamDocuments.refactor,
  "stream.maintenance": streamDocuments.maintenance,
  task: taskDocument,
  rule: ruleDocument,
  milestone: milestoneDocument,
} as const satisfies Record<string, Record<DocumentSource, z.ZodType>>;

export type DocumentSchemaTarget = keyof typeof DOCUMENT_SCHEMAS;

/** Stable order for generated contracts, `get_entity_schema` and schema resources. */
export const DOCUMENT_SCHEMA_TARGETS = Object.keys(
  DOCUMENT_SCHEMAS,
) as readonly DocumentSchemaTarget[];

/**
 * The document types, per tier.
 *
 * The two tiers are genuinely different types rather than one optional-field
 * type: a stored document *has* an id, a key and a revision, and code that reads
 * `document.meta.revision` should not have to null-check it. So the stored types
 * are what the Drizzle `jsonb()` columns are parameterized with, while
 * `ZpecsDocument` — the union `parseDocument` returns — spans both, because what
 * comes back depends on the `source` the caller asked for.
 */
export type EpicDocumentInput = z.infer<typeof epicDocument.agent>;
export type EpicDocument = z.infer<typeof epicDocument.store>;

export type StreamDocumentInput = z.infer<(typeof streamDocuments)[StreamType]["agent"]>;
export type StreamDocument = z.infer<(typeof streamDocuments)[StreamType]["store"]>;

export type TaskDocumentInput = z.infer<typeof taskDocument.agent>;
export type TaskDocument = z.infer<typeof taskDocument.store>;
export type RuleDocumentInput = z.infer<typeof ruleDocument.agent>;
export type RuleDocument = z.infer<typeof ruleDocument.store>;
export type MilestoneDocumentInput = z.infer<typeof milestoneDocument.agent>;
export type MilestoneDocument = z.infer<typeof milestoneDocument.store>;

/** A validated document as it is stored. Discriminated on `entity`. */
export type ZpecsStoredDocument =
  | EpicDocument
  | StreamDocument
  | TaskDocument
  | RuleDocument
  | MilestoneDocument;

/** Any validated document, either tier. What `parseDocument` returns. */
export type ZpecsDocument =
  | ZpecsStoredDocument
  | EpicDocumentInput
  | StreamDocumentInput
  | TaskDocumentInput
  | RuleDocumentInput
  | MilestoneDocumentInput;

/* ------------------------------------------------------------- selection */

const isVersionedEntityType = (value: unknown): value is VersionedEntityType =>
  VERSIONED_ENTITY_TYPE.some((candidate) => candidate === value);

const isStreamType = (value: unknown): value is StreamType =>
  STREAM_TYPE.some((candidate) => candidate === value);

const STORED_ONLY_TASK_EXECUTION_KEYS = [
  "trace_state",
  "stream_revision_started",
  "stream_revision_used",
  "rule_revisions_used",
] as const;

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Picks the stream document schema for a type.
 *
 * The type-indexed envelope narrows the discriminator and takes its content from
 * the one total registry, so runtime parsing and public schema generation cannot
 * choose different variants.
 */
const streamSchemaFor = (source: DocumentSource, streamType: StreamType) => {
  const pair = streamDocuments[streamType];
  return source === "agent" ? pair.agent : pair.store;
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
        return (path === "meta" && STORED_ONLY_META_KEYS.includes(key)) ||
          (path === "execution" && STORED_ONLY_TASK_EXECUTION_KEYS.some((field) => field === key))
          ? ruleIssue("server_owned_meta_is_not_writable", keyPath)
          : ruleIssue("no_invented_fields", keyPath);
      });
    }
    return [shapeIssue(path, issue.message)];
  });

const RULE_REFERENCE_FIELDS = new Set(["rule_key", "rule_keys", "constrained_by_rule_keys"]);

/** `$temp` references are an input convenience, never a valid persisted value. */
const storedRuleReferenceIssues = (value: unknown, path = ""): readonly DocumentIssue[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      storedRuleReferenceIssues(item, `${path}[${String(index)}]`),
    );
  }
  if (typeof value !== "object" || value === null) return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (RULE_REFERENCE_FIELDS.has(key)) {
      const values = Array.isArray(child) ? child : [child];
      return values.flatMap((candidate, index) =>
        typeof candidate === "string" && candidate.startsWith("$")
          ? [
              shapeIssue(
                Array.isArray(child) ? `${childPath}[${String(index)}]` : childPath,
                `${candidate} is an unresolved change-set temp reference; stored documents require a canonical R-* key.`,
              ),
            ]
          : [],
      );
    }
    return storedRuleReferenceIssues(child, childPath);
  });
};

const storedOnlyIssues = (source: DocumentSource, document: unknown): readonly DocumentIssue[] =>
  source === "store" ? storedRuleReferenceIssues(document) : [];

const taskTraceIssues = (status: string, execution: unknown): readonly DocumentIssue[] => {
  const trace = property(execution, "trace_state");
  if (trace !== PRE_V2_TRACE_NOT_RECORDED) return [];
  const issues: DocumentIssue[] = [];
  if (status !== "done" && status !== "cancelled") {
    issues.push(
      shapeIssue(
        "execution.trace_state",
        `${PRE_V2_TRACE_NOT_RECORDED} is valid only for a terminal Task imported from v1.`,
      ),
    );
  }
  for (const field of ["stream_revision_started", "stream_revision_used", "rule_revisions_used"]) {
    if (property(execution, field) !== undefined) {
      issues.push(
        shapeIssue(
          `execution.${field}`,
          `${field} cannot be recorded when trace_state says the pre-v2 history is unavailable.`,
        ),
      );
    }
  }
  return issues;
};

export type ParseDocumentOptions = {
  /** Defaults to `"agent"`, the strict tier, so a forgotten option fails closed. */
  readonly source?: DocumentSource;
};

export type ParseDocumentResult =
  | { readonly ok: true; readonly document: ZpecsDocument }
  | { readonly ok: false; readonly issues: readonly DocumentIssue[] };

/**
 * Validates one versioned Zpecs document.
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

  if (!isVersionedEntityType(entity)) {
    return {
      ok: false,
      issues: [
        shapeIssue(
          "entity",
          `Invalid input: expected one of ${VERSIONED_ENTITY_TYPE.join(", ")}, received ${JSON.stringify(entity)}`,
        ),
      ],
    };
  }

  const meta = property(candidate, "meta");
  const status = property(meta, "status");

  if (entity === "epic") {
    const result = epicDocument[source].safeParse(candidate);
    if (!result.success) return { ok: false, issues: toIssues(result.error) };
    const issues = [
      ...documentIntegrityIssues({
        entity: "epic",
        status: String(status),
        content: result.data.content,
        provenance: result.data.provenance,
      }),
      ...storedOnlyIssues(source, result.data),
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
  }

  if (entity === "rule") {
    const result = ruleDocument[source].safeParse(candidate);
    if (!result.success) return { ok: false, issues: toIssues(result.error) };
    const issues = [
      ...documentIntegrityIssues({
        entity: "rule",
        status: String(status),
        content: result.data.content,
        provenance: result.data.provenance,
      }),
      ...storedOnlyIssues(source, result.data),
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
  }

  if (entity === "milestone") {
    const result = milestoneDocument[source].safeParse(candidate);
    if (!result.success) return { ok: false, issues: toIssues(result.error) };
    const issues = [
      ...documentIntegrityIssues({
        entity: "milestone",
        status: String(status),
        content: result.data.content,
        provenance: result.data.provenance,
      }),
      ...milestoneReadinessIssues(String(status), result.data.content),
      ...storedOnlyIssues(source, result.data),
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
  }

  if (entity === "task") {
    const result = taskDocument[source].safeParse(candidate);
    if (!result.success) return { ok: false, issues: toIssues(result.error) };
    const issues = [
      ...documentIntegrityIssues({
        entity: "task",
        status: String(status),
        content: result.data.content,
        provenance: result.data.provenance,
      }),
      ...taskReadinessIssues(String(status), result.data.content),
      ...taskTraceIssues(String(status), result.data.execution),
      ...storedOnlyIssues(source, result.data),
    ];
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
  const issues = [
    ...documentIntegrityIssues({
      entity: "stream",
      status: String(status),
      streamType,
      content: result.data.content,
      provenance: result.data.provenance,
    }),
    ...streamReadinessIssues(streamType, String(status), result.data.content),
    ...storedOnlyIssues(source, result.data),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document: result.data };
};
