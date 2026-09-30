import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ApiFailure } from "~/lib/apiFailure";
import type { ProjectModel } from "~/lib/model";
import { carry } from "~/lib/search";
import { AbsentBox } from "./box";
import { Chip, CommandLine, ContextBlock, DocSection, MetricGrid, PageHead } from "./parts";

/**
 * The whole-surface states: a Project with nothing in it, a workspace with no
 * Project, and a read that could not complete.
 *
 * An empty Project is the state every Project starts in, and a control room with
 * nothing in it is the hardest screen to get right: it has to say what is missing,
 * why that is normal, and what the one next move is. None of these invents a way
 * forward — this surface never writes, so the next move is the MCP server.
 */

/**
 * A Project row with no content.
 *
 * It stands in for every screen rather than letting a reader visit ten of them to
 * find the same emptiness, and every counter reads a genuine `0` rather than being
 * marked unavailable — the rows do not exist, which is a fact, not a failed load.
 */
export function EmptyProject({
  model,
  mcpEndpoint,
}: {
  readonly model: ProjectModel;
  readonly mcpEndpoint: string | null;
}) {
  return (
    <div>
      <PageHead
        title={model.projectName}
        hint="A Project row with no content. spec mints keys per Project, so this one starts at E-1 again — a key is never shared between Projects and never reused inside one."
      />

      <div className="flex flex-wrap gap-8 pt-1">
        <div className="w-[664px] shrink-0">
          <DocSection label="Nothing here yet">
            <p className="text-ledger py-2 leading-[19px]">
              {model.projectName} holds no Epic, Stream, Task, Milestone or Rule, and no revision
              has ever been written against it. Every screen in the sidebar would show you the same
              emptiness, so this stands in their place.
            </p>
          </DocSection>

          <DocSection
            label="Contents"
            hint="Read from the Project. Every counter is genuinely zero — nothing here failed to load."
          >
            <MetricGrid
              items={[
                { value: 0, label: "Epics" },
                { value: 0, label: "Streams" },
                { value: 0, label: "Tasks" },
                { value: 0, label: "Milestones" },
                { value: 0, label: "Rules" },
                { value: 0, label: "Entity Revisions" },
              ]}
            />
          </DocSection>

          <DocSection
            label="Putting something in it"
            hint="This web surface is read-only by design. Every revision in every Project was written through the MCP server; none has ever originated in a browser."
          >
            <p className="text-muted-foreground py-2 text-xs leading-[17px]">
              Point an MCP client at the endpoint and create the first Epic from there. The Project
              is resolved from your session, so there is no per-Project URL to construct.
            </p>
            {mcpEndpoint ? (
              <>
                <CommandLine command={mcpEndpoint} />
                <CommandLine command={`claude mcp add --transport http spec ${mcpEndpoint}`} />
              </>
            ) : (
              <p className="text-muted-foreground py-2 text-xs">
                The endpoint is on{" "}
                <Link to="/connection" search={carry} className="underline underline-offset-2">
                  Connection
                </Link>
                .
              </p>
            )}
          </DocSection>
        </div>

        <div className="w-[304px] shrink-0">
          <ContextBlock label="What an empty Project is not">
            <p className="text-muted-foreground text-xs leading-[17px]">
              Not a failed load and not a filtered view. The rows genuinely do not exist, which is
              why every number reads 0 rather than being marked unavailable.
            </p>
          </ContextBlock>

          <ContextBlock
            label="Keys start again"
            hint="The counters that mint public keys are columns on the Project row, which is why a key survives a rename and is never reused."
          >
            <div className="flex flex-wrap gap-1.5">
              <Chip>E-1</Chip>
              <Chip>S-1</Chip>
              <Chip>T-1</Chip>
              <Chip>M-1</Chip>
              <Chip>R-1</Chip>
            </div>
            <p className="text-muted-foreground mt-2 text-xs leading-[17px]">
              S-1 here and S-1 in another Project are different Streams. A key is only unique inside
              its Project, which is why nothing in this app shows one without naming the Project.
            </p>
          </ContextBlock>

          <ContextBlock label="Workspace">
            <div className="flex items-baseline gap-2 py-1">
              <span className="font-mono text-xs font-medium">{model.projectName}</span>
              <span className="text-muted-foreground text-xs">empty</span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
              {model.workspaceName}
            </p>
          </ContextBlock>
        </div>
      </div>
    </div>
  );
}

/**
 * A workspace with no Project at all — one step further back than an empty Project.
 *
 * A Project container is the one thing this surface can create, because it is an
 * unversioned row with no document, no readiness and no revision history. Anything
 * inside it still enters through a change set.
 */
export function NoProject({ workspaceName }: { readonly workspaceName: string }) {
  return (
    <div>
      <PageHead
        title="No Project yet"
        hint="A Project is an unversioned container. It has no document and no revision history, which is why creating one is the single write this surface makes — everything inside it enters through the MCP server."
      />
      <div className="w-[664px]">
        <DocSection label="What is missing">
          <p className="text-ledger py-2 leading-[19px]">
            {workspaceName} holds no Project. Keys are minted per Project, so there is nowhere for
            an Epic to be created until one exists.
          </p>
        </DocSection>
        <DocSection label="Next move">
          <p className="text-muted-foreground py-2 text-xs leading-[17px]">
            Create one from the Project switcher in the context bar above. That is the single write
            this surface makes, and it is safe precisely because a Project has no document to
            validate and no history to keep.
          </p>
          <p className="text-muted-foreground py-1 text-xs leading-[17px]">
            Everything that goes inside it — Epics, Streams, Tasks, Rules, Milestones — is written
            through the MCP server.{" "}
            <Link to="/connection" search={carry} className="underline underline-offset-2">
              Connection
            </Link>{" "}
            carries the endpoint and the per-client command.
          </p>
        </DocSection>
      </div>
    </div>
  );
}

const REMEDY: Readonly<Record<ApiFailure["status"], string>> = {
  signed_out: "Sign in to continue.",
  no_workspace:
    "Create or join an organization from the switcher in the context bar, then reload. The organization is the workspace: spec reads its id off your session and matches it to a workspace row.",
  unavailable: "Nothing is lost — this surface only reads. Try again in a moment.",
};

/**
 * The three ways a read can fail, each with its own remedy.
 *
 * `no_workspace` in particular is a perfectly valid signed-in session that simply
 * has no active organization — the API answers it 403 rather than 401 for exactly
 * that reason — so it must not be dressed up as a fault.
 */
export function BoardFailure({ failure }: { readonly failure: ApiFailure }) {
  return (
    <div>
      <PageHead
        title={failure.status === "no_workspace" ? "No workspace selected" : "Nothing to show"}
      />
      <div className="w-[664px]">
        <DocSection label="What happened">
          {/* The API's own message, so what the reader sees is what the server said
              rather than this app's guess at it. */}
          <p className="text-ledger py-2 leading-[19px]">{failure.message}</p>
        </DocSection>
        <DocSection label="What to do">
          <p className="text-muted-foreground py-2 text-xs leading-[17px]">
            {REMEDY[failure.status]}
          </p>
          <div className="py-1">
            <AbsentBox label={failure.apiReachable ? "API answered" : "API did not answer"} />
          </div>
        </DocSection>
      </div>
    </div>
  );
}

/**
 * The signed-out surface — what Clerk hands back once the session ends.
 *
 * It was unreachable from inside the product until Sign out existed, which is the
 * point of building both. The frame is replaced rather than kept: chrome around a
 * login box is furniture, and a sidebar with counts from a workspace you can no
 * longer read would be worse than furniture.
 */
export function SignedOutFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-[440px]">
        <div className="border-border-strong rounded-md border px-6 py-8">
          <div className="text-muted-foreground text-micro mb-3 text-center font-mono font-semibold uppercase tracking-wider">
            spec
          </div>
          <h1 className="text-center text-[19px] font-medium leading-6">You are signed out.</h1>
          <p className="text-muted-foreground text-ledger mt-2 text-center leading-[19px]">
            spec is available by invitation only. Sign in with the account that was invited to this
            organization.
          </p>
          <div className="mt-5 flex justify-center">{children}</div>
        </div>

        <p className="text-muted-foreground mt-3 px-1 text-xs leading-[17px]">
          Signing in and out is a Clerk call. spec stores no session of its own: it reads the
          organization id off your session and matches it to a workspace row, and the only identity
          it has ever written down is the actor id on a revision.
        </p>
      </div>
    </div>
  );
}
