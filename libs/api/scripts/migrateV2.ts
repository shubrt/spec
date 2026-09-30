/// <reference types="node" />
/// <reference types="bun-types" />
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { applyV2Migration, V2_MIGRATION_TRANSACTION } from "./migrateV2/apply";
import { buildV2PreflightReport, canonicalJson } from "./migrateV2/preflight";
import { readDatabaseSnapshot } from "./migrateV2/readSnapshot";

export type MigrateV2Mode = "apply" | "preflight";

export type MigrateV2Arguments = {
  readonly mode: MigrateV2Mode;
  readonly confirmed: boolean;
};

const USAGE =
  "Usage: pnpm --filter @spec/api migrate:v2 -- [--preflight | --apply --confirm-apply]";

/** Strict parsing keeps a misspelled safety flag from degrading into an apply. */
export function parseMigrateV2Args(args: readonly string[]): MigrateV2Arguments {
  const { values } = parseArgs({
    args: [...args],
    options: {
      preflight: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "confirm-apply": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.preflight && values.apply) {
    throw new Error("--preflight and --apply are mutually exclusive.");
  }
  if (values["confirm-apply"] && !values.apply) {
    throw new Error("--confirm-apply is valid only together with --apply.");
  }
  if (values.apply && !values["confirm-apply"]) {
    throw new Error("--apply requires the explicit --confirm-apply safety flag.");
  }
  return { mode: values.apply ? "apply" : "preflight", confirmed: values["confirm-apply"] };
}

type CliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/**
 * The only database interaction in the command. PostgreSQL itself enforces
 * read-only access, and Repeatable Read makes every count/hash share one snapshot.
 */
async function generateReport() {
  const { env } = await import("../src/_/env");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const database = drizzle(pool);
  try {
    const snapshot = await database.transaction(async (tx) => await readDatabaseSnapshot(tx), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    return buildV2PreflightReport(snapshot);
  } finally {
    await pool.end();
  }
}

/** The mutating path owns one SERIALIZABLE transaction from locks through verification. */
async function applyMigration() {
  const { env } = await import("../src/_/env");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const database = drizzle(pool);
  try {
    return await database.transaction(
      async (tx) => await applyV2Migration(tx),
      V2_MIGRATION_TRANSACTION,
    );
  } finally {
    await pool.end();
  }
}

export async function runMigrateV2Cli(
  args: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let parsed: MigrateV2Arguments;
  try {
    parsed = parseMigrateV2Args(args);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Invalid migration arguments.");
    io.stderr(USAGE);
    return 1;
  }

  try {
    if (parsed.mode === "preflight") {
      const report = await generateReport();
      // Canonicalize before pretty-printing so object key and array order are fixed
      // by the report builder rather than by database return order.
      io.stdout(JSON.stringify(JSON.parse(canonicalJson(report)), null, 2));
      if (report.summary.conflicts > 0) {
        io.stderr(
          `Preflight found ${String(report.summary.conflicts)} hard conflict(s); no writes were performed.`,
        );
        return 2;
      }
      io.stderr("Preflight completed without hard conflicts; no writes were performed.");
      return 0;
    }

    const manifest = await applyMigration();
    io.stdout(JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2));
    io.stderr(
      `Apply committed ${String(manifest.applied.entity_baselines)} E/S/T baselines and ${String(manifest.applied.rules)} Rules; in-transaction verification passed.`,
    );
    return 0;
  } catch (error) {
    io.stderr(
      error instanceof Error ? error.message : "v2 migration failed for an unknown reason.",
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runMigrateV2Cli(process.argv.slice(2));
}
