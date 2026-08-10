import type { StreamType, VersionedEntityType } from "../enums";
import type { DocumentSchemaTarget } from "./document";
import { STREAM_SCHEMA_TARGET } from "./stream/registry";

/** A valid public request for one writable document schema. */
export type DocumentSchemaSelection =
  | { readonly entity: Exclude<VersionedEntityType, "stream"> }
  | { readonly entity: "stream"; readonly streamType: StreamType };

/**
 * Resolve the public entity + stream-type address to the schema-layer target.
 *
 * Invalid pairs are unrepresentable here. Protocol-specific validation and
 * error wording stay at their respective boundaries; the target decision is a
 * pure, shared domain operation.
 */
export const resolveDocumentSchemaTarget = (
  selection: DocumentSchemaSelection,
): DocumentSchemaTarget =>
  selection.entity === "stream" ? STREAM_SCHEMA_TARGET[selection.streamType] : selection.entity;
