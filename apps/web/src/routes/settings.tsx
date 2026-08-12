import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AbsentBox, Box, NotStoredBox } from "~/components/zpecs/box";
import {
  CommandLine,
  ContextBlock,
  DefRow,
  DocSection,
  MetricGrid,
  NotOffered,
  PageHead,
  Tabs,
} from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { useMcpEndpoint } from "~/lib/boardState";
import type { ProjectModel } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { formatRevisionTime } from "~/lib/vocabulary";

/**
 * Settings — Members, Project, Integrations and Account.
 *
 * Account sits last because the three tabs before it are about the workspace and
 * this one is about you. It is where "Profile & preferences" in the sidebar lands:
 * a profile belongs on a screen, not in a popover.
 *
 * ## What this screen refuses to draw
 *
 * zpecs stores no user row, no membership and no role. Every one of those is named
 * here and pointed at Clerk rather than drawn as a form that would save nowhere — a
 * settings screen full of controls that silently do nothing is worse than one that
 * says which system owns the value.
 */

const TABS = [
  { id: "members", label: "Members" },
  { id: "project", label: "Project" },
  { id: "integrations", label: "Integrations" },
  { id: "account", label: "Account" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface SettingsSearch extends RootSearch {
  readonly tab?: TabId;
}

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.some((tab) => tab.id === search.tab) ? (search.tab as TabId) : undefined,
  }),
  component: SettingsPage,
});

function SettingsPage() {
  // Settings is about the workspace, the endpoint and your identity. None of that
  // depends on the Project holding any content, so it renders in an empty one.
  return <Screen allowEmpty>{(model) => <SettingsScreen model={model} />}</Screen>;
}

function SettingsScreen({ model }: { readonly model: ProjectModel }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: TabId = search.tab ?? "members";

  return (
    <div>
      <PageHead
        title="Settings"
        hint="Members, roles and invitations are a target capability: zpecs stores none of them, identity lives in Clerk and the workspace row holds only the organization id. Project, Integrations and Account read real data."
      />
      <Tabs
        tabs={TABS.map((entry) => ({ id: entry.id, label: entry.label }))}
        value={tab}
        onChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, tab: next as TabId }) });
        }}
      />
      <div className="pt-5">
        {tab === "members" ? <MembersTab model={model} /> : null}
        {tab === "project" ? <ProjectTab model={model} /> : null}
        {tab === "integrations" ? <IntegrationsTab /> : null}
        {tab === "account" ? <AccountTab model={model} /> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Members -- */

const ROLES = [
  ["Admin", "Invites, changes roles and removes access. Manages the Project."],
  ["Member", "Reads every Project and writes project content through the MCP server."],
] as const;

function MembersTab({ model }: { readonly model: ProjectModel }) {
  const { openOrganizationProfile } = useClerk();

  return (
    <div className="flex flex-wrap gap-8">
      <div className="w-[664px] shrink-0">
        <DocSection
          label="Organization"
          hint="zpecs stores only the Clerk organization id on its workspace row. The display name, the member list and every invitation live in Clerk, which is why this block links there instead of duplicating them."
        >
          <DefRow label="Workspace">{model.workspaceName}</DefRow>
          <DefRow label="Display name">
            <span className="flex items-center gap-2">
              <NotStoredBox title="Held by Clerk, not by zpecs" />
              <span className="text-muted-foreground text-xs">held by Clerk</span>
            </span>
          </DefRow>
        </DocSection>

        <DocSection
          label="Members and invitations"
          hint="zpecs stores no membership record and no role. Authorization is enforced by the service from the session's organization id; there is nothing on this page that could grant or revoke access."
        >
          <p className="text-muted-foreground py-2 text-xs leading-[17px]">
            The member list, invitations and role changes are Clerk's. Managing them here would mean
            drawing a second list that can disagree with the real one.
          </p>
          <button
            type="button"
            onClick={() => openOrganizationProfile()}
            className="border-input hover:bg-accent focus-visible:ring-ring mt-1 inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
          >
            Manage members in Clerk
          </button>
        </DocSection>
      </div>

      <div className="w-[304px] shrink-0">
        <ContextBlock
          label="Roles"
          hint="The target shape. zpecs stores no role today, and authorization would be enforced by the service rather than by this page."
        >
          {ROLES.map(([name, description]) => (
            <div key={name} className="border-border border-b py-2 last:border-0">
              <Box tone={name === "Admin" ? "neutral" : "quiet"}>{name}</Box>
              <p className="text-muted-foreground mt-1 text-xs leading-[16px]">{description}</p>
            </div>
          ))}
        </ContextBlock>

        <ContextBlock
          label="Not offered"
          hint="Each exists in comparable products and is left out on purpose: every one of them lets someone in without a named decision, which is the opposite of invitation-only."
        >
          <NotOffered
            items={["Public signup", "Reusable invite link", "Domain auto-join", "Guest access"]}
          />
        </ContextBlock>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Project -- */

function ProjectTab({ model }: { readonly model: ProjectModel }) {
  return (
    <div className="flex flex-wrap gap-8">
      <div className="w-[664px] shrink-0">
        <DocSection label="Project">
          <DefRow label="Name">
            <span className="font-mono text-xs">{model.projectName}</span>
          </DefRow>
          <DefRow label="Id">
            <span className="font-mono text-xs">{model.projectId}</span>
          </DefRow>
          <DefRow label="Workspace">{model.workspaceName}</DefRow>
          <DefRow label="Created">{formatRevisionTime(model.createdAt)}</DefRow>
          <DefRow label="Last activity" hint="The newest revision recorded in this Project.">
            {formatRevisionTime(model.updatedAt)}
          </DefRow>
        </DocSection>

        <DocSection
          label="Contents"
          hint="The counters that mint public keys are columns on the Project row, which is why a key survives a rename and is never reused."
        >
          <MetricGrid
            items={[
              { value: model.epics.length, label: "Epics" },
              { value: model.streams.length, label: "Streams" },
              { value: model.tasks.length, label: "Tasks" },
              { value: model.milestones.length, label: "Milestones" },
              { value: model.rules.length, label: "Rules" },
              { value: model.fragmentCount, label: "Spec fragments" },
              { value: model.totalRevisions, label: "Entity Revisions" },
              { value: model.linkCount, label: "Entity links" },
            ]}
          />
        </DocSection>

        <DocSection
          label="Deleting a Project"
          hint="Not offered here. Deleting a Project would remove every Epic, Stream, Task, Milestone, Rule, link and revision it holds, and public keys are project-scoped so every shared link into it would die with it."
        >
          <p className="text-muted-foreground py-2 text-xs leading-[17px]">
            The revision log is append-only and protected by a database trigger, which is what makes
            it an audit trail rather than a convention. A delete path from a browser would be the
            one way to erase it as a side effect, so this surface does not have one.
          </p>
        </DocSection>
      </div>

      <div className="w-[304px] shrink-0">
        <ContextBlock
          label="Canonical path"
          hint="The workspace slug is stored but empty and the Project table has no slug column, so no readable path can be produced yet. Guaranteed slugs and redirect aliases are new capabilities, not settings."
        >
          <div className="border-border bg-muted/50 rounded-md border px-2 py-1.5 font-mono text-[11px]">
            /{"{organization}"}/{"{project}"}/streams/S-1
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Box tone="danger" marker="⊘">
              no organization slug
            </Box>
            <Box tone="danger" marker="⊘">
              no Project slug
            </Box>
          </div>
        </ContextBlock>

        <ContextBlock
          label="Not offered"
          hint="Renaming touches stored keys and shared links; it is not a setting until redirect aliases exist."
        >
          <NotOffered items={["Rename Project", "Transfer to another organization", "Export"]} />
        </ContextBlock>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- Integrations -- */

function IntegrationsTab() {
  const mcp = useMcpEndpoint();

  const clients = [
    {
      id: "claude-code",
      title: "Claude Code",
      state: "ready" as const,
      description:
        "Run this once. The client then discovers the authorization server and signs you in through your browser.",
      commands: [`claude mcp add --transport http zpecs ${mcp.url}`],
      logout: "claude mcp logout zpecs",
    },
    {
      id: "codex",
      title: "OpenAI Codex",
      state: "ready" as const,
      description:
        "Run these in order. Codex adds the endpoint first, then starts browser-based sign-in.",
      commands: [`codex mcp add zpecs --url ${mcp.url}`, "codex mcp login zpecs"],
      logout: "codex mcp logout zpecs",
    },
    {
      id: "other",
      title: "Any other MCP client",
      state: "manual" as const,
      description:
        "The endpoint above is a standard streamable HTTP MCP server with browser-based authorization. A client that speaks that transport can be pointed at it — the command differs per client, and none of them has been verified here.",
      commands: [] as string[],
      logout: null,
    },
  ];

  return (
    <div className="flex flex-wrap gap-8">
      <div className="w-[664px] shrink-0">
        <DocSection
          label="Endpoint"
          hint="One streamable HTTP MCP server for the whole deployment. The workspace is resolved from the org_id claim in your token, so there is no per-workspace URL to construct."
        >
          <CommandLine command={mcp.url} />
          {mcp.isLocal ? (
            <p className="text-muted-foreground mt-2 text-xs leading-[17px]">
              This is a loopback address. It works on this machine and nowhere else — pasted into a
              colleague's client it will fail in a way that looks like a bug in zpecs.
            </p>
          ) : null}
        </DocSection>

        {clients.map((client) => (
          <DocSection
            key={client.id}
            label={client.title}
            hint={
              client.state === "ready"
                ? "Ready to connect: this command is defined in the app and works against this endpoint today."
                : "Endpoint only: the transport is standard, but no command line here has been verified for your client."
            }
          >
            <div className="flex items-center gap-2 pt-1.5">
              {client.state === "ready" ? (
                <Box tone="success" marker="●">
                  Ready to connect
                </Box>
              ) : (
                <Box tone="dashed">Endpoint only</Box>
              )}
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs leading-[17px]">
              {client.description}
            </p>
            {client.commands.map((command, index) => (
              <div key={command} className="mt-1.5 flex items-start gap-2">
                {client.commands.length > 1 ? (
                  <span className="text-muted-foreground w-4 shrink-0 pt-3 font-mono text-[11px]">
                    {index + 1}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <CommandLine command={command} />
                </span>
              </div>
            ))}
            {client.logout ? (
              <div className="mt-2">
                <span className="text-muted-foreground text-[11px]">Sign out again</span>
                <CommandLine command={client.logout} />
              </div>
            ) : null}
          </DocSection>
        ))}
      </div>

      <div className="w-[304px] shrink-0">
        <ContextBlock
          label="Connection state"
          hint="POST /mcp is stateless — a fresh transport per request with no session id — so the server has no view of connected clients. An indicator reading connected would be decoration over a fact nobody measured."
        >
          <DefRow label="Clients">
            <AbsentBox label="not observable" />
          </DefRow>
        </ContextBlock>

        <ContextBlock label="Write path" hint="This entire web surface is read-only by design.">
          <p className="text-muted-foreground text-xs leading-[17px]">
            Every revision in this workspace was written through the MCP server. None has ever
            originated in a browser, and there is no code path by which one could.
          </p>
        </ContextBlock>

        <ContextBlock label="Not offered">
          <NotOffered items={["Webhooks", "API tokens", "Third-party issue sync"]} />
        </ContextBlock>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Account -- */

function AccountTab({ model }: { readonly model: ProjectModel }) {
  // Read from the route context rather than Clerk's client hook, so the id this
  // page is *about* is server rendered instead of appearing after hydration.
  const { userId } = Route.useRouteContext();
  const { signOut, openUserProfile } = useClerk();

  return (
    <div className="flex flex-wrap gap-8">
      <div className="w-[664px] shrink-0">
        <DocSection
          label="Identity"
          hint="zpecs stores no user row. Your id appears in exactly one place in the database: the actor column of an Entity Revision. Everything else about you is resolved from your Clerk session at request time and never written down."
        >
          <DefRow label="Actor id">
            <span className="font-mono text-xs">{userId ?? "—"}</span>
          </DefRow>
          <DefRow label="Workspace">{model.workspaceName}</DefRow>
        </DocSection>

        <DocSection
          label="Held by Clerk"
          hint="Name, email, password and multi-factor settings live in Clerk. They are named here rather than drawn as a form, because a form on this page would save nowhere."
        >
          <DefRow label="Name">
            <NotStoredBox title="Held by Clerk, not by zpecs" />
          </DefRow>
          <DefRow label="Email">
            <NotStoredBox title="Held by Clerk, not by zpecs" />
          </DefRow>
          <DefRow label="Password">
            <NotStoredBox title="Held by Clerk, not by zpecs" />
          </DefRow>
          <DefRow label="Two-factor">
            <NotStoredBox title="Held by Clerk, not by zpecs" />
          </DefRow>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => openUserProfile()}
              className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
            >
              Open profile in Clerk
            </button>
          </div>
        </DocSection>

        <DocSection
          label="Preferences"
          hint="None is stored, by either system. What this surface remembers — the tab you were on, the filters you set — lives in the URL and is gone when you close it. A preference that survives needs a row to live in."
        >
          <div className="py-2">
            <AbsentBox label="No preference is stored" />
          </div>
        </DocSection>

        <DocSection label="Session">
          <div className="flex items-center gap-2 py-2">
            <button
              type="button"
              onClick={() => void signOut()}
              className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
            >
              Sign out
            </button>
            <span className="text-muted-foreground text-xs">
              Ends the Clerk session on this device.
            </span>
          </div>
        </DocSection>
      </div>

      <div className="w-[304px] shrink-0">
        <ContextBlock
          label="What is written down"
          hint="Counted from the revisions of this Project. The actor column is the whole of the identity zpecs records."
        >
          <MetricGrid
            items={[
              { value: model.totalRevisions, label: "Revisions in this Project" },
              { value: 0, label: "Written from a browser" },
            ]}
          />
        </ContextBlock>

        <ContextBlock
          label="Not offered"
          hint="Each needs a user row zpecs does not have, or belongs to Clerk."
        >
          <NotOffered
            items={[
              "Change password here",
              "Delete account",
              "Notification settings",
              "API tokens",
            ]}
          />
        </ContextBlock>
      </div>
    </div>
  );
}
