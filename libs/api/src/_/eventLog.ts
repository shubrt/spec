import { createLogger, initLogger } from "evlog";
import { createAxiomDrain } from "evlog/axiom";
import { env } from "./env";

const axiomDrain =
  env.AXIOM_DATASET && env.AXIOM_TOKEN
    ? createAxiomDrain({
        dataset: env.AXIOM_DATASET,
        token: env.AXIOM_TOKEN,
      })
    : undefined;

initLogger({
  env: { service: "zpecs-api" },
  ...(axiomDrain ? { drain: axiomDrain } : {}),
});

if (!axiomDrain) {
  console.info(
    "[zpecs-api] AXIOM_DATASET / AXIOM_TOKEN not set — wide events will be written to console only.",
  );
}

export const createEventLogger = (context: Record<string, unknown>) => createLogger(context);
