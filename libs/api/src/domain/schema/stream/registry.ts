import type { z } from "zod";
import type { StreamType } from "../../enums";
import { bugStreamContent } from "./bug";
import { changeStreamContent } from "./change";
import { experimentStreamContent } from "./experiment";
import { featureStreamContent } from "./feature";
import { investigationStreamContent } from "./investigation";
import { maintenanceStreamContent } from "./maintenance";
import { refactorStreamContent } from "./refactor";

/**
 * Which content schema applies to which stream type.
 *
 * ## Why a map and not a discriminated union
 *
 * Both obvious alternatives were measured on Zod 4.4.3 and both fail:
 *
 * - `z.discriminatedUnion("meta.stream_type", […])` **throws at construction** —
 *   `Invalid discriminated union option at index "0"`. Zod's discriminator key is
 *   a single property name, not a path, and the stream type lives one level down
 *   in `meta`.
 * - A plain `z.union([...])` parses, but a wrong field inside a feature stream
 *   comes back as one top-level `invalid_union` issue whose payload is the
 *   concatenated failure of *every* branch. An agent receiving that has no way to
 *   tell "you wrote a bug field in a feature stream" from "your feature stream
 *   has a typo".
 *
 * The size argument is the other half. Measured on these schemas: one feature
 * content schema is 5.3 KB, while `z.union` over all seven types generates a
 * 26.9 KB `anyOf` — and a tool input schema is re-sent on every turn of every
 * session.
 *
 * So the discriminator is read *before* parsing and the schema is selected here.
 * The cost is one lookup; the benefit is a precise error path and a per-type
 * schema a fifth of the size.
 *
 * The map is total over `StreamType`. Adding an eighth type is therefore a type
 * error until it receives an explicit schema instead of silently inheriting base
 * content.
 */
export const STREAM_CONTENT = {
  feature: featureStreamContent,
  bug: bugStreamContent,
  investigation: investigationStreamContent,
  change: changeStreamContent,
  experiment: experimentStreamContent,
  refactor: refactorStreamContent,
  maintenance: maintenanceStreamContent,
} as const satisfies Record<StreamType, z.ZodType>;

/**
 * The JSON-Schema target exposed for each stream type.
 *
 * This lives next to `STREAM_CONTENT` so parsing, `get_entity_schema` and the
 * schema resources cannot grow independent ideas of which stream variants are
 * fully modelled. Like the content registry, it is total over `StreamType`: a
 * newly added type must make an explicit schema decision here.
 */
export const STREAM_SCHEMA_TARGET = {
  feature: "stream.feature",
  bug: "stream.bug",
  investigation: "stream.investigation",
  change: "stream.change",
  experiment: "stream.experiment",
  refactor: "stream.refactor",
  maintenance: "stream.maintenance",
} as const satisfies Record<StreamType, string>;
