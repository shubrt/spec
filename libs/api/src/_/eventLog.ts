/**
 * The deliberately tiny bridge from core code to request observability.
 *
 * The core package must stay importable by consumers and offline tooling without
 * initializing evlog, opening an Axiom drain, or writing a console notice. The
 * executable runtime installs an accessor once, while the functions below only
 * ever add an allow-listed set of scalar metadata to the active request event.
 *
 * In particular, this module has no API for headers, cookies, tokens, request or
 * response bodies, or change-set documents. Observability failures are ignored:
 * logging is diagnostic and must never change any REST or MCP response shape.
 */

export type RequestEventLogger = {
  set(fields: Record<string, unknown>): void;
};

export type RequestEventLoggerAccessor = () => RequestEventLogger | undefined;

let requestEventLogger: RequestEventLoggerAccessor | undefined;

/** Installed by the TanStack server host when it creates the instrumented runtime. */
export function configureRequestEventLogger(
  accessor: RequestEventLoggerAccessor | undefined,
): void {
  requestEventLogger = accessor;
}

function enrich(fields: Record<string, unknown>): void {
  try {
    requestEventLogger?.()?.set(fields);
  } catch {
    // A missing/sealed logger or a drain failure must not cross a wire boundary.
  }
}

type AuthEvent = {
  status:
    | "authenticated"
    | "invalid_token"
    | "insufficient_scope"
    | "not_configured"
    | "signed_out";
  principal: "mcp" | "session";
  clerkUserId?: string;
  workspaceId?: string | null;
};

/** Adds authentication metadata only; credentials and failure reasons stay out. */
export function recordAuthEvent(event: AuthEvent): void {
  enrich({
    authStatus: event.status,
    principal: event.principal,
    ...(event.clerkUserId ? { actor: event.clerkUserId, clerkUserId: event.clerkUserId } : {}),
    ...(event.workspaceId !== undefined ? { workspaceId: event.workspaceId } : {}),
  });
}

/** Adds the MCP operation name and its coarse outcome, never its input/output. */
export function recordToolEvent(tool: string, outcome?: "ok" | "error"): void {
  enrich({
    mcpTool: tool,
    ...(outcome ? { toolOutcome: outcome } : {}),
  });
}

type ReadPerformanceEvent = {
  operation:
    | "project.aggregate"
    | "project.entity_detail"
    | "project.fragments"
    | "project.revisions"
    | "project.search";
  outcome: "ok" | "not_found" | "error";
  elapsedMs: number;
  resultCount?: number;
  totalCount?: number;
  corpusCount?: number;
};

/** Adds bounded read metrics only; request selectors and returned content stay out. */
export function recordReadPerformanceEvent(event: ReadPerformanceEvent): void {
  enrich({
    readOperation: event.operation,
    readOutcome: event.outcome,
    readElapsedMs: Math.round(Math.max(0, event.elapsedMs) * 100) / 100,
    ...(event.resultCount === undefined ? {} : { readResultCount: event.resultCount }),
    ...(event.totalCount === undefined ? {} : { readTotalCount: event.totalCount }),
    ...(event.corpusCount === undefined ? {} : { readCorpusCount: event.corpusCount }),
  });
}
