import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DomainError } from "../../_/errors";
import { type WorkspaceAuthContext, hasWorkspace, readAuthContext } from "../auth/authContext";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { type ToolName, TOOL_DESCRIPTIONS } from "./descriptions";
import {
  CONFIRM_REMEDIATION,
  NO_WORKSPACE_REMEDIATION,
  TOOL_ERROR_CODE,
  toolError,
} from "./results";

/**
 * What a tool body receives. Note what it cannot receive: an unauthenticated
 * caller, a caller with no workspace, an unconfirmed destructive call, or
 * unparsed input. Those are handled before `run` is reached, in one place, for
 * every tool.
 */
export type ToolContext<TInput> = {
  /** Already parsed against the tool's Zod input schema by the SDK. */
  input: TInput;
  auth: WorkspaceAuthContext;
  /** `auth.scope`, lifted out because it is the first argument of every repository call. */
  scope: WorkspaceScope;
};

/**
 * A tool as the registry holds it: a name, and the ability to register itself
 * once on a server.
 *
 * Deliberately narrow. Title, description, annotations and both schemas are
 * reachable through `tools/list` on a real server, which is where the tests read
 * them from, so re-exposing them here would be a second copy of the wire
 * contract that could disagree with it.
 */
export type ZpecsTool = {
  readonly name: ToolName;
  register(server: McpServer): void;
};

type ToolSpec<TInput extends z.ZodObject> = {
  /**
   * Keyed to `TOOL_DESCRIPTIONS`, so a tool cannot exist without a description
   * and the description budget test covers every tool by construction. The
   * description is deliberately *not* a field here — text lives in one file.
   */
  name: ToolName;
  title: string;
  /**
   * `readOnlyHint` or `destructiveHint`. `destructiveHint: true` is what arms the
   * `confirm` gate below; there is no separate flag to forget.
   */
  annotations: ToolAnnotations;
  /** `z.strictObject`, always — a plain `z.object()` loses `additionalProperties: false`. */
  input: TInput;
  /** Only for tools whose result the plan specifies as `structuredContent`. */
  output?: z.ZodObject;
  run: (context: ToolContext<z.output<TInput>>) => CallToolResult | Promise<CallToolResult>;
};

/**
 * The `confirm` flag every destructive tool gets, added by the factory rather
 * than by the tool author.
 *
 * `.default(false)` and not `z.literal(true)`: a required literal would make the
 * JSON Schema itself demand `confirm: true`, so a model would supply it
 * mechanically on the first call and the user would never be asked. Optional in
 * the schema plus a refusal at call time is what forces a round trip through the
 * user.
 */
const CONFIRM_SHAPE = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Set to true only after the user has seen what will change and approved it. " +
        "A call without it is refused and nothing is written.",
    ),
};

/**
 * The only way a tool reaches the MCP server.
 *
 * Every check that must not be skippable lives here: input parsing (via the
 * schema handed to `registerTool`), the `no_workspace` interception, and the
 * `confirm` gate on destructive tools. No tool file calls `registerTool`, so
 * there is no path that bypasses them — and a tool author who somehow got past
 * all of it still reaches no data, because every repository method requires a
 * `WorkspaceScope` and the only place one exists is `context.scope`.
 *
 * Order matters: no workspace is checked before `confirm`, so a caller with no
 * workspace is told the one thing that would actually help instead of being sent
 * to ask the user for approval that cannot be acted on.
 */
export function defineTool<TInput extends z.ZodObject>(spec: ToolSpec<TInput>): ZpecsTool {
  const description = TOOL_DESCRIPTIONS[spec.name];
  const destructive = spec.annotations.destructiveHint === true;
  const inputSchema = destructive ? spec.input.extend(CONFIRM_SHAPE) : spec.input;

  return {
    name: spec.name,

    register(server: McpServer): void {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description,
          inputSchema,
          ...(spec.output ? { outputSchema: spec.output } : {}),
          annotations: spec.annotations,
        },
        (input, extra) => {
          const auth = readAuthContext(extra.authInfo);
          if (!auth) {
            // Unreachable through `POST /mcp`, which always passes an authInfo.
            // A throw rather than an `isError` result on purpose: this is a
            // wiring defect, not a state a user can be in, and it must be loud
            // instead of looking like one of the three documented error surfaces.
            throw new DomainError(
              "missing_auth_context",
              `Tool ${spec.name} was invoked without an AuthContext — the transport was built without authInfo.`,
            );
          }

          if (!hasWorkspace(auth)) {
            return toolError(TOOL_ERROR_CODE.noWorkspace, NO_WORKSPACE_REMEDIATION);
          }

          if (destructive && (input as { confirm?: boolean }).confirm !== true) {
            return toolError(TOOL_ERROR_CODE.destructiveRequiresConfirm, CONFIRM_REMEDIATION);
          }

          return spec.run({
            input: input as z.output<TInput>,
            auth,
            scope: auth.scope,
          });
        },
      );
    },
  };
}
