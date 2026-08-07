import type { ApiFailure } from "./apiFailure";

type Check = { readonly ok: boolean; readonly detail: string };

export type McpClientId = "claude-code" | "codex";

export type McpClientSetup = {
  readonly id: McpClientId;
  readonly title: string;
  readonly description: string;
  readonly commands: readonly string[];
  readonly logoutCommand: string;
  readonly loginCommand?: string;
};

/** Ordered MCP-client instructions shown on the connection page. */
export function mcpClientSetups(endpointUrl: string) {
  return [
    {
      id: "claude-code",
      title: "Add zpecs to Claude Code",
      description:
        "Run this once. The client then discovers the authorization server and signs you in through your browser.",
      commands: [`claude mcp add --transport http zpecs ${endpointUrl}`],
      logoutCommand: "claude mcp logout zpecs",
    },
    {
      id: "codex",
      title: "Add zpecs to OpenAI Codex",
      description:
        "Run these commands in order. Codex adds the endpoint first, then starts browser-based sign-in.",
      commands: [`codex mcp add zpecs --url ${endpointUrl}`, "codex mcp login zpecs"],
      logoutCommand: "codex mcp logout zpecs",
      loginCommand: "codex mcp login zpecs",
    },
  ] as const satisfies readonly McpClientSetup[];
}

export type ConnectionWorkspaceChecks = {
  readonly organization: Check;
  readonly workspace: Check;
};

/**
 * Separates what Clerk knows from what the last zpecs API read confirmed.
 *
 * An API failure must not be rendered as proof that the session has no
 * organization: 404/500/invocation failures say nothing about `org_id`. Keeping
 * these as two checks makes that distinction explicit on the connection page.
 */
export function connectionWorkspaceChecks(input: {
  readonly orgId: string | null;
  readonly workspaceName: string | null;
  readonly failureStatus: ApiFailure["status"] | null;
  readonly failureMessage: string | null;
}): ConnectionWorkspaceChecks {
  const organizationSelected = input.orgId !== null;
  const workspaceConfirmed = input.workspaceName !== null;

  return {
    organization: {
      ok: organizationSelected,
      detail: organizationSelected
        ? "Clerk has an active organization in this web session. This does not reveal which organization an already-issued MCP token carries."
        : "No Clerk organization is active in this web session. Create or join one from the switcher in the header.",
    },
    workspace: {
      ok: workspaceConfirmed,
      detail: workspaceConfirmed
        ? `${input.workspaceName} — the zpecs API confirmed this local workspace for the current web session.`
        : input.failureStatus === "no_workspace"
          ? "The zpecs API confirmed that this session has no organization-scoped workspace. Create or join an organization, then reload."
          : organizationSelected
            ? `An organization is selected, but the last API read could not confirm its local zpecs workspace.${input.failureMessage ? ` ${input.failureMessage}` : ""}`
            : "No local zpecs workspace can be confirmed until a Clerk organization is active.",
    },
  };
}
