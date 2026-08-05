import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DomainError } from "../../_/errors";
import { type WorkspaceAuthContext, hasWorkspace, readAuthContext } from "../auth/authContext";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { type ToolName, TOOL_DESCRIPTIONS } from "./descriptions";
import { NO_WORKSPACE_REMEDIATION, TOOL_ERROR_CODE, toolError } from "./results";

/**
 * What a tool body receives. Note what it cannot receive: an unauthenticated
 * caller, a caller with no workspace, or unparsed input. Those are handled before
 * `run` is reached, in one place, for every tool.
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
   * `readOnlyHint` or `destructiveHint`. Purely the client-facing approval hint —
   * it arms nothing here. See the `confirm` note on `defineTool`.
   */
  annotations: ToolAnnotations;
  /** `z.strictObject`, always — a plain `z.object()` loses `additionalProperties: false`. */
  input: TInput;
  /** Only for tools whose result the plan specifies as `structuredContent`. */
  output?: z.ZodObject;
  run: (context: ToolContext<z.output<TInput>>) => CallToolResult | Promise<CallToolResult>;
};

/**
 * The only way a tool reaches the MCP server.
 *
 * Every check that must not be skippable lives here: input parsing (via the
 * schema handed to `registerTool`) and the `no_workspace` interception. No tool
 * file calls `registerTool`, so there is no path that bypasses them — and a tool
 * author who somehow got past all of it still reaches no data, because every
 * repository method requires a `WorkspaceScope` and the only place one exists is
 * `context.scope`.
 *
 * ## Why there is no `confirm` gate here
 *
 * There used to be one, armed by `destructiveHint`. It was removed deliberately.
 * `apply_change_set` is the only destructive tool and it is *always* destructive
 * as far as an annotation can tell, so a per-call gate demanded `confirm: true`
 * even for a change set that only creates — which teaches an agent to send the
 * flag reflexively and destroys the signal the gate exists to carry. Consent is
 * now gated **per destructive operation** inside `service/changeSet.ts`, where
 * the server knows which operations actually destroy something.
 *
 * `destructiveHint` stays on `apply_change_set`: it is the correct MCP
 * client-approval annotation, and it is now only that. A tool that needs a gate
 * enforces it where it knows what is at stake.
 */
export function defineTool<TInput extends z.ZodObject>(spec: ToolSpec<TInput>): ZpecsTool {
  const description = TOOL_DESCRIPTIONS[spec.name];

  return {
    name: spec.name,

    register(server: McpServer): void {
      // Registered through two branches rather than one call with a spread
      // `outputSchema`, so that a tool declaring an output schema is registered
      // through the overload that knows it has one — the SDK refuses a result
      // with a declared output schema and no `structuredContent` at runtime, and
      // a spread would hide which case applies.
      //
      // The one cast below is unavoidable rather than convenient, and it has to go
      // through `unknown`. `ToolCallback<Args>` is a conditional type over `Args`;
      // inside this generic function `TInput` is still a type parameter, so the
      // conditional cannot reduce, and TypeScript reports no overlap in either
      // direction against an unreduced conditional — a direct assertion is
      // rejected too (TS2352). What makes it safe is the same thing in both
      // branches of that conditional: the callback accepts a wider `input` than
      // `z.output<TInput>` and returns exactly `CallToolResult`. `spec.run` is
      // typed against `z.output<TInput>`, so the narrowing the cast hides is
      // re-established one line later at the only place it is read.
      const callback = (
        input: Record<string, unknown>,
        extra: { authInfo?: AuthInfo | undefined },
      ): CallToolResult | Promise<CallToolResult> => {
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

        return spec.run({
          input: input as z.output<TInput>,
          auth,
          scope: auth.scope,
        });
      };

      const shared = {
        title: spec.title,
        description,
        inputSchema: spec.input,
        annotations: spec.annotations,
      };

      const cb = callback as unknown as ToolCallback<TInput>;

      if (spec.output) {
        server.registerTool(spec.name, { ...shared, outputSchema: spec.output }, cb);
        return;
      }
      server.registerTool(spec.name, shared, cb);
    },
  };
}
