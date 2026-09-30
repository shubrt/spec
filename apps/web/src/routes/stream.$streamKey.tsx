import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AbsentBox, Box, DependencyCell, PriorityCell, StatusCell } from "~/components/spec/box";
import { taskColumns } from "~/components/spec/columns";
import { DetailHead, DetailLayout } from "~/components/spec/detail-head";
import { EntityTable, type Column } from "~/components/spec/entity-table";
import {
  Chip,
  ContextBlock,
  DefRow,
  DocSection,
  EmptyState,
  EntityKey,
  MetricGrid,
  PageHead,
  PartHead,
  RuleChip,
  Tabs,
} from "~/components/spec/parts";
import { Screen } from "~/components/spec/screen";
import { SectionChips, SpecFragment } from "~/components/spec/spec-fragment";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import {
  SECTION_ORDER,
  groupFragments,
  isTargetable,
  sectionLabel,
  type SectionId,
} from "~/lib/fragments";
import type { ProjectModel, StreamRow } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { formatRevisionTime, label } from "~/lib/vocabulary";
import { getEntityDocument } from "~/server/entity";

/**
 * Stream detail — Overview, Specification, Tasks, Traceability, Changes.
 *
 * The Specification is two columns, not three. A vertical table of contents was
 * replaced by a sticky chip row that filters as well as jumps, which gave its
 * 192 px back to the document.
 *
 * Every fragment renders in the shape its section calls for. The same component
 * runs in the Inspector at a tighter density, so a criterion looks like a criterion
 * wherever you meet it.
 *
 * Copy link lives here and not on the Task page: a Stream is the unit you hand to
 * somebody else.
 */

const TABS = ["overview", "spec", "tasks", "trace", "changes"] as const;
type TabId = (typeof TABS)[number];

interface StreamSearch extends RootSearch {
  readonly tab?: TabId;
  readonly section?: SectionId;
}

export const Route = createFileRoute("/stream/$streamKey")({
  validateSearch: (search: Record<string, unknown>): StreamSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.includes(search.tab as TabId) ? (search.tab as TabId) : undefined,
    section: SECTION_ORDER.includes(search.section as SectionId)
      ? (search.section as SectionId)
      : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project }),
  // A Stream's Specification is the bulk of its document, so it no longer travels
  // with every navigation. This page — the one that renders it — fetches it, together
  // with the Sources its fragments cite.
  loader: ({ deps, params }) =>
    getEntityDocument({ data: { projectId: deps.projectId, key: params.streamKey } }),
  component: StreamPage,
});

/** The Stream's own fragments, as this page fetched them. */
function useStreamFragments() {
  const loaded = Route.useLoaderData();
  return loaded.ok ? loaded.fragments : [];
}

function StreamPage() {
  const { streamKey } = Route.useParams();
  return (
    <Screen>
      {(model) => {
        const stream = model.streamByKey.get(streamKey);
        if (!stream) {
          return (
            <div>
              <PageHead title={streamKey} />
              <EmptyState
                label={`No Stream ${streamKey} in this Project`}
                hint="Keys are minted per Project and never reused, so the same key in another Project is a different Stream. This link may simply belong somewhere else."
              />
            </div>
          );
        }
        return <StreamScreen stream={stream} model={model} />;
      }}
    </Screen>
  );
}

function StreamScreen({
  stream,
  model,
}: {
  readonly stream: StreamRow;
  readonly model: ProjectModel;
}) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });
  const loaded = Route.useLoaderData();
  const tab: TabId = search.tab ?? "overview";

  const streamFragments = loaded.ok ? loaded.fragments : [];
  const sources = loaded.ok ? loaded.sources : [];
  const tasks = model.tasks.filter((task) => task.streamKey === stream.key);
  const openBlockers = stream.blockedBy.filter((blocker) => !blocker.satisfied);

  // Open questions and assumptions frame the document rather than specify it, so
  // they read on Overview and are not part of the Specification's section list.
  const framing: readonly SectionId[] = ["open_questions", "assumptions"];
  const specFragments = streamFragments.filter((fragment) => !framing.includes(fragment.section));
  const groups = groupFragments(specFragments);
  const counts = Object.fromEntries(groups.map((group) => [group.section, group.items.length]));
  const shown = search.section
    ? groups.filter((group) => group.section === search.section)
    : groups;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "spec", label: "Specification", count: specFragments.length },
    { id: "tasks", label: "Tasks", count: tasks.length },
    { id: "trace", label: "Traceability", count: tasks.length },
    { id: "changes", label: "Changes", count: stream.revision },
  ];

  const setTab = (next: string) => {
    void navigate({ search: (previous) => ({ ...previous, tab: next as TabId }) });
  };

  const context = (
    <>
      <ContextBlock
        label="Derived progress"
        hint="Counted from the Tasks under this Stream and the fragments in its document. A Stream stores no aggregates."
      >
        <MetricGrid
          items={[
            {
              value: `${String(stream.tasksDone)}/${String(stream.taskCount)}`,
              label: "Tasks done",
            },
            { value: specFragments.length, label: "Spec fragments" },
            {
              value: tasks.filter((task) => task.targets.length > 0).length,
              label: "Tasks with targets",
            },
            { value: sources.length, label: "Sources" },
          ]}
        />
      </ContextBlock>

      <ContextBlock
        label="Placement"
        hint="Where this Stream sits: Project, then the Epic that owns it, then the Milestone it is assigned to. A Milestone is an assignment, not a parent."
      >
        <DefRow label="Project">{model.projectName}</DefRow>
        <DefRow label="Epic">
          <span className="flex items-baseline gap-2">
            <EntityKey entityKey={stream.epicKey} onClick={() => nav.openPage(stream.epicKey)} />
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
                onClick={() => nav.openPage(stream.milestoneKey ?? "")}
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
          {stream.roadmapRank ?? <AbsentBox label="unranked" />}
        </DefRow>
        <DefRow
          label="Derived wave"
          hint="Computed from the dependency graph at read time. `no edge` means this Stream takes part in no dependency at all — which is not the same as being in the first wave."
        >
          {model.waveOfStream.has(stream.key) ? (
            <Box tone="quiet">{String((model.waveOfStream.get(stream.key) ?? 0) + 1)}</Box>
          ) : (
            <AbsentBox label="no edge" />
          )}
        </DefRow>
      </ContextBlock>

      <ContextBlock
        label="Hard dependencies"
        hint="Stored as dependent blocked_by prerequisite and shown prerequisite → dependent. A prerequisite that reaches completed is satisfied and stops holding the work; a cancelled one does not."
      >
        {stream.blockedBy.length > 0 ? (
          stream.blockedBy.map((blocker) => (
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
        ) : (
          <span className="text-muted-foreground text-xs">Nothing is holding this Stream.</span>
        )}
        {stream.blocks.length > 0 ? (
          <div className="border-border mt-2 border-t pt-2">
            <span className="text-muted-foreground text-[11px]">Finishing it would release</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {stream.blocks.map((released) => (
                <EntityKey
                  key={released.key}
                  entityKey={released.key}
                  onClick={() => nav.inspect(released.key)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </ContextBlock>

      <ContextBlock
        label="Semantic relations"
        hint="A relation records that two entities are connected. It never blocks anything and never affects what could start."
      >
        {stream.relations.length > 0 ? (
          stream.relations.map((relation) => (
            <div
              key={`${relation.key}:${relation.relationship}`}
              className="flex items-baseline gap-2 py-1"
            >
              <EntityKey entityKey={relation.key} onClick={() => nav.inspect(relation.key)} />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {relation.title}
              </span>
              <Box tone="quiet">{label(relation.relationship)}</Box>
            </div>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">None</span>
        )}
      </ContextBlock>

      <ContextBlock
        label="Rules"
        hint="Rules this Stream applies directly; each key opens the Rule. Rules its Epic applies are not repeated here — an inherited list would read as governance this Stream does not itself carry."
      >
        {stream.ruleApplications.length > 0 ? (
          <div className="flex flex-wrap gap-1">
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
        ) : (
          <span className="text-muted-foreground text-xs">None applied directly.</span>
        )}
      </ContextBlock>

      <ContextBlock label="Revision">
        <DefRow label="Current">{`rev ${String(stream.revision)}`}</DefRow>
        <DefRow label="Last rewritten">{formatRevisionTime(stream.updatedAt)}</DefRow>
      </ContextBlock>
    </>
  );

  return (
    <div>
      <DetailHead
        kind="stream"
        entityKey={stream.key}
        title={stream.title}
        copyText={`${stream.key} · ${stream.title}`}
        chips={
          <>
            <Box tone="quiet">{stream.streamType}</Box>
            <StatusCell status={stream.status} muted={openBlockers.length > 0} />
            {openBlockers.length > 0 ? <DependencyCell dependency={stream.dependency} /> : null}
            <PriorityCell priority={stream.priority} />
          </>
        }
      />

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "overview" ? (
        <DetailLayout
          document={
            <>
              <DocSection label="Purpose">
                {stream.purpose ? (
                  <p className="text-ledger py-2 leading-[19px]">{stream.purpose}</p>
                ) : (
                  <div className="py-2">
                    <AbsentBox label="none recorded" />
                  </div>
                )}
              </DocSection>

              {stream.actor ? (
                <DocSection
                  label="Actor"
                  hint="Who the Stream is for. `primary` is the one actor whose need it exists to serve; a Stream with several equally primary actors is usually two Streams."
                >
                  <div className="py-1">
                    <DefRow label="Primary">{stream.actor.primary}</DefRow>
                    {stream.actor.secondary.length > 0 ? (
                      <DefRow label="Secondary">{stream.actor.secondary.join(", ")}</DefRow>
                    ) : null}
                  </div>
                </DocSection>
              ) : null}

              {stream.deliversAlone ? (
                <DocSection
                  label="Delivers alone"
                  hint="What this Stream delivers on its own, without any other Stream finishing. A Stream that needs three others before anyone notices it is not a vertical slice."
                >
                  <p className="text-ledger py-2">{stream.deliversAlone}</p>
                </DocSection>
              ) : null}

              {framing.map((section) => {
                const items = streamFragments.filter((fragment) => fragment.section === section);
                if (items.length === 0) return null;
                return (
                  <DocSection
                    key={section}
                    label={sectionLabel(section)}
                    count={items.length}
                    hint={
                      section === "open_questions"
                        ? "What is known to be unknown. An author who does not know something records it here instead of inventing an answer."
                        : "What is being taken as true without having been verified. An assumption is stated so it can be challenged, not so it can be forgotten."
                    }
                  >
                    {items.map((fragment) => (
                      <SpecFragment key={fragment.id} fragment={fragment} />
                    ))}
                  </DocSection>
                );
              })}
            </>
          }
          context={context}
        />
      ) : null}

      {tab === "spec" ? (
        specFragments.length === 0 ? (
          <div className="pt-5">
            <EmptyState
              label="No specification recorded yet"
              hint="A Stream may be an incomplete draft on purpose: an author who has heard one sentence writes a purpose and fills the rest in over later turns. Inventing the sections here would be exactly the failure that allows."
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-6 pt-3">
            <div className="w-[784px] max-w-full shrink-0">
              <SectionChips
                sections={groups.map((group) => group.section)}
                active={search.section ?? null}
                counts={counts}
                onPick={(section) => {
                  void navigate({
                    search: (previous) => ({ ...previous, section: section ?? undefined }),
                  });
                }}
              />
              <div className="pb-4">
                {shown.map((group) => (
                  // The wrapper carries the spacing. Without it every DocSection is
                  // a first child, its own top padding is cancelled, and the sections
                  // run together as one list.
                  <div key={group.section} className="scroll-mt-12 pt-8 first:pt-1">
                    <DocSection label={sectionLabel(group.section)} count={group.items.length}>
                      {group.items.map((fragment) => (
                        <SpecFragment
                          key={fragment.id}
                          fragment={fragment}
                          implementedBy={fragment.implementedBy}
                          onOpenEntity={nav.openPage}
                        />
                      ))}
                    </DocSection>
                  </div>
                ))}
              </div>
            </div>

            <div className="w-[296px] shrink-0">
              <ContextBlock
                label="Sources"
                hint="Immutable observations that claim evidence cites by id. A Source becomes stale only by being explicitly superseded by a newer one — never through age, which is why there is no age column anywhere."
              >
                {sources.length > 0 ? (
                  sources.map((source) => (
                    <div key={source.id} className="border-border border-b py-1.5 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{source.id}</span>
                        <Box tone="quiet">{label(source.type)}</Box>
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-[11px] leading-[15px]">
                        {source.reference}
                      </p>
                      {source.supersededBy.length > 0 ? (
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          {`superseded by ${source.supersededBy.join(", ")}`}
                        </p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground text-xs">None recorded.</span>
                )}
              </ContextBlock>
              {context}
            </div>
          </div>
        )
      ) : null}

      {tab === "tasks" ? (
        <div className="pt-5">
          <EntityTable
            label={`Tasks in ${stream.key}`}
            columns={taskColumns(nav, { hideStream: true })}
            rows={tasks}
            selectedKey={rootSearch.inspect}
            onSelect={nav.inspect}
            defaultOrderLabel={`The Tasks table, filtered to ${stream.key}`}
            emptyLabel="No Tasks under this Stream"
            emptyHint="A Stream with no technical breakdown yet. Focus lists these under Needs decomposition."
          />
        </div>
      ) : null}

      {tab === "trace" ? (
        <TraceTab stream={stream} model={model} nav={nav} specFragments={specFragments} />
      ) : null}

      {tab === "changes" ? (
        <div className="w-[664px] max-w-full pt-5">
          <DocSection
            label="Revision"
            hint="The per-entity history is real and immutable, and it reads on Recent changes — where a revision is a structural diff rather than an activity entry. This tab carries the current revision only rather than repeating that surface."
          >
            <DefRow label="Current">{`rev ${String(stream.revision)}`}</DefRow>
            <DefRow label="Last rewritten">{formatRevisionTime(stream.updatedAt)}</DefRow>
            <DefRow label="Created">{formatRevisionTime(stream.createdAt)}</DefRow>
            <DefRow label="Tasks">{tasks.length}</DefRow>
          </DocSection>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Traceability for one Stream — three edge kinds, each labelled.
 *
 * An Acceptance criterion verifies Requirements; a Task implements typed targets;
 * a Task is constrained by Rules. Verifications are contained by the Task and are
 * *not* linked to a criterion, so no column here claims that edge — there is none
 * stored, and drawing one would invent a guarantee.
 */
function TraceTab({
  stream,
  model,
  nav,
  specFragments,
}: {
  readonly stream: StreamRow;
  readonly model: ProjectModel;
  readonly nav: EntityNav;
  readonly specFragments: readonly FetchedFragment[];
}) {
  const tasks = model.tasks.filter((task) => task.streamKey === stream.key);
  const criteria = specFragments.filter((fragment) => fragment.section === "acceptance_criteria");
  // Anything a Task could name, plus anything one actually did. The backlink travels
  // with the fragment now, so this needs no project-wide index.
  const targetable = specFragments.filter(
    (fragment) =>
      fragment.section !== "acceptance_criteria" &&
      (fragment.implementedBy.length > 0 || isTargetable(fragment.section)),
  );

  return (
    <div className="w-[880px] max-w-full pt-5">
      <div className="border-border mb-4 border-b pb-2">
        <span className="text-ledger">Contextual view, not a guaranteed chain</span>
      </div>

      {targetable.length > 0 ? (
        <div className="pb-6">
          <PartHead
            title="Requirements"
            count={targetable.length}
            hint="Verified by is derived by reversing each criterion's own verifies edge — a Requirement stores nothing about who checks it. Implemented by is a real stored reference on the Task."
          />
          <EntityTable
            label={`Requirements of ${stream.key}`}
            columns={requirementColumns(criteria, nav)}
            rows={targetable.map((fragment) => ({ key: fragment.id, fragment }))}
            defaultOrderLabel="Read-only · the keys are the links"
            emptyLabel="None"
          />
        </div>
      ) : null}

      {criteria.length > 0 ? (
        <div className="pb-6">
          <PartHead
            title="Acceptance criteria"
            count={criteria.length}
            hint="Verifies is recorded on the criterion itself and points at the Requirements and Rules it claims to check."
          />
          <EntityTable
            label={`Acceptance criteria of ${stream.key}`}
            columns={criterionColumns(nav)}
            rows={criteria.map((fragment) => ({ key: fragment.id, fragment }))}
            defaultOrderLabel="Read-only · the keys are the links"
            emptyLabel="None"
          />
        </div>
      ) : null}

      <PartHead
        title="Tasks and their edges"
        count={tasks.length}
        hint="What each Task claims to carry, and what constrains it. Verifications are counted but never linked to a criterion — spec stores no such edge, so no row claims one."
      />
      <EntityTable
        label={`Tasks of ${stream.key}`}
        columns={taskEdgeColumns(model, nav)}
        rows={tasks}
        defaultOrderLabel="Read-only · the keys are the links"
        emptyLabel="No Tasks"
      />
    </div>
  );
}

/** A fragment as the per-entity endpoint returns it: the model plus its backlinks. */
type FetchedFragment = NonNullable<ReturnType<typeof useStreamFragments>>[number];

interface FragmentCell {
  readonly key: string;
  readonly fragment: FetchedFragment;
}

function statementOf(fragment: FetchedFragment): string {
  const { shape } = fragment;
  if (shape.kind === "statement") return shape.text;
  if (shape.kind === "criterion")
    return `Given ${shape.given} · When ${shape.when} · Then ${shape.then}`;
  if (shape.kind === "condition") return `${shape.condition} → ${shape.outcome}`;
  if (shape.kind === "transition") return `${shape.from} → ${shape.to}`;
  return shape.steps.map((step) => step.action).join(" · ");
}

function requirementColumns(
  criteria: readonly FetchedFragment[],
  nav: EntityNav,
): readonly Column<FragmentCell>[] {
  return [
    {
      id: "id",
      label: "Fragment",
      width: 92,
      cellClass: "font-mono text-xs",
      sort: (row) => row.key,
      render: (row) => row.key,
    },
    {
      id: "kind",
      label: "Kind",
      width: 160,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => sectionLabel(row.fragment.section),
    },
    {
      id: "statement",
      label: "Statement",
      flex: true,
      cellClass: "text-xs",
      sort: (row) => statementOf(row.fragment),
      render: (row) => <span className="line-clamp-2">{statementOf(row.fragment)}</span>,
    },
    {
      id: "verifiedBy",
      label: "Verified by",
      width: 150,
      hint: "Acceptance criteria naming this fragment in their verifies edge. Derived by reversing the criterion's own reference.",
      render: (row) => {
        const checking = criteria.filter((criterion) =>
          criterion.verifies.includes(row.fragment.id),
        );
        return checking.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {checking.map((criterion) => (
              <Chip key={criterion.id}>{criterion.id}</Chip>
            ))}
          </span>
        ) : (
          <AbsentBox label="none" />
        );
      },
    },
    {
      id: "implementedBy",
      label: "Implemented by",
      width: 170,
      hint: "Tasks whose implements edge names this fragment. An empty cell means no Task references it — not that the work is missing.",
      render: (row) => {
        const keys = row.fragment.implementedBy;
        return keys.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {keys.map((taskKey) => (
              <EntityKey key={taskKey} entityKey={taskKey} onClick={() => nav.inspect(taskKey)} />
            ))}
          </span>
        ) : (
          <AbsentBox label="no Task" />
        );
      },
    },
  ];
}

function criterionColumns(nav: EntityNav): readonly Column<FragmentCell>[] {
  return [
    {
      id: "id",
      label: "Criterion",
      width: 92,
      cellClass: "font-mono text-xs",
      sort: (row) => row.key,
      render: (row) => row.key,
    },
    {
      id: "statement",
      label: "Given / When / Then",
      flex: true,
      cellClass: "text-xs",
      render: (row) => <span className="line-clamp-2">{statementOf(row.fragment)}</span>,
    },
    {
      id: "verifies",
      label: "Verifies",
      width: 150,
      hint: "Requirements and Rule keys this criterion claims to check. Recorded on the criterion itself.",
      render: (row) =>
        row.fragment.verifies.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.fragment.verifies.map((target) => (
              <Chip key={target}>{target}</Chip>
            ))}
          </span>
        ) : (
          <AbsentBox label="nothing" />
        ),
    },
    {
      id: "method",
      label: "Method",
      width: 140,
      cellClass: "text-muted-foreground text-xs",
      render: (row) =>
        row.fragment.marks.method ? label(row.fragment.marks.method) : <AbsentBox label="none" />,
      hint: "How this criterion would be verified. A method, never a claim that it has been.",
    },
    {
      id: "implementedBy",
      label: "Implemented by",
      width: 170,
      render: (row) => {
        const keys = row.fragment.implementedBy;
        return keys.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {keys.map((taskKey) => (
              <EntityKey key={taskKey} entityKey={taskKey} onClick={() => nav.inspect(taskKey)} />
            ))}
          </span>
        ) : (
          <AbsentBox label="no Task" />
        );
      },
    },
  ];
}

function taskEdgeColumns(
  model: ProjectModel,
  nav: EntityNav,
): readonly Column<ProjectModel["tasks"][number]>[] {
  return [
    {
      id: "key",
      label: "Task",
      width: 72,
      render: (row) => <EntityKey entityKey={row.key} onClick={() => nav.inspect(row.key)} />,
    },
    { id: "title", label: "Title", flex: true, cellClass: "text-xs", render: (row) => row.title },
    {
      id: "implements",
      label: "Implements",
      width: 200,
      render: (row) =>
        row.targets.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.targets.map((target) => (
              <Chip key={target.anchor} title={target.anchor}>
                {target.id}
              </Chip>
            ))}
          </span>
        ) : (
          <AbsentBox label="none" />
        ),
      hint: "Local ids of this Stream, shown without the owner because the owner is the page you are on.",
    },
    {
      id: "rules",
      label: "Constrained by",
      width: 190,
      render: (row) =>
        row.ruleKeys.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.ruleKeys.map((ruleKey) => {
              const rule = model.ruleByKey.get(ruleKey);
              return (
                <RuleChip
                  key={ruleKey}
                  ruleKey={ruleKey}
                  title={rule ? `${rule.title} — ${rule.statement}` : undefined}
                  onClick={nav.inspect}
                />
              );
            })}
          </span>
        ) : (
          <AbsentBox label="none" />
        ),
    },
    {
      id: "verified",
      label: "Verifications",
      width: 124,
      align: "right",
      cellClass: "font-mono text-xs tabular-nums",
      sort: (row) => row.verificationCount,
      render: (row) => row.verificationCount,
      hint: "Contained by the Task. Deliberately not linked to an Acceptance criterion, because no such edge is stored.",
    },
  ];
}
