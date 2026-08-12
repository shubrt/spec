import { createFileRoute, Link } from "@tanstack/react-router";
import { StatusCell } from "~/components/zpecs/box";
import { Screen } from "~/components/zpecs/screen";
import {
  ContextBlock,
  DocSection,
  MetricGrid,
  PageHead,
  TableNote,
} from "~/components/zpecs/parts";
import { carry } from "~/lib/search";
import type { ProjectModel } from "~/lib/model";
import {
  EPIC_STATUS,
  MILESTONE_STATUS,
  RULE_STATUS,
  STREAM_STATUS,
  TASK_STATUS,
  formatRevisionTime,
  type EntityStatus,
} from "~/lib/vocabulary";

/**
 * Overview — how much work exists, and what state it is in.
 *
 * Every number is counted from the one aggregate the root loader already holds.
 * The API exposes no counts and asking it for any would be a second round trip for
 * something the payload answers: the Project row's key counters are the change-set
 * engine's bookkeeping and are deliberately not on the wire.
 *
 * There is no completion percentage for the Project. Streams and Tasks have their
 * own ladders and an Epic has no terminal state at all, so a single number across
 * all three would be an average of three different things.
 */
export const Route = createFileRoute("/")({ component: OverviewPage });

function OverviewPage() {
  return <Screen>{(model) => <Overview model={model} />}</Screen>;
}

interface StatusCount {
  readonly status: EntityStatus;
  readonly count: number;
}

/**
 * Every status of a vocabulary, including the ones nothing is in.
 *
 * "Nothing is blocked" is exactly the fact a reader wants confirmed, and a
 * breakdown built only from the statuses present leaves them guessing whether the
 * row is missing or the count is zero.
 */
function tally<Row extends { readonly status: EntityStatus }>(
  rows: readonly Row[],
  ladder: readonly EntityStatus[],
): readonly StatusCount[] {
  return ladder.map((status) => ({
    status,
    count: rows.filter((row) => row.status === status).length,
  }));
}

function Breakdown({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly StatusCount[];
}) {
  return (
    <div>
      <div className="border-border-strong mb-1 border-b pb-1">
        <span className="text-micro font-mono font-semibold uppercase tracking-wider">{title}</span>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.status} className="border-border flex items-center gap-2 border-b py-1.5">
            <StatusCell status={row.status} muted={row.count === 0} />
            <span
              className={
                row.count === 0
                  ? "text-muted-foreground ml-auto font-mono text-xs tabular-nums"
                  : "ml-auto font-mono text-xs tabular-nums"
              }
            >
              {row.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Overview({ model }: { readonly model: ProjectModel }) {
  const blockedStreams = model.streams.filter((row) => row.dependency.kind === "blocked").length;
  const executableTasks = model.tasks.filter((row) => row.executable).length;
  const undecomposed = model.streams.filter(
    (row) => row.taskCount === 0 && (row.status === "ready" || row.status === "in_progress"),
  ).length;

  return (
    <div>
      <PageHead
        title={model.projectName}
        hint="Every count on this screen is derived from the Project aggregate at read time. No entity stores an aggregate, so none of these is a stored field."
      >
        <span className="text-muted-foreground text-xs">
          {`Last revision ${formatRevisionTime(model.updatedAt)}`}
        </span>
      </PageHead>

      <TableNote
        items={[
          { value: model.epics.length, label: "Epics" },
          { value: model.streams.length, label: "Streams" },
          { value: model.tasks.length, label: "Tasks" },
          { value: model.milestones.length, label: "Milestones" },
          { value: model.rules.length, label: "Rules" },
          {
            value: model.fragmentCount,
            label: "spec fragments",
            hint: "Every addressable requirement, criterion, scope item, edge case, change target, hypothesis and question across the Streams of this Project.",
          },
        ]}
      />

      <div className="flex flex-wrap gap-8 pt-5">
        <div className="w-[664px] shrink-0">
          <DocSection
            label="State of the work"
            hint="Stored status and dependency blocking are two different signals and are counted separately here for the same reason they are separate columns everywhere else."
          >
            <MetricGrid
              items={[
                {
                  value: `${String(model.tasks.filter((row) => row.status === "done").length)}/${String(model.tasks.length)}`,
                  label: "Tasks done",
                },
                {
                  value: `${String(model.streams.filter((row) => row.status === "completed").length)}/${String(model.streams.length)}`,
                  label: "Streams completed",
                },
                { value: executableTasks, label: "Tasks that could start now" },
                { value: blockedStreams, label: "Streams held by a blocker" },
                { value: undecomposed, label: "Streams with no Tasks yet" },
                { value: model.linkCount, label: "Entity links" },
              ]}
            />
          </DocSection>

          <DocSection label="By status">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 pt-2">
              <Breakdown title="Epics" rows={tally(model.epics, EPIC_STATUS)} />
              <Breakdown title="Streams" rows={tally(model.streams, STREAM_STATUS)} />
              <Breakdown title="Tasks" rows={tally(model.tasks, TASK_STATUS)} />
              <Breakdown title="Milestones" rows={tally(model.milestones, MILESTONE_STATUS)} />
              <Breakdown title="Rules" rows={tally(model.rules, RULE_STATUS)} />
            </div>
          </DocSection>
        </div>

        <div className="w-[304px] shrink-0">
          <ContextBlock
            label="Where to start"
            hint="Focus answers what could be picked up now; the Roadmap answers what is planned in which order."
          >
            <div className="flex flex-col gap-1.5 py-1">
              <Link
                to="/focus"
                search={carry}
                className="text-ledger underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
              >
                {`Focus — ${String(executableTasks)} Tasks could start`}
              </Link>
              <Link
                to="/roadmap"
                search={carry}
                className="text-ledger underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
              >
                {`Roadmap — ${String(model.milestones.length)} Milestones`}
              </Link>
              <Link
                to="/changes"
                search={carry}
                className="text-ledger underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
              >
                Recent changes
              </Link>
            </div>
          </ContextBlock>

          <ContextBlock
            label="Derived at read time"
            hint="Waves are computed from the dependency graph on every load. They are not stored entities, and an equal wave means only that nothing forces an order."
          >
            <MetricGrid
              items={[
                { value: model.waves.length, label: "Dependency waves" },
                { value: model.longestChain.length, label: "Streams in the longest chain" },
                { value: model.collisions.length, label: "Possible scope collisions" },
              ]}
            />
          </ContextBlock>

          <ContextBlock label="Project">
            <p className="text-muted-foreground text-xs leading-[17px]">{model.workspaceName}</p>
            <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
              {`Created ${formatRevisionTime(model.createdAt)}`}
            </p>
          </ContextBlock>
        </div>
      </div>
    </div>
  );
}
