/// <reference types="node" />
/// <reference types="bun-types" />
import { parseArgs } from "node:util";
import { z } from "zod";
import { makeScope } from "../src/domain/auth/workspaceScope";
import { projectNameSchema } from "../src/domain/projectName";
import { workspaceRepository } from "../src/domain/repository/workspace";

const CLERK_ORG_ID = /^org_[A-Za-z0-9]+$/;

export const bootstrapProjectInputSchema = z
  .object({
    clerkOrgId: z
      .string({ error: "--clerk-org-id is required" })
      .trim()
      .min(1, "--clerk-org-id must not be empty")
      .regex(CLERK_ORG_ID, "--clerk-org-id must be a Clerk organization id such as org_2abc"),
    name: projectNameSchema,
  })
  .strict();

export type BootstrapProjectInput = z.infer<typeof bootstrapProjectInputSchema>;

export type BootstrapProjectOutput = {
  status: "created" | "existing";
  workspaceId: string;
  projectId: string;
  name: string;
};

/** Parses only the two documented flags; unknown flags and positionals fail. */
export function parseBootstrapProjectArgs(args: string[]): BootstrapProjectInput {
  const { values } = parseArgs({
    args,
    options: {
      "clerk-org-id": { type: "string" },
      name: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return bootstrapProjectInputSchema.parse({
    clerkOrgId: values["clerk-org-id"],
    name: values.name,
  });
}

/**
 * Provisions the first project only after Clerk authentication has JIT-created
 * the workspace. A Project is an unversioned container, so this direct scoped
 * repository operation does not bypass the epic/stream/task change-set path.
 */
export async function bootstrapProject(
  input: BootstrapProjectInput,
): Promise<BootstrapProjectOutput> {
  const validated = bootstrapProjectInputSchema.parse(input);
  const workspace = await workspaceRepository.findByClerkOrgId(validated.clerkOrgId);
  if (!workspace) {
    throw new Error(
      `No local workspace exists for Clerk organization ${JSON.stringify(validated.clerkOrgId)}. Send an authenticated request for that organization first so spec can JIT-provision it.`,
    );
  }

  const scope = makeScope(workspace.id);
  const result = await workspaceRepository.ensureProject(scope, validated.name);
  return {
    status: result.status,
    workspaceId: workspace.id,
    projectId: result.project.id,
    name: result.project.name,
  };
}

type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }
  return error instanceof Error ? error.message : "Project bootstrap failed for an unknown reason.";
}

export async function runBootstrapProjectCli(
  args: string[],
  io: CliIo = defaultIo,
): Promise<number> {
  try {
    const output = await bootstrapProject(parseBootstrapProjectArgs(args));
    io.stdout(JSON.stringify(output));
    return 0;
  } catch (error) {
    io.stderr(errorMessage(error));
    io.stderr("Usage: vp run project:bootstrap -- --clerk-org-id org_... --name <project-name>");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runBootstrapProjectCli(process.argv.slice(2));
}
