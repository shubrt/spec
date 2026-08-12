import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { AbsentBox, Box } from "~/components/zpecs/box";
import {
  CommandLine,
  ContextBlock,
  DefRow,
  DocSection,
  NotOffered,
  PageHead,
} from "~/components/zpecs/parts";
import { useMcpEndpoint } from "~/lib/boardState";
import { connectionWorkspaceChecks, mcpClientSetups } from "~/lib/connection";
import { carry } from "~/lib/search";

/**
 * Connection — how an MCP client reaches this deployment, and what this app can
 * honestly say about the state of that connection.
 *
 * The honesty is the design constraint. `POST /mcp` is stateless — a fresh
 * transport per request with no session id — so there is no such thing as a
 * connected client to report on. This page therefore reports the two things it
 * really can observe (whether the embedded API completed a read, and whether this
 * session resolves to a workspace) and says plainly that it cannot observe the
 * third. An indicator reading "connected" would be decoration over a fact nobody
 * measured.
 *
 * It is also the write path. Everything in this product is created through the MCP
 * server; this surface only reads, which is why the page a reader lands on when a
 * Project is empty points here.
 */
export const Route = createFileRoute("/connection")({ component: ConnectionPage });

function ConnectionPage() {
  const { board } = useLoaderData({ from: "__root__" });
  const { orgId } = Route.useRouteContext();
  const endpoint = useMcpEndpoint();
  const setups = mcpClientSetups(endpoint.url);

  const workspace = board.status === "ok" ? board.workspace : null;
  const checks = connectionWorkspaceChecks({
    orgId,
    workspaceName: workspace?.name ?? null,
    failureStatus: board.status === "ok" ? null : board.status,
    failureMessage: board.status === "ok" ? null : board.message,
  });
  // Any Elysia response proves the embedded API ran — including 401, 403 and 5xx.
  // An absent session or an unexpected invocation failure makes this false.
  const apiAnswered = board.status === "ok" || board.apiReachable;

  return (
    <div>
      <PageHead
        title="Connection"
        hint="One streamable HTTP MCP server for the whole deployment. The workspace comes from the org_id claim in your token rather than from the URL, so there is no per-workspace endpoint to construct."
      />

      <div className="flex flex-wrap gap-8 pt-1">
        <div className="w-[664px] shrink-0">
          <DocSection label="Endpoint">
            <CommandLine command={endpoint.url} />
            {endpoint.isLocal ? (
              <p className="text-muted-foreground mt-2 text-xs leading-[17px]">
                This is a loopback address. It works on this machine and nowhere else — pasted into
                a colleague's client it fails in a way that looks like a bug in zpecs.
              </p>
            ) : null}
          </DocSection>

          {setups.map((setup) => (
            <DocSection
              key={setup.id}
              label={setup.title}
              hint="Defined in this app and verified against this endpoint. A client without an entry here gets the endpoint and nothing more, rather than a command nobody has run."
            >
              <div className="flex items-center gap-2 pt-1.5">
                <Box tone="success" marker="●">
                  Ready to connect
                </Box>
              </div>
              <p className="text-muted-foreground mt-1.5 text-xs leading-[17px]">
                {setup.description}
              </p>
              {setup.commands.map((command, index) => (
                <div key={command} className="mt-1.5 flex items-start gap-2">
                  {setup.commands.length > 1 ? (
                    <span className="text-muted-foreground w-4 shrink-0 pt-3 font-mono text-[11px]">
                      {index + 1}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <CommandLine command={command} />
                  </span>
                </div>
              ))}
              <div className="mt-2">
                <span className="text-muted-foreground text-[11px]">Sign out again</span>
                <CommandLine command={setup.logoutCommand} />
              </div>
            </DocSection>
          ))}

          <DocSection
            label="Any other MCP client"
            hint="The transport is standard, but no command line here has been verified for your client, so none is printed."
          >
            <div className="flex items-center gap-2 pt-1.5">
              <Box tone="dashed">Endpoint only</Box>
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs leading-[17px]">
              A streamable HTTP MCP server with browser-based authorization. A client that speaks
              that transport can be pointed at the endpoint above; the command differs per client.
            </p>
          </DocSection>
        </div>

        <div className="w-[304px] shrink-0">
          <ContextBlock
            label="What can be observed"
            hint="Two of these are measured on this request. The third is not observable at all, and saying so is more useful than a green dot that means nothing."
          >
            <DefRow label="API">
              {apiAnswered ? (
                <Box tone="success" marker="●">
                  answered this request
                </Box>
              ) : (
                <Box tone="danger" marker="⊘">
                  did not answer
                </Box>
              )}
            </DefRow>
            <DefRow label="Organization" hint={checks.organization.detail}>
              {checks.organization.ok ? (
                <Box tone="success" marker="●">
                  active in Clerk
                </Box>
              ) : (
                <Box tone="danger" marker="⊘">
                  none active
                </Box>
              )}
            </DefRow>
            <DefRow label="Workspace" hint={checks.workspace.detail}>
              {checks.workspace.ok ? (
                <Box tone="success" marker="●">
                  confirmed by the API
                </Box>
              ) : (
                <Box tone="danger" marker="⊘">
                  not confirmed
                </Box>
              )}
            </DefRow>
            <DefRow
              label="MCP clients"
              hint="POST /mcp is stateless — a fresh transport per request with no session id — so the server has no view of connected clients."
            >
              <AbsentBox label="not observable" />
            </DefRow>
          </ContextBlock>

          <ContextBlock label="Write path" hint="This entire web surface is read-only by design.">
            <p className="text-muted-foreground text-xs leading-[17px]">
              Epics, Streams, Tasks, Rules and Milestones are created and changed through the MCP
              server, which owns document validation, readiness gates and the revision history. No
              revision has ever originated in a browser.
            </p>
            <p className="text-muted-foreground mt-2 text-xs leading-[17px]">
              What that produces reads on{" "}
              <Link to="/changes" search={carry} className="underline underline-offset-2">
                Recent changes
              </Link>
              .
            </p>
          </ContextBlock>

          <ContextBlock label="Not offered">
            <NotOffered items={["Webhooks", "API tokens", "Third-party issue sync"]} />
          </ContextBlock>
        </div>
      </div>
    </div>
  );
}
