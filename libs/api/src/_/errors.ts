/**
 * Base for domain errors that must cross a boundary as a machine-readable
 * `code` rather than a parsed `.message`. zpecs renders the same error three
 * different ways — a JSON-RPC error, an MCP tool `isError` result, and a
 * REST JSON body — and all three need to agree on *which* error it was
 * without string-matching prose. Repository and service code throws
 * subclasses that fix a `code` in their constructor.
 *
 * `name` is derived from the concrete subclass automatically (`new.target` /
 * `this.constructor`), so logs and stack traces name it correctly without
 * every subclass repeating `this.name = "..."`.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
