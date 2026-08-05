import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Toolbar } from "~/components/zpecs/toolbar";
import { connectionWorkspaceChecks, mcpClientSetups, type McpClientId } from "~/lib/connection";
import { getMcpEndpoint } from "~/server/connection";

/**
 * The connection page: the commands for supported MCP clients, plus what this
 * app can honestly say about the state of the connection.
 *
 * The honesty is the design constraint. The server has no session-level view of
 * MCP clients: `POST /mcp` is stateless, a fresh transport per request with no
 * `sessionIdGenerator`, so there is no such thing as a connected client to
 * report on. This page therefore reports the two things it really can observe —
 * whether the API answered, and whether this session has a workspace — and says
 * plainly that it cannot observe the third. An indicator reading "connected"
 * would be decoration over a fact nobody measured.
 */
export const Route = createFileRoute("/connection")({
  loader: () => getMcpEndpoint(),
  component: ConnectionPage,
});

function ConnectionPage() {
  const board = useLoaderData({ from: "__root__" });
  const endpoint = Route.useLoaderData();
  const { orgId } = Route.useRouteContext();
  const clientSetups = mcpClientSetups(endpoint.url);
  const [claudeSetup, codexSetup] = clientSetups;

  // Any HTTP response proves the API answered — including 401, 403 and 5xx.
  // Only an absent session that prevented a request, or an actual network
  // failure, makes this false.
  const reachable = board.status === "ok" || board.apiReachable;
  const workspace = board.status === "ok" ? board.workspace : null;
  const unreachableReason = board.status === "ok" ? null : board.message;
  const workspaceChecks = connectionWorkspaceChecks({
    orgId,
    workspaceName: workspace?.name ?? null,
    failureStatus: board.status === "ok" ? null : board.status,
    failureMessage: unreachableReason,
  });

  return (
    <>
      <Toolbar title="Connection" />

      <div className="flex max-w-3xl flex-col gap-6 px-8 pb-16 pt-6">
        {clientSetups.map((setup) => (
          <section key={setup.id}>
            <h2 className="mb-1 text-sm font-semibold">{setup.title}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{setup.description}</p>
            {setup.commands.length === 1 ? (
              <CommandLine
                command={setup.commands[0]}
                copyLabel={commandCopyLabel(setup.id, 0, setup.commands.length)}
              />
            ) : (
              <ol className="flex list-decimal flex-col gap-2 pl-5">
                {setup.commands.map((command, index) => (
                  <li key={command} className="pl-1">
                    <CommandLine
                      command={command}
                      copyLabel={commandCopyLabel(setup.id, index, setup.commands.length)}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}

        {endpoint.isLocal ? (
          <p className="-mt-4 text-xs text-muted-foreground">
            This is a loopback address, so it is only reachable from this machine. A deployed
            instance serves its own origin here.
          </p>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold">What this page can see</h2>
          <Card className="p-4">
            <Check
              ok={reachable}
              name="zpecs API reachable"
              detail={
                reachable
                  ? "The API answered this app's last read."
                  : (unreachableReason ?? "The API did not answer.")
              }
            />
            <Check
              ok={workspaceChecks.organization.ok}
              name="Clerk organization in this web session"
              detail={workspaceChecks.organization.detail}
            />
            <Check
              ok={workspaceChecks.workspace.ok}
              name="Local zpecs workspace confirmed"
              detail={workspaceChecks.workspace.detail}
            />
          </Card>
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold">What it cannot</h2>
          {/* Load-bearing, not a disclaimer. Someone will eventually want a green
              "connected" light here, and this is the reason there is none. */}
          <p className="text-sm text-muted-foreground">
            Whether an MCP client is currently connected. The MCP endpoint is stateless — a fresh
            server and transport per request, with all state in Postgres — so no connection exists
            to observe. The two checks above are what is actually measurable from here.
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold">One endpoint, no workspace in the URL</h2>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs">
              {endpoint.url}
            </code>{" "}
            is the whole surface. The organization you choose during OAuth consent is written into
            the issued MCP token as <code>org_id</code>. Switching organization in the web header
            changes this web session, but it cannot change a token an MCP client already holds.
          </p>
          <div className="mt-3 space-y-3">
            <div>
              <h3 className="text-xs font-medium">Claude Code</h3>
              <p className="text-sm text-muted-foreground">
                Open <code>/mcp</code>, choose <strong>Clear authentication</strong> for zpecs,
                reconnect, and choose the other organization during consent. The equivalent CLI
                command is <code>{claudeSetup.logoutCommand}</code>.
              </p>
            </div>
            <div>
              <h3 className="text-xs font-medium">OpenAI Codex</h3>
              <p className="text-sm text-muted-foreground">
                Run <code>{codexSetup.logoutCommand}</code>, followed by{" "}
                <code>{codexSetup.loginCommand}</code>, then choose the other organization during
                consent.
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            The endpoint and add commands stay the same.
          </p>
        </section>
      </div>
    </>
  );
}

function commandCopyLabel(clientId: McpClientId, commandIndex: number, commandCount: number) {
  const clientName = clientId === "claude-code" ? "Claude Code" : "OpenAI Codex";
  const step = commandCount === 1 ? "" : ` ${commandIndex + 1}`;
  return `Copy ${clientName} setup command${step}`;
}

function CommandLine({ command, copyLabel }: { command: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      // Clipboard access can be refused by permissions policy. Failing quietly
      // and leaving the text selectable is better than an alert.
      () => setCopied(false),
    );
  };

  return (
    <div className="flex items-center gap-2 rounded-xl border bg-secondary/40 p-3">
      <code className="flex-1 overflow-x-auto whitespace-pre font-mono text-xs">{command}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={copy}
        className="flex-none"
        aria-label={copyLabel}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Check({ ok, name, detail }: { ok: boolean; name: string; detail: string }) {
  return (
    <div className="flex gap-3 border-t py-3 first:border-t-0">
      {/* The neutral tone, not a red one, when the answer is no: neither check
          failing is a fault — "no workspace yet" is an ordinary state with a
          one-click remedy. */}
      <span className="tone-dot mt-1.5" data-tone={ok ? "done" : "none"} />
      <div>
        <div className="text-[13px] font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}
