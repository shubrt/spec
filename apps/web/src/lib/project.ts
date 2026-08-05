/**
 * Project-name validation used before the create request leaves the browser.
 *
 * The API remains authoritative and applies the same trim + 1..120 rule. Keeping
 * this tiny mirror client-safe means the dialog can explain a mistake without a
 * round trip or importing the API's server package into the browser bundle.
 */

export const PROJECT_NAME_MAX_LENGTH = 120;

export type ProjectNameValidation =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

/**
 * Reduces an untrusted server-function payload to its one relevant value.
 * The caller-facing server-function type remains `{ name: string }`; this guard
 * is for requests that bypass that TypeScript boundary.
 */
export function projectNameInput(value: unknown): { readonly name: unknown } {
  if (typeof value !== "object" || value === null || !("name" in value)) {
    return { name: undefined };
  }
  return { name: value.name };
}

export function validateProjectName(value: unknown): ProjectNameValidation {
  if (typeof value !== "string") {
    return { ok: false, message: "Enter a project name." };
  }

  const name = value.trim();

  if (name.length === 0) {
    return { ok: false, message: "Enter a project name." };
  }

  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `Project names must be ${String(PROJECT_NAME_MAX_LENGTH)} characters or fewer.`,
    };
  }

  return { ok: true, name };
}
