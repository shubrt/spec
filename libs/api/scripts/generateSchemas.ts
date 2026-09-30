/// <reference types="node" />

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  DOCUMENT_SCHEMA_TARGETS,
  type DocumentSchemaTarget,
  type DocumentSource,
} from "../src/domain/schema/document";
import { documentJsonSchema } from "../src/domain/schema/jsonSchema";

const SCHEMA_ROOT = fileURLToPath(new URL("../schema/", import.meta.url));
const SOURCES = ["agent", "store"] as const satisfies readonly DocumentSource[];

type SchemaArtifact = {
  readonly target: DocumentSchemaTarget;
  readonly source: DocumentSource;
  readonly name: string;
};

const artifacts: readonly SchemaArtifact[] = DOCUMENT_SCHEMA_TARGETS.flatMap((target) =>
  SOURCES.map((source) => ({ target, source, name: `${target}.${source}.json` })),
);
const expectedNames = new Set(artifacts.map(({ name }) => name));

const orphanedSchemaFiles = (): readonly string[] => {
  if (!existsSync(SCHEMA_ROOT)) return [];
  return readdirSync(SCHEMA_ROOT)
    .filter((name) => name.endsWith(".json") && !expectedNames.has(name))
    .sort();
};

const writeSchemas = (): void => {
  mkdirSync(SCHEMA_ROOT, { recursive: true });
  for (const { target, source, name } of artifacts) {
    const schema = documentJsonSchema(target, source);
    writeFileSync(join(SCHEMA_ROOT, name), `${JSON.stringify(schema, null, 2)}\n`);
  }

  const orphans = orphanedSchemaFiles();
  if (orphans.length > 0) {
    console.warn(
      `Generated ${artifacts.length} schemas. Review these unrecognized JSON files manually:\n${orphans.map((name) => `- ${name}`).join("\n")}`,
    );
    return;
  }

  console.log(`Generated ${artifacts.length} schemas in ${SCHEMA_ROOT}.`);
};

const checkSchemas = (): void => {
  const errors: string[] = [];

  for (const { target, source, name } of artifacts) {
    const path = join(SCHEMA_ROOT, name);
    if (!existsSync(path)) {
      errors.push(`${name}: missing`);
      continue;
    }

    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}: invalid JSON (${message})`);
      continue;
    }

    const generated = documentJsonSchema(target, source);
    if (!isDeepStrictEqual(committed, generated)) {
      errors.push(`${name}: stale; run \`vp run -F @spec/api schema:generate\``);
    }
  }

  for (const name of orphanedSchemaFiles()) {
    errors.push(`${name}: unrecognized JSON file; review and remove it manually if obsolete`);
  }

  if (errors.length > 0) {
    console.error(
      `Schema contract check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Schema contract check passed for ${artifacts.length} files.`);
};

const [mode, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length > 0 || (mode !== "--write" && mode !== "--check")) {
  console.error("Usage: bun scripts/generateSchemas.ts (--write | --check)");
  process.exitCode = 2;
} else if (mode === "--write") {
  writeSchemas();
} else {
  checkSchemas();
}
