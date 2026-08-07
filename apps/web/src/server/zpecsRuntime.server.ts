import { app as coreApp, configureRequestEventLogger } from "@zpecs/api";
import Elysia from "elysia";
import { type DrainFn, initLogger, type RedactConfig } from "evlog";
import { createAxiomDrain } from "evlog/axiom";
import { evlog, useLogger } from "evlog/elysia";
import { env } from "~/lib/env";

const REDACTION: RedactConfig = {
  // Defense in depth. Core call sites cannot add any of these fields, but a
  // future runtime enrichment must still be safe before console/Axiom drains.
  paths: [
    "authorization",
    "**.authorization",
    "cookie",
    "**.cookie",
    "token",
    "**.token",
    "accessToken",
    "**.accessToken",
    "body",
    "**.body",
    "requestBody",
    "**.requestBody",
    "responseBody",
    "**.responseBody",
    "changeSet",
    "**.changeSet",
  ],
  // UUIDs must remain intact so workspace correlation works. evlog's broader
  // credit-card/phone maskers can mistake long UUID digit runs for PII; the two
  // credential-shaped built-ins are the relevant defense for this allow-listed
  // event vocabulary.
  builtins: ["jwt", "bearer"],
};

export type RuntimeAppOptions = {
  /** Optional drain override for offline verification and alternate hosts. */
  drain?: DrainFn;
  /** Suppress evlog's console channel while retaining the supplied drain. */
  silent?: boolean;
  /** Suppress only the local console-fallback notice. */
  announceConsoleFallback?: boolean;
};

/** Builds the instrumented runtime shell around the shared Elysia app. */
export function createRuntimeApp(options: RuntimeAppOptions = {}) {
  const axiomDrain =
    env.AXIOM_DATASET && env.AXIOM_TOKEN
      ? createAxiomDrain({ dataset: env.AXIOM_DATASET, apiKey: env.AXIOM_TOKEN })
      : undefined;
  const drain = options.drain ?? axiomDrain;

  initLogger({
    enabled: true,
    env: { service: "zpecs-api" },
    pretty: false,
    stringify: true,
    silent: options.silent ?? false,
    redact: REDACTION,
    ...(drain ? { drain } : {}),
  });

  if (!drain && options.announceConsoleFallback !== false) {
    console.info(
      "[zpecs-api] AXIOM_DATASET / AXIOM_TOKEN not set — structured request events use the console.",
    );
  }

  // `useLogger` comes from this host's evlog installation, so its
  // AsyncLocalStorage is exactly the instance mounted below. Direct Treaty
  // calls run through `runtimeApp.handle` and receive that request context;
  // only core calls made outside the runtime fall back to a no-op.
  configureRequestEventLogger(() => {
    try {
      return useLogger();
    } catch {
      return undefined;
    }
  });

  return new Elysia().use(evlog({ redact: REDACTION })).use(coreApp);
}

// One runtime instance is shared by the public MCP adapter and all direct
// Treaty calls. Creating it per request would repeatedly initialize logging.
export const runtimeApp = createRuntimeApp();
