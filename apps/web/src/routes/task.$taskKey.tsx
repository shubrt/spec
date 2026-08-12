import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AbsentBox,
  Box,
  DependencyCell,
  ExecutorCell,
  PriorityCell,
  StatusCell,
} from "~/components/zpecs/box";
import { DetailHead, DetailLayout } from "~/components/zpecs/detail-head";
import { EntityTable, type Column } from "~/components/zpecs/entity-table";
import {
  Chip,
  ContextBlock,
  DefRow,
  DocSection,
  EmptyState,
  EntityKey,
  MetricGrid,
  PageHead,
  RuleChip,
  Tabs,
} from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { SpecFragment } from "~/components/zpecs/spec-fragment";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import { sectionLabel } from "~/lib/fragments";
import type { ProjectModel, TaskRow, TaskTarget } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { asArray, asRecord, asText, asTextArray, type JsonObject } from "~/lib/document";
import { formatRevisionTime, keySequence, label } from "~/lib/vocabulary";
import { getEntityDocument } from "~/server/entity";

/**
 * Task detail — Overview, Traceability, Changes.
 *
 * The Inspector can only name what a Task implements; this page has room to resolve
 * it, so a target arrives in the shape its own type calls for — a change target as
 * is → to be, a criterion as given/when/then — rendered by the same component the
 * Stream document uses. That is the whole reason this page exists: a Task is the
 * how, and the only way to judge it is beside the what it claims to carry.
 *
 * Every target keeps its owner in view. `S-46#CHG-1` is printed whole, because a
 * local key is only unique inside its own entity and here you are looking at
 * somebody else's fragment.
 *
 * A Task holds the technical side and nothing else. Business requirements stay in
 * the Stream and are quoted, never paraphrased.
 *
 * No copy-link control. The keys are project-scoped and the app has no slug-based
 * canonical path yet, so the address this page would hand you is one Settings ·
 * Project already explains cannot be resolved by anyone else.
 */

const TABS = ["overview", "trace", "changes"] as const;
type TabId = (typeof TABS)[number];

interface TaskSearch extends RootSearch {
  readonly tab?: TabId;
}

export const Route = createFileRoute("/task/$taskKey")({
  validateSearch: (search: Record<string, unknown>): TaskSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.includes(search.tab as TabId) ? (search.tab as TabId) : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project }),
  // The aggregate carries every Task without its `implementation` section, because
  // that section is large and this is the only page that shows it. One small request
  // on a page that is already about one Task.
  loader: ({ deps, params }) =>
    getEntityDocument({ data: { projectId: deps.projectId, key: params.taskKey } }),
  component: TaskPage,
});

/** The technical body, read from the document this page fetched for itself. */
interface Implementation {
  readonly approach: string;
  readonly steps: readonly string[];
  readonly decisions: readonly {
    readonly decision: string;
    readonly reason: string;
    readonly alternatives: readonly string[];
  }[];
}

function readImplementation(document: JsonObject | null): Implementation | null {
  const content = asRecord(asRecord(document ?? {}).content).implementation;
  const record = asRecord(content);
  const approach = asText(record.approach);
  const steps = asTextArray(record.steps);
  const decisions = asArray<JsonObject>(record.technical_decisions).map((entry) => ({
    decision: asText(entry.decision),
    reason: asText(entry.reason),
    alternatives: asTextArray(entry.alternatives_considered),
  }));
  if (approach.length === 0 && steps.length === 0 && decisions.length === 0) return null;
  return { approach, steps, decisions };
}

function TaskPage() {
  const { taskKey } = Route.useParams();
  return (
    <Screen>
      {(model) => {
        const task = model.taskByKey.get(taskKey);
        if (!task) {
          return (
            <div>
              <PageHead title={taskKey} />
              <EmptyState
                label={`No Task ${taskKey} in this Project`}
                hint="Keys are minted per Project and never reused, so the same key in another Project is a different Task."
              />
            </div>
          );
        }
        return <TaskScreen task={task} model={model} />;
      }}
    </Screen>
  );
}

function TaskScreen({ task, model }: { readonly task: TaskRow; readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const loaded = Route.useLoaderData();
  const tab: TabId = search.tab ?? "overview";
  const implementation = readImplementation(loaded.ok ? loaded.document : null);

  const epic = model.epicByKey.get(task.epicKey);
  const resolved = task.targets.filter((target) => target.fragment !== null).length;
  const openQuestions = task.fragments.filter((fragment) => fragment.section === "open_questions");
  const blocked = task.dependency.kind === "blocked" || task.streamBlocked;

  const context = (
    <>
      <ContextBlock label="Traceability" hint="Counted from the edges stored on this Task.">
        <MetricGrid
          items={[
            { value: task.targets.length, label: "Targets referenced" },
            {
              value: `${String(resolved)}/${String(task.targets.length)}`,
              label: "Targets resolved",
            },
            { value: task.ruleKeys.length, label: "Rules applied" },
            { value: task.scope.length, label: "Scopes touched" },
          ]}
        />
      </ContextBlock>

      <ContextBlock
        label="Placement"
        hint="Where this Task sits: Project, the Epic, then the Stream that owns it. A Task belongs to exactly one Stream."
      >
        <DefRow label="Project">{model.projectName}</DefRow>
        <DefRow label="Epic">
          <span className="flex items-baseline gap-2">
            <EntityKey entityKey={task.epicKey} onClick={() => nav.openPage(task.epicKey)} />
            <span className="text-muted-foreground min-w-0 truncate text-xs">{epic?.title}</span>
          </span>
        </DefRow>
        <DefRow label="Stream">
          <span className="flex items-baseline gap-2">
            <EntityKey entityKey={task.streamKey} onClick={() => nav.openPage(task.streamKey)} />
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {task.streamTitle}
            </span>
          </span>
        </DefRow>
      </ContextBlock>

      <ContextBlock
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
          hint="A coarse effort estimate — deliberately not a percentage, which would be invented precision. It is never a scheduled duration and no screen places it on an axis."
        >
          {task.estimate ?? <AbsentBox label="none" />}
        </DefRow>
        <DefRow
          label="Could start"
          hint="Derived at read time from the Epic's state, the stored statuses and the dependency graph. Not a stored flag."
        >
          {task.executable ? <Box tone="info">Yes</Box> : <AbsentBox label="No" />}
        </DefRow>
      </ContextBlock>

      <ContextBlock
        label="Blocked by"
        hint="A Task waits on its own Task-level prerequisites, and is held in addition by anything holding its parent Stream. Both are read from the same stored graph."
      >
        {task.blockedBy.length > 0
          ? task.blockedBy.map((blocker) => (
              <div key={blocker.key} className="flex items-baseline gap-2 py-1">
                <EntityKey entityKey={blocker.key} onClick={() => nav.inspect(blocker.key)} />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {blocker.title}
                </span>
                {blocker.satisfied ? (
                  <AbsentBox label="satisfied" />
                ) : (
                  <Box tone="danger" marker="⊘">
                    {label(blocker.status)}
                  </Box>
                )}
              </div>
            ))
          : null}
        {task.streamBlocked ? (
          <div className="flex items-baseline gap-2 py-1">
            <EntityKey entityKey={task.streamKey} onClick={() => nav.inspect(task.streamKey)} />
            <span className="text-muted-foreground min-w-0 flex-1 text-xs">
              is held by an unfinished prerequisite
            </span>
          </div>
        ) : null}
        {task.blockedBy.length === 0 && !task.streamBlocked ? (
          <span className="text-muted-foreground text-xs">Nothing is holding this Task.</span>
        ) : null}
      </ContextBlock>

      <ContextBlock
        label="Rules"
        hint="Rule constraints recorded on this Task. A Rule constrains how the work is done; it is never an implementation target and never satisfies readiness on its own."
      >
        {task.ruleKeys.length > 0 ? (
          <div className="flex flex-wrap gap-1">
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
        ) : (
          <span className="text-muted-foreground text-xs">None recorded.</span>
        )}
      </ContextBlock>

      <ContextBlock label="Revision">
        <DefRow label="Current">{`rev ${String(task.revision)}`}</DefRow>
        <DefRow label="Last rewritten">{formatRevisionTime(task.updatedAt)}</DefRow>
      </ContextBlock>
    </>
  );

  return (
    <div>
      <DetailHead
        kind="task"
        entityKey={task.key}
        title={task.title}
        chips={
          <>
            <Box tone="quiet">{task.taskType}</Box>
            <StatusCell status={task.status} muted={blocked} />
            {task.dependency.kind === "blocked" ? (
              <DependencyCell dependency={task.dependency} />
            ) : null}
            <PriorityCell priority={task.priority} />
          </>
        }
      />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "trace", label: "Traceability", count: task.targets.length + task.ruleKeys.length },
          { id: "changes", label: "Changes", count: task.revision },
        ]}
        value={tab}
        onChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, tab: next as TabId }) });
        }}
      />

      {tab === "overview" ? (
        <DetailLayout
          document={
            <>
              <DocSection
                label="Objective"
                hint="The technical outcome this Task is responsible for. The business reason lives in the Stream and is referenced below, never restated here."
              >
                {task.objective ? (
                  <p className="text-ledger py-2 leading-[19px]">{task.objective}</p>
                ) : (
                  <div className="py-2">
                    <AbsentBox label="none recorded" />
                  </div>
                )}
              </DocSection>

              <DocSection
                label="Implements"
                count={task.targets.length}
                hint="Typed business targets in the parent Stream, each rendered in the shape its own type calls for. Every ready Task references at least one, which is how the technical how stays traceable to the business what without repeating it."
              >
                {task.targets.length > 0 ? (
                  <div className="border-border border-t">
                    {task.targets.map((target) =>
                      target.fragment ? (
                        <SpecFragment
                          key={target.anchor}
                          fragment={target.fragment}
                          onOpenEntity={nav.openPage}
                          showOwner
                        />
                      ) : (
                        <UnresolvedTarget key={target.anchor} target={target} nav={nav} />
                      ),
                    )}
                  </div>
                ) : (
                  <div className="py-2">
                    <AbsentBox label="References no target" />
                  </div>
                )}
              </DocSection>

              {implementation ? (
                <DocSection
                  label="Implementation"
                  hint="How this Task is built. It is the one part of the document that is not carried by the project aggregate — it is large and only this page shows it, so this page fetches it."
                >
                  {implementation.approach ? (
                    <p className="text-ledger py-2 leading-[19px]">{implementation.approach}</p>
                  ) : null}
                  {implementation.steps.length > 0 ? (
                    <ol className="border-border list-inside list-decimal border-t">
                      {implementation.steps.map((step) => (
                        <li key={step} className="border-border text-ledger border-b py-2">
                          {step}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {implementation.decisions.map((decision) => (
                    <div key={decision.decision} className="border-border border-b py-2.5">
                      <p className="text-ledger">{decision.decision}</p>
                      {/* A decision without its reason is an assertion. The schema
                          requires both, and the pair is what makes it reviewable. */}
                      <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
                        <span className="font-mono text-[10px] uppercase">because</span>{" "}
                        {decision.reason}
                      </p>
                      {decision.alternatives.length > 0 ? (
                        <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
                          <span className="font-mono text-[10px] uppercase">instead of</span>{" "}
                          {decision.alternatives.join("; ")}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </DocSection>
              ) : null}

              <DocSection
                label="Technical scope"
                count={task.scope.length}
                hint="The parts of the codebase this Task touches. Sharing a scope with another open Task in the same wave is a possible collision — never a detected conflict, because nothing here has been executed."
              >
                {task.scope.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 py-2">
                    {task.scope.map((name) => (
                      <Chip key={name} variant="dotted">
                        {name}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <div className="py-2">
                    <AbsentBox label="No scope recorded" />
                  </div>
                )}
              </DocSection>

              <DocSection
                label="Verification"
                hint="Both numbers are contained by the Task. A verification is not linked to an Acceptance criterion — no such edge is stored, so neither count claims a criterion is covered."
              >
                <MetricGrid
                  items={[
                    { value: task.verificationCount, label: "Verifications" },
                    { value: task.doneWhenCount, label: "Done-when statements" },
                  ]}
                />
              </DocSection>

              {openQuestions.length > 0 ? (
                <DocSection
                  label="Open questions"
                  count={openQuestions.length}
                  hint="What is known to be unknown about how this is built. Recorded rather than guessed at."
                >
                  {openQuestions.map((fragment) => (
                    <SpecFragment key={fragment.id} fragment={fragment} />
                  ))}
                </DocSection>
              ) : null}
            </>
          }
          context={context}
        />
      ) : null}

      {tab === "trace" ? (
        <div className="w-[880px] max-w-full pt-5">
          <div className="border-border mb-4 border-b pb-2">
            <span className="text-ledger">Two stored edge kinds, both recorded on this Task</span>
          </div>

          <div className="pb-6">
            <EntityTable
              label="Implements"
              columns={targetColumns(nav)}
              rows={task.targets.map((target) => ({ key: target.anchor, target }))}
              defaultOrderLabel="Read-only · the keys are the links"
              emptyLabel="This Task references no target"
              emptyHint="A Task with no business target cannot be shown to carry anything. Readiness requires at least one, so this is either a draft or a gap."
            />
          </div>

          <EntityTable
            label="Constrained by Rules"
            columns={ruleColumns(nav)}
            rows={task.ruleKeys.map((ruleKey) => {
              const rule = model.ruleByKey.get(ruleKey);
              return {
                key: ruleKey,
                title: rule?.title ?? "",
                statement: rule?.statement ?? "",
              };
            })}
            defaultOrderLabel="Read-only · the Rule keys are the links"
            emptyLabel="No Rule is recorded on this Task"
          />
        </div>
      ) : null}

      {tab === "changes" ? (
        <div className="w-[664px] max-w-full pt-5">
          <DocSection
            label="Revision"
            hint="The per-entity history is real and immutable, and it reads on Recent changes — where a revision is a structural diff rather than an activity entry. This tab carries the current revision only."
          >
            <DefRow label="Current">{`rev ${String(task.revision)}`}</DefRow>
            <DefRow label="Last rewritten">{formatRevisionTime(task.updatedAt)}</DefRow>
            <DefRow label="Created">{formatRevisionTime(task.createdAt)}</DefRow>
            <DefRow label="Stream">
              <EntityKey entityKey={task.streamKey} onClick={() => nav.openPage(task.streamKey)} />
            </DefRow>
          </DocSection>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A target whose fragment is not in the owner's current document.
 *
 * The edge is real — the Task stores it — but the statement behind it is gone,
 * which happens when the Stream was rewritten and the fragment removed. Saying so is
 * the point: silently dropping the row would hide a dangling reference.
 */
function UnresolvedTarget({
  target,
  nav,
}: {
  readonly target: TaskTarget;
  readonly nav: EntityNav;
}) {
  return (
    <div className="border-border flex items-baseline gap-2 border-b py-2.5">
      <EntityKey
        entityKey={target.anchor}
        className="w-[104px] text-left"
        onClick={() => nav.openPage(target.owner)}
      />
      <span className="text-muted-foreground min-w-0 flex-1 text-xs leading-[17px]">
        {`The current document of ${target.owner} holds no fragment with this id. The reference is stored; the statement it points at is not there any more.`}
      </span>
    </div>
  );
}

function targetColumns(nav: EntityNav): readonly Column<{ key: string; target: TaskTarget }>[] {
  return [
    {
      id: "anchor",
      label: "Target",
      width: 124,
      sort: (row) => row.key,
      render: (row) => (
        <EntityKey entityKey={row.key} onClick={() => nav.openPage(row.target.owner)} />
      ),
      hint: "Printed whole. A local key is only unique inside its owner, and here the fragment belongs to another entity.",
    },
    {
      id: "kind",
      label: "Kind",
      width: 170,
      sort: (row) => row.target.fragment?.section ?? "",
      render: (row) =>
        row.target.fragment ? (
          <Box tone="quiet">{sectionLabel(row.target.fragment.section)}</Box>
        ) : (
          <AbsentBox label="not found" />
        ),
    },
    {
      id: "statement",
      label: "Statement",
      flex: true,
      cellClass: "text-xs",
      hint: "Quoted from the parent Stream. The Task does not own this sentence and never restates it — the Overview tab renders each one in its own shape.",
      render: (row) => {
        const fragment = row.target.fragment;
        if (!fragment) {
          return <span className="text-muted-foreground">{`not in ${row.target.owner}`}</span>;
        }
        const { shape } = fragment;
        const text =
          shape.kind === "statement"
            ? shape.text
            : shape.kind === "criterion"
              ? `Given ${shape.given} · When ${shape.when} · Then ${shape.then}`
              : shape.kind === "condition"
                ? `${shape.condition} → ${shape.outcome}`
                : shape.kind === "transition"
                  ? `${shape.from} → ${shape.to}`
                  : shape.steps.map((step) => step.action).join(" · ");
        return <span className="line-clamp-2">{text}</span>;
      },
    },
    {
      id: "owner",
      label: "Owner",
      width: 72,
      sort: (row) => keySequence(row.target.owner),
      render: (row) => (
        <EntityKey
          entityKey={row.target.owner}
          className="text-muted-foreground"
          onClick={() => nav.openPage(row.target.owner)}
        />
      ),
    },
  ];
}

function ruleColumns(
  nav: EntityNav,
): readonly Column<{ key: string; title: string; statement: string }>[] {
  return [
    {
      id: "key",
      label: "Rule",
      width: 72,
      sort: (row) => keySequence(row.key),
      render: (row) => <EntityKey entityKey={row.key} onClick={() => nav.inspect(row.key)} />,
    },
    {
      id: "title",
      label: "Title",
      width: 240,
      cellClass: "text-xs",
      sort: (row) => row.title,
      render: (row) => row.title,
    },
    {
      id: "statement",
      label: "Statement",
      flex: true,
      cellClass: "text-xs",
      sort: (row) => row.statement,
      render: (row) => <span className="line-clamp-2">{row.statement}</span>,
    },
  ];
}
