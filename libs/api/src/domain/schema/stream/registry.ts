import type { z } from "zod";
import type { StreamType } from "../../enums";
import { streamBaseContent } from "./base";
import { bugStreamContent } from "./bug";
import { featureStreamContent } from "./feature";
import { investigationStreamContent } from "./investigation";

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
 * ## Why the four unmapped types point at the base
 *
 * `change`, `experiment`, `refactor` and `maintenance` are legal stream types
 * (`domain/enums.ts` lists all seven) whose type-specific sections are not
 * modelled yet. They map to `streamBaseContent` explicitly rather than through a
 * `?? streamBaseContent` fallback, for two reasons:
 *
 * 1. `Record<StreamType, …>` makes the map **total**. Adding an eighth stream
 *    type to `domain/enums.ts` is a type error here until it is mapped, so a new
 *    type can never silently inherit a default.
 * 2. Adding those sections later is purely additive — new optional fields on top
 *    of the same base — so existing documents stay valid and `schema_version`
 *    does **not** bump. A fallback would hide which types are still provisional;
 *    the explicit entries document it.
 */
export const STREAM_CONTENT = {
  feature: featureStreamContent,
  bug: bugStreamContent,
  investigation: investigationStreamContent,

  // Base only for now — see the file header. Additive, no `schema_version` bump.
  change: streamBaseContent,
  experiment: streamBaseContent,
  refactor: streamBaseContent,
  maintenance: streamBaseContent,
} as const satisfies Record<StreamType, z.ZodType>;

/** The stream types that have their own sections beyond the invariant base. */
export const TYPED_STREAM_TYPES = [
  "feature",
  "bug",
  "investigation",
] as const satisfies readonly StreamType[];
export type TypedStreamType = (typeof TYPED_STREAM_TYPES)[number];

/** True when the type still uses the base schema unchanged. */
export const usesBaseStreamContentOnly = (streamType: StreamType): boolean =>
  STREAM_CONTENT[streamType] === streamBaseContent;
