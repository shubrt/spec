import { useSearch } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { entityKindOf, parseRevisionRef, useEntityNav } from "~/lib/entityNav";
import { groupFragments, sectionLabel } from "~/lib/fragments";
import type { EpicRow, ProjectModel, StreamRow, TaskRow } from "~/lib/model";
import { cn } from "~/lib/utils";
import { formatRevisionTime, label } from "~/lib/vocabulary";
import { AbsentBox, Box, DependencyCell, ExecutorCell, PriorityCell, StatusCell } from "./box";
import { HistoricStatus } from "./historic-status";
import {
  Chip,
  DefRow,
  DrawerSection,
  EntityKey,
  ExternalLinkIcon,
  MetricGrid,
  RuleChip,
} from "./parts";
import { SpecFragment } from "./spec-fragment";
import type { RevisionEntry } from "~/lib/revisions";
import { RevisionDiff, revisionKindLabel, revisionKindTone } from "./revision-diff";

/**
 * The Inspector: a 440 px drawer over the work surface.
 *
 * It overlays rather than resizes. A table that reflows when a drawer opens moves
 * the row you just clicked, which is the one thing you were looking at.
 *
 * The specification is not a flat list here either — every fragment renders in the
 * shape its section calls for, at the dense setting that fits 440 px. Relations
 * (verifies-edges, evidence, Task backlinks) drop away, because the entity's own
 * page carries them and the icon in the header opens it.
 *
 * Placement means one thing in all three drawers: where the entity sits in the
 * hierarchy. Type, status and priority are header chips; the revision has its own
 * block. None of those is placement, so none of them is in it.
 */

function DrawerHeader({
  entityKey,
  entity,
  title,
  chips,
  onClose,
  onOpenPage,
}: {
  readonly entityKey: string;
  readonly entity: string;
  readonly title: string;
  readonly chips?: ReactNode;
  readonly onClose: () => void;
  readonly onOpenPage?: () => void;
}) {
  return (
    <div className="border-border-strong bg-background border-b px-4 pb-3 pt-3">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs font-medium">{entityKey}</span>
        <span className="text-muted-foreground text-micro font-mono uppercase tracking-wider">
          {entity}
        </span>
        {onOpenPage ? (
          <button
            type="button"
            onClick={onOpenPage}
            aria-label={`Open ${entityKey} on its own page`}
            title={`Open ${entityKey} on its own page`}
            className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
          >
            <ExternalLinkIcon />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          title="Close (Esc)"
          className="hover:bg-accent focus-visible:ring-ring ml-auto flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
        >
          <span className="text-sm leading-none">✕</span>
        </button>
      </div>
      <h2 className="mt-1.5 text-[17px] font-medium leading-6">{title}</h2>
      {chips ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div> : null}
    </div>
  );
}

function DrawerBody({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-4 pb-10">{children}</div>
    </div>
  );
}

/** A list of keys with titles and a trailing box — the drawer's one list shape. */
function RefList({
  items,
}: {
  readonly items: readonly {
    readonly key: string;
    readonly title: string;
    readonly muted?: boolean;
    readonly onClick: () => void;
    readonly trailing?: ReactNode;
  }[];
}) {
  return (
    <div className="border-border border-t">
      {items.map((item) => (
        <div key={item.key} className="border-border flex items-center gap-2 border-b py-2">
          <EntityKey
            entityKey={item.key}
            onClick={(event) => {
              event.stopPropagation();
              item.onClick();
            }}
            className="w-12 shrink-0 text-left"
          />
          <span
            className={cn(
              "text-ledger min-w-0 flex-1 truncate",
              item.muted && "text-muted-foreground",
            )}
          >
            {item.title}
          </span>
          {item.trailing}
        </div>
      ))}
    </div>
  );
}

function BlockerTrailing({
  satisfied,
  status,
}: {
  readonly satisfied: boolean;
  readonly status: string;
}) {
  return satisfied ? (
    <AbsentBox label="satisfied" />
  ) : (
    <Box tone="danger" marker="⊘">
      {label(status)}
    </Box>
  );
}

/* --------------------------------------------------------------- Stream -- */

function StreamInspector({
  stream,
  model,
  onClose,
}: {
  readonly stream: StreamRow;
  readonly model: ProjectModel;
  readonly onClose: () => void;
}) {
  const nav = useEntityNav();
  const tasks = model.tasks.filter((task) => task.streamKey === stream.key);
  const blocked = stream.dependency.kind === "blocked";
  const groups = groupFragments(stream.fragments);

  return (
    <>
      <DrawerHeader
        entityKey={stream.key}
        entity="Stream"
        title={stream.title}
        onClose={onClose}
        onOpenPage={() => nav.openPage(stream.key)}
        chips={
          <>
            <StatusCell status={stream.status} muted={blocked} />
            {blocked ? <DependencyCell dependency={stream.dependency} /> : null}
            <PriorityCell priority={stream.priority} />
            <Box tone="quiet">{stream.streamType}</Box>
          </>
        }
      />
      <DrawerBody>
        <DrawerSection
          label="Placement"
          hint="Where this Stream sits: Project, the Epic that owns it, and the Milestone it is assigned to. A Milestone is an assignment, not a parent."
        >
          <DefRow label="Project">{model.projectName}</DefRow>
          <DefRow label="Epic">
            <span className="flex items-baseline gap-2">
              <EntityKey entityKey={stream.epicKey} onClick={() => nav.inspect(stream.epicKey)} />
              <span className="text-muted-foreground min-w-0 truncate text-xs">
                {stream.epicTitle}
              </span>
            </span>
          </DefRow>
          <DefRow label="Milestone">
            {stream.milestoneKey ? (
              <span className="flex items-baseline gap-2">
                <EntityKey
                  entityKey={stream.milestoneKey}
                  onClick={() => nav.inspect(stream.milestoneKey ?? "")}
                />
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {stream.milestoneTitle}
                </span>
              </span>
            ) : (
              <AbsentBox label="not assigned" />
            )}
          </DefRow>
          <DefRow
            label="Roadmap rank"
            hint="Advisory ordering inside the Milestone. It is not a dependency, and two Streams sharing a rank do not block each other."
          >
            {stream.roadmapRank === null ? <AbsentBox label="unranked" /> : stream.roadmapRank}
          </DefRow>
        </DrawerSection>

        <DrawerSection
          label="Blocked by"
          count={stream.blockedBy.length}
          hint="Stored as dependent blocked_by prerequisite and shown prerequisite → dependent. A prerequisite that reaches completed is satisfied and stops holding the work; a cancelled one does not."
        >
          {stream.blockedBy.length > 0 ? (
            <RefList
              items={stream.blockedBy.map((blocker) => ({
                key: blocker.key,
                title: blocker.title,
                muted: blocker.satisfied,
                onClick: () => nav.inspect(blocker.key),
                trailing: <BlockerTrailing satisfied={blocker.satisfied} status={blocker.status} />,
              }))}
            />
          ) : (
            <AbsentBox label="Nothing is holding this Stream" />
          )}
        </DrawerSection>

        <DrawerSection
          label="Blocks"
          count={stream.blocks.length}
          hint="What finishing this Stream would release."
        >
          {stream.blocks.length > 0 ? (
            <RefList
              items={stream.blocks.map((released) => ({
                key: released.key,
                title: released.title,
                onClick: () => nav.inspect(released.key),
                trailing: <Box tone="quiet">{label(released.status)}</Box>,
              }))}
            />
          ) : (
            <AbsentBox label="Releases nothing" />
          )}
        </DrawerSection>

        <DrawerSection
          label="Tasks"
          count={tasks.length}
          hint="The technical units of work under this Stream. A Stream held by a dependency hides all of them from executable work, whatever their own status says."
        >
          {tasks.length > 0 ? (
            <RefList
              items={tasks.map((task) => ({
                key: task.key,
                title: task.title,
                onClick: () => nav.inspect(task.key),
                trailing: (
                  <StatusCell
                    status={task.status}
                    muted={task.dependency.kind === "blocked" || task.streamBlocked}
                  />
                ),
              }))}
            />
          ) : (
            <AbsentBox label="No Tasks yet" />
          )}
        </DrawerSection>

        {stream.relations.length > 0 ? (
          <DrawerSection
            label="Relations"
            count={stream.relations.length}
            hint="A semantic relation records that two entities are connected. It never blocks anything."
          >
            <RefList
              items={stream.relations.map((relation) => ({
                key: relation.key,
                title: relation.title,
                onClick: () => nav.inspect(relation.key),
                trailing: <Box tone="quiet">{label(relation.relationship)}</Box>,
              }))}
            />
          </DrawerSection>
        ) : null}

        {stream.purpose ? (
          <DrawerSection label="Purpose">
            <p className="text-muted-foreground text-ledger leading-[19px]">{stream.purpose}</p>
          </DrawerSection>
        ) : null}

        {groups.map((group) => (
          <DrawerSection
            key={group.section}
            label={sectionLabel(group.section)}
            count={group.items.length}
          >
            <div className="border-border border-t">
              {group.items.map((fragment) => (
                <SpecFragment key={fragment.id} fragment={fragment} dense />
              ))}
            </div>
          </DrawerSection>
        ))}

        {stream.sources.length > 0 ? (
          <DrawerSection
            label="Sources"
            count={stream.sources.length}
            hint="A Source becomes stale only by being explicitly superseded — never through age."
          >
            <div className="border-border border-t">
              {stream.sources.map((source) => (
                <div key={source.id} className="border-border border-b py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 font-mono text-xs">{source.id}</span>
                    <Box tone="quiet">{label(source.type)}</Box>
                    {source.supersededBy.length > 0 ? (
                      <Box tone="dashed">{`superseded by ${source.supersededBy.join(", ")}`}</Box>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-1 pl-14 text-xs leading-[17px]">
                    {source.reference}
                  </div>
                </div>
              ))}
            </div>
          </DrawerSection>
        ) : null}

        {stream.ruleApplications.length > 0 ? (
          <DrawerSection
            label="Rules"
            count={stream.ruleApplications.length}
            hint="Applied directly by this Stream. Each key opens the Rule on the Rules table. Rules its Epic applies are not repeated here — an inherited list would read as governance this Stream does not itself carry."
          >
            <div className="flex flex-wrap gap-1.5">
              {stream.ruleApplications.map((use) => {
                const rule = model.ruleByKey.get(use.ruleKey);
                return (
                  <RuleChip
                    key={use.id + use.ruleKey}
                    ruleKey={use.ruleKey}
                    title={rule ? `${rule.title} — ${rule.statement}` : `Open Rule ${use.ruleKey}`}
                    onClick={nav.inspect}
                  />
                );
              })}
            </div>
          </DrawerSection>
        ) : null}

        <DrawerSection label="Revision">
          <DefRow label="Current">{`rev ${String(stream.revision)}`}</DefRow>
          <DefRow label="Last changed">{formatRevisionTime(stream.updatedAt)}</DefRow>
        </DrawerSection>
      </DrawerBody>
    </>
  );
}

/* ----------------------------------------------------------------- Task -- */

function TaskInspector({
  task,
  model,
  onClose,
}: {
  readonly task: TaskRow;
  readonly model: ProjectModel;
  readonly onClose: () => void;
}) {
  const nav = useEntityNav();
  const epic = model.epicByKey.get(task.epicKey);
  const blocked = task.dependency.kind === "blocked" || task.streamBlocked;

  return (
    <>
      <DrawerHeader
        entityKey={task.key}
        entity="Task"
        title={task.title}
        onClose={onClose}
        onOpenPage={() => nav.openPage(task.key)}
        chips={
          <>
            <StatusCell status={task.status} muted={blocked} />
            {task.dependency.kind === "blocked" ? (
              <DependencyCell dependency={task.dependency} />
            ) : null}
            <PriorityCell priority={task.priority} />
            <Box tone="quiet">{task.taskType}</Box>
          </>
        }
      />
      <DrawerBody>
        <DrawerSection
          label="Placement"
          hint="Where this Task sits: Project, the Epic, then the Stream that owns it. A Task belongs to exactly one Stream."
        >
          <DefRow label="Project">{model.projectName}</DefRow>
          <DefRow label="Epic">
            <span className="flex items-baseline gap-2">
              <EntityKey entityKey={task.epicKey} onClick={() => nav.inspect(task.epicKey)} />
              <span className="text-muted-foreground min-w-0 truncate text-xs">{epic?.title}</span>
            </span>
          </DefRow>
          <DefRow label="Stream">
            <span className="flex items-baseline gap-2">
              <EntityKey entityKey={task.streamKey} onClick={() => nav.inspect(task.streamKey)} />
              <span className="text-muted-foreground min-w-0 truncate text-xs">
                {task.streamTitle}
              </span>
            </span>
          </DefRow>
        </DrawerSection>

        <DrawerSection
          label="Execution"
          hint="Executor kind is a stored preference for who may pick this up. It is never a live execution, and an absent one means nobody has decided — which is not the same as either."
        >
          <DefRow label="Executor">
            <ExecutorCell executor={task.executor} />
          </DefRow>
          <DefRow label="Assignee">
            {task.assignee ? (
              <span className="font-mono text-xs">{task.assignee}</span>
            ) : (
              <AbsentBox label="Unassigned" />
            )}
          </DefRow>
          <DefRow
            label="Estimate"
            hint="A coarse effort estimate. It is never a scheduled duration and no screen places it on an axis."
          >
            {task.estimate ?? <AbsentBox label="none" />}
          </DefRow>
          <DefRow
            label="Executable"
            hint="Derived at read time from the parent Epic's state, the stored statuses and the dependency graph. Not a stored field."
          >
            {task.executable ? (
              <Box tone="info">Could start now</Box>
            ) : (
              <AbsentBox label="Not executable" />
            )}
          </DefRow>
        </DrawerSection>

        <DrawerSection
          label="Blocked by"
          count={task.blockedBy.length}
          hint="A Task waits on its own Task-level prerequisites, and is held in addition by anything holding its parent Stream. Both are read from the same stored graph."
        >
          {task.blockedBy.length > 0 ? (
            <RefList
              items={task.blockedBy.map((blocker) => ({
                key: blocker.key,
                title: blocker.title,
                muted: blocker.satisfied,
                onClick: () => nav.inspect(blocker.key),
                trailing: <BlockerTrailing satisfied={blocker.satisfied} status={blocker.status} />,
              }))}
            />
          ) : null}
          {task.streamBlocked ? (
            <div className="text-ledger mt-2 flex items-center gap-2">
              <EntityKey entityKey={task.streamKey} onClick={() => nav.inspect(task.streamKey)} />
              <span className="text-muted-foreground text-xs">
                is held by an unfinished prerequisite
              </span>
            </div>
          ) : null}
          {task.blockedBy.length === 0 && !task.streamBlocked ? (
            <AbsentBox label="Nothing is holding this Task" />
          ) : null}
        </DrawerSection>

        {task.objective ? (
          <DrawerSection label="Objective">
            <p className="text-muted-foreground text-ledger leading-[19px]">{task.objective}</p>
          </DrawerSection>
        ) : null}

        <DrawerSection
          label="Implements"
          count={task.targets.length}
          hint="Typed business targets in the parent Stream, named with their owner because a local key is only unique inside it. The page resolves each one to the statement it points at."
        >
          {task.targets.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {task.targets.map((target) => (
                <Chip key={target.anchor}>{target.anchor}</Chip>
              ))}
            </div>
          ) : (
            <AbsentBox label="References no target" />
          )}
        </DrawerSection>

        {task.scope.length > 0 ? (
          <DrawerSection
            label="Technical scope"
            count={task.scope.length}
            hint="Sharing a scope with another open Task is a possible collision, never a detected conflict — nothing here has been executed."
          >
            <div className="flex flex-wrap gap-1.5">
              {task.scope.map((name) => (
                <Chip key={name} variant="dotted">
                  {name}
                </Chip>
              ))}
            </div>
          </DrawerSection>
        ) : null}

        <DrawerSection
          label="Verification"
          hint="Both numbers are contained by the Task. A verification is not linked to an Acceptance criterion — zpecs stores no such edge, so neither count claims one is covered."
        >
          <MetricGrid
            items={[
              { value: task.verificationCount, label: "Verifications" },
              { value: task.doneWhenCount, label: "Done-when statements" },
            ]}
          />
        </DrawerSection>

        {task.ruleKeys.length > 0 ? (
          <DrawerSection
            label="Constrained by"
            count={task.ruleKeys.length}
            hint="Each key opens the Rule on the Rules table, with its statement, rationale and evidence."
          >
            <div className="flex flex-wrap gap-1.5">
              {task.ruleKeys.map((ruleKey) => {
                const rule = model.ruleByKey.get(ruleKey);
                return (
                  <RuleChip
                    key={ruleKey}
                    ruleKey={ruleKey}
                    title={rule ? `${rule.title} — ${rule.statement}` : `Open Rule ${ruleKey}`}
                    onClick={nav.inspect}
                  />
                );
              })}
            </div>
          </DrawerSection>
        ) : null}

        <DrawerSection label="Revision">
          <DefRow label="Current">{`rev ${String(task.revision)}`}</DefRow>
          <DefRow label="Last changed">{formatRevisionTime(task.updatedAt)}</DefRow>
        </DrawerSection>
      </DrawerBody>
    </>
  );
}

/* ----------------------------------------------------------------- Epic -- */

function EpicInspector({
  epic,
  model,
  onClose,
}: {
  readonly epic: EpicRow;
  readonly model: ProjectModel;
  readonly onClose: () => void;
}) {
  const nav = useEntityNav();
  const streams = model.streams.filter((stream) => stream.epicKey === epic.key);

  return (
    <>
      <DrawerHeader
        entityKey={epic.key}
        entity="Epic"
        title={epic.title}
        onClose={onClose}
        onOpenPage={() => nav.openPage(epic.key)}
        chips={<StatusCell status={epic.status} />}
      />
      <DrawerBody>
        <DrawerSection
          label="Placement"
          hint="An Epic is the top of the hierarchy inside a Project. Nothing owns it."
        >
          <DefRow label="Project">{model.projectName}</DefRow>
          <DefRow label="Streams">{epic.streamCount}</DefRow>
          <DefRow label="Tasks">{epic.taskCount}</DefRow>
        </DrawerSection>

        <DrawerSection
          label="Progress"
          hint="Counted from the Streams and Tasks beneath this Epic. The Epic stores none of these numbers, and it has no completion state at all — active, paused and archived are the whole set, because finishing one of its Streams does not finish the capability."
        >
          <MetricGrid
            items={[
              {
                value: `${String(epic.streamsCompleted)}/${String(epic.streamCount)}`,
                label: "Streams completed",
              },
              {
                value: `${String(epic.tasksDone)}/${String(epic.taskCount)}`,
                label: "Tasks done",
              },
              { value: epic.readyNow, label: "Ready or in progress" },
              { value: epic.blockedStreams, label: "Dependency-blocked" },
              { value: epic.executableTasks, label: "Tasks that could start" },
              { value: epic.fragmentCount, label: "Spec fragments" },
            ]}
          />
        </DrawerSection>

        <DrawerSection label="Streams" count={streams.length}>
          {streams.length > 0 ? (
            <RefList
              items={streams.map((stream) => ({
                key: stream.key,
                title: stream.title,
                onClick: () => nav.inspect(stream.key),
                trailing:
                  stream.dependency.kind === "blocked" ? (
                    <DependencyCell dependency={stream.dependency} />
                  ) : (
                    <StatusCell status={stream.status} />
                  ),
              }))}
            />
          ) : (
            <AbsentBox label={`None — this Epic is ${epic.status}`} />
          )}
        </DrawerSection>

        {epic.ruleApplications.length > 0 ? (
          <DrawerSection
            label="Applied Rules"
            count={epic.ruleApplications.length}
            hint="Rules this Epic applies directly. Rules applied by its Streams are not rolled up here — an inherited count would read as governance this Epic does not itself carry."
          >
            <div className="flex flex-wrap gap-1.5">
              {epic.ruleApplications.map((use) => (
                <RuleChip key={use.id + use.ruleKey} ruleKey={use.ruleKey} onClick={nav.inspect} />
              ))}
            </div>
          </DrawerSection>
        ) : null}

        <DrawerSection label="Revision">
          <DefRow label="Current">{`rev ${String(epic.revision)}`}</DefRow>
          <DefRow label="Last changed">{formatRevisionTime(epic.updatedAt)}</DefRow>
        </DrawerSection>
      </DrawerBody>
    </>
  );
}

/* ------------------------------------------------------------- Revision -- */

/**
 * One revision, as a diff.
 *
 * The siblings block names the other entities written under the same recorded
 * reason. Deliberately not drawn as one change set: zpecs stores no batch, and a
 * box around them would invent a unit of review that cannot be opened, approved or
 * reverted.
 */
function RevisionInspector({
  entry,
  siblings,
  onClose,
}: {
  readonly entry: RevisionEntry;
  readonly siblings: readonly string[];
  readonly onClose: () => void;
}) {
  const nav = useEntityNav();

  return (
    <>
      <DrawerHeader
        entityKey={`${entry.entityKey} rev ${String(entry.revision)}`}
        entity="Revision"
        title={entry.title}
        onClose={onClose}
        chips={
          <>
            <Box tone={revisionKindTone(entry.kind)}>{revisionKindLabel(entry.kind)}</Box>
            <span className="text-muted-foreground font-mono text-xs">
              {`${entry.revision > 1 ? String(entry.revision - 1) : "—"} → ${String(entry.revision)}`}
            </span>
          </>
        }
      />
      <DrawerBody>
        <DrawerSection label="Recorded">
          <DefRow label="When">{formatRevisionTime(entry.createdAt)}</DefRow>
          <DefRow
            label="By"
            hint="The actor id stored on the revision — a Clerk user, or the identity that acted on their behalf. It is the only identity zpecs has ever written down."
          >
            <span className="font-mono text-xs">{entry.changedBy}</span>
          </DefRow>
          <DefRow label="Status after">
            <span className="flex items-center gap-1.5">
              <HistoricStatus status={entry.status} muted={!entry.statusChanged} />
              <span className="text-muted-foreground text-xs">
                {entry.statusChanged ? "changed here" : "unchanged"}
              </span>
            </span>
          </DefRow>
          <DefRow label="Entity">
            <EntityKey entityKey={entry.entityKey} onClick={() => nav.inspect(entry.entityKey)} />
          </DefRow>
        </DrawerSection>

        <DrawerSection
          label="Structural diff"
          count={entry.sectionDeltas.length}
          hint="How many entries each section of the document held before and after. Green means the section gained entries, red means it lost them. The whole document is kept per revision, so this is a summary of a diff the server has both sides of."
        >
          <RevisionDiff entry={entry} />
        </DrawerSection>

        <DrawerSection label="Reason">
          {entry.changeReason ? (
            <p className="text-ledger leading-[19px]">{entry.changeReason}</p>
          ) : (
            <AbsentBox label="none recorded" />
          )}
        </DrawerSection>

        {siblings.length > 0 ? (
          <DrawerSection
            label="Same reason, other entities"
            count={siblings.length}
            hint="Written under the same recorded reason. Deliberately not shown as one change set: zpecs stores no batch, and drawing one would invent a unit of review that cannot be opened or reverted."
          >
            <div className="flex flex-wrap gap-1.5">
              {siblings.map((key) => (
                <EntityKey
                  key={key}
                  entityKey={key}
                  className="text-muted-foreground"
                  onClick={() => nav.inspect(key)}
                />
              ))}
            </div>
          </DrawerSection>
        ) : null}
      </DrawerBody>
    </>
  );
}

/* -------------------------------------------------------------- overlay -- */

/**
 * Which targets an Inspector is responsible for.
 *
 * Two are mounted: one in the frame for every entity, and one on Recent changes
 * for revisions — because resolving a revision needs the log, and only that screen
 * loads it. Each ignores what the other owns, so exactly one drawer is ever open.
 */
export type InspectorScope = "entity" | "revision";

export function Inspector({
  model,
  scope = "entity",
  revisions,
}: {
  readonly model: ProjectModel;
  readonly scope?: InspectorScope;
  /** Required by, and only by, the revision-scoped Inspector. */
  readonly revisions?: readonly RevisionEntry[];
}) {
  const nav = useEntityNav();
  const target = useSearch({ from: "__root__" }).inspect;
  const search =
    target && entityKindOf(target) === "revision"
      ? scope === "revision"
        ? target
        : undefined
      : scope === "entity"
        ? target
        : undefined;

  useEffect(() => {
    if (!search) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // A popover inside the drawer captures Escape first and stops it here, so
      // closing a menu does not also close the drawer under it.
      if (event.key === "Escape") nav.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search, nav]);

  if (!search) return null;

  const kind = entityKindOf(search);
  let body: ReactNode = null;

  if (kind === "revision") {
    const reference = parseRevisionRef(search);
    const entry = reference
      ? revisions?.find(
          (candidate) =>
            candidate.entityKey === reference.entityKey &&
            candidate.revision === reference.revision,
        )
      : undefined;
    body = entry ? (
      <RevisionInspector
        entry={entry}
        siblings={siblingsOf(entry, revisions ?? [])}
        onClose={nav.close}
      />
    ) : (
      <NotHere onClose={nav.close} />
    );
  } else if (kind === "epic") {
    const epic = model.epicByKey.get(search);
    body = epic ? (
      <EpicInspector epic={epic} model={model} onClose={nav.close} />
    ) : (
      <NotHere onClose={nav.close} />
    );
  } else if (kind === "stream") {
    const stream = model.streamByKey.get(search);
    body = stream ? (
      <StreamInspector stream={stream} model={model} onClose={nav.close} />
    ) : (
      <NotHere onClose={nav.close} />
    );
  } else if (kind === "task") {
    const task = model.taskByKey.get(search);
    body = task ? (
      <TaskInspector task={task} model={model} onClose={nav.close} />
    ) : (
      <NotHere onClose={nav.close} />
    );
  } else {
    body = <NotHere onClose={nav.close} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={nav.close}
        aria-label="Close detail"
        tabIndex={-1}
        className="absolute inset-0 z-30 cursor-default bg-[oklch(0.145_0_0/0.18)]"
      />
      <aside
        role="complementary"
        aria-label={`${search} detail`}
        className="border-border-strong bg-background absolute inset-y-0 right-0 z-40 flex w-[440px] flex-col border-l shadow-[-8px_0_24px_rgba(0,0,0,0.10)]"
      >
        {body}
      </aside>
    </>
  );
}

/**
 * A key from a URL can name something this Project does not hold — the link may be
 * weeks old, or the Project may have been switched. The drawer opens and says so
 * rather than silently ignoring a link someone deliberately followed.
 */
function NotHere({ onClose }: { readonly onClose: () => void }) {
  return (
    <>
      <DrawerHeader
        entityKey="—"
        entity="Not found"
        title="Not in this Project"
        onClose={onClose}
      />
      <DrawerBody>
        <DrawerSection label="What happened">
          <p className="text-muted-foreground text-ledger leading-[19px]">
            The link names a key this Project does not contain. Keys are minted per Project and
            never reused, so the same key in another Project is a different entity — this one may
            simply belong somewhere else.
          </p>
        </DrawerSection>
      </DrawerBody>
    </>
  );
}

/**
 * Other entities written under the same recorded reason.
 *
 * Matched on the reason text because that is all the database stores — there is no
 * batch id, and there is no change-set row. Which is exactly why these are listed
 * as keys and not drawn as a unit.
 */
function siblingsOf(entry: RevisionEntry, revisions: readonly RevisionEntry[]): readonly string[] {
  if (!entry.changeReason) return [];
  const keys = new Set<string>();
  for (const candidate of revisions) {
    if (candidate.changeReason !== entry.changeReason) continue;
    if (candidate.entityKey === entry.entityKey) continue;
    keys.add(candidate.entityKey);
  }
  return [...keys].sort();
}
