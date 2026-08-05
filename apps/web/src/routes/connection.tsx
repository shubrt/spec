import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Toolbar } from "~/components/zpecs/toolbar";
import { getMcpEndpoint } from "~/server/connection";

/**
 * The connection page: the line to paste into a Claude Code client, plus what
 * this app can honestly say about the state of the connection.
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

  // A 403 still proves the API answered: it is the fail-closed "signed in, no
  // organization" reply, not a transport failure. Treating it as unreachable
  // would point the reader at the wrong problem.
  const reachable = board.status === "ok" || board.status === "no_workspace";
  const workspace = board.status === "ok" ? board.workspace : null;
  const unreachableReason = board.status === "ok" ? null : board.message;

  return (
    <>
      <Toolbar title="Connection" />

      <div className="flex max-w-3xl flex-col gap-6 px-8 pb-16 pt-6">
        <section>
          <h2 className="mb-1 text-sm font-semibold">Add zpecs to Claude Code</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Run this once. The client then discovers the authorization server and signs you in
            through your browser.
          </p>
          <CommandLine command={endpoint.command} />
          {endpoint.isLocal ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This is a loopback address, so it is only reachable from this machine. A deployed
              instance serves its own origin here.
            </p>
          ) : null}
        </section>

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
              ok={workspace !== null}
              name="Workspace on this session"
              detail={
                workspace
                  ? `${workspace.name} — the agent's writes land here.`
                  : "This session carries no organization. Create or join one from the switcher in the header; until then every tool call returns a remediation message rather than data."
              }
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
            is the whole surface. The workspace is taken from the <code>org_id</code> claim in your
            OAuth token rather than the path, so the same line works for every workspace you belong
            to — switch organization here and the agent follows.
          </p>
        </section>
      </div>
    </>
  );
}

function CommandLine({ command }: { command: string }) {
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
      <Button variant="outline" size="sm" onClick={copy} className="flex-none">
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
