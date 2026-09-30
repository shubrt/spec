import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AbsentBox, StatusCell } from "~/components/spec/box";
import { openColumn, streamColumns } from "~/components/spec/columns";
import { DetailHead, DetailLayout } from "~/components/spec/detail-head";
import { EntityTable } from "~/components/spec/entity-table";
import {
  Chip,
  ContextBlock,
  DefRow,
  DocSection,
  EmptyState,
  EntityKey,
  MetricGrid,
  PageHead,
  Tabs,
} from "~/components/spec/parts";
import { Screen } from "~/components/spec/screen";
import { SpecFragment } from "~/components/spec/spec-fragment";
import { useEntityNav } from "~/lib/entityNav";
import { groupFragments, sectionLabel } from "~/lib/fragments";
import type { EpicRow, ProjectModel, StreamRow } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { formatRevisionTime } from "~/lib/vocabulary";
import { getEntityDocument } from "~/server/entity";

/**
 * Epic detail — Overview, Streams, Rules, Changes.
 *
 * Two columns: a document column that reads top to bottom, and a narrow context
 * column for placement, derived progress and applied Rules. Nothing in the context
 * column is prose; nothing in the document column is a metric.
 *
 * Every count is labelled derived, because an Epic stores no aggregates — all of
 * them are counted from the Streams and Tasks beneath it on every load.
 */

const TABS = ["overview", "streams", "rules", "changes"] as const;
type TabId = (typeof TABS)[number];

interface EpicSearch extends RootSearch {
  readonly tab?: TabId;
}

export const Route = createFileRoute("/epic/$epicKey")({
  validateSearch: (search: Record<string, unknown>): EpicSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.includes(search.tab as TabId) ? (search.tab as TabId) : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project }),
  // An Epic's scope, outcomes and metrics are fragments, and they left the aggregate
  // with every other document section. This page fetches its own.
  loader: ({ deps, params }) =>
    getEntityDocument({ data: { projectId: deps.projectId, key: params.epicKey } }),
  component: EpicPage,
});

function EpicPage() {
  const { epicKey } = Route.useParams();
  return (
    <Screen>
      {(model) => {
        const epic = model.epicByKey.get(epicKey);
        if (!epic) {
          return (
            <div>
              <PageHead title={epicKey} />
              <EmptyState
                label={`No Epic ${epicKey} in this Project`}
                hint="Keys are minted per Project and never reused, so the same key in another Project is a different Epic."
              />
            </div>
          );
        }
        return <EpicScreen epic={epic} model={model} />;
      }}
    </Screen>
  );
}

function EpicScreen({ epic, model }: { readonly epic: EpicRow; readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });
  const loaded = Route.useLoaderData();
  const tab: TabId = search.tab ?? "overview";

  const streams = model.streams.filter((stream) => stream.epicKey === epic.key);
  const groups = groupFragments(loaded.ok ? loaded.fragments : []);

  const context = (
    <>
      <ContextBlock
        label="Derived progress"
        hint="Counted from the Streams and Tasks beneath this Epic. An Epic stores no aggregates, so none of these numbers is a stored field — and none of them can make the Epic complete, because it has no completion state."
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
            { value: epic.blockedStreams, label: "Held by a prerequisite" },
            { value: epic.executableTasks, label: "Tasks that could start" },
            {
              value: streams.reduce((sum, stream) => sum + stream.taskCount, 0),
              label: "Tasks beneath",
            },
          ]}
        />
      </ContextBlock>

      <ContextBlock
        label="Placement"
        hint="An Epic is the top of the hierarchy inside a Project. Nothing owns it."
      >
        <DefRow label="Project">{model.projectName}</DefRow>
        <DefRow label="Streams">{epic.streamCount}</DefRow>
        <DefRow label="Tasks">{epic.taskCount}</DefRow>
      </ContextBlock>

      <ContextBlock
        label="Held Streams"
        hint="Held by an unfinished prerequisite. This is dependency blocking, never a stored status."
      >
        {streams.filter((stream) => stream.dependency.kind === "blocked").length > 0 ? (
          streams
            .filter((stream) => stream.dependency.kind === "blocked")
            .map((stream) => (
              <div key={stream.key} className="flex items-baseline gap-2 py-1">
                <EntityKey entityKey={stream.key} onClick={() => nav.inspect(stream.key)} />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {stream.title}
                </span>
              </div>
            ))
        ) : (
          <span className="text-muted-foreground text-xs">None</span>
        )}
      </ContextBlock>

      <ContextBlock
        label="Applied Rules"
        hint="Rules this Epic applies directly. Rules applied by its Streams are not rolled up here — an inherited count would read as governance this Epic does not itself carry."
      >
        {epic.ruleApplications.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {epic.ruleApplications.map((use) => (
              <Chip key={use.id + use.ruleKey} title={model.ruleByKey.get(use.ruleKey)?.statement}>
                {use.ruleKey}
              </Chip>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">None applied directly.</span>
        )}
      </ContextBlock>

      <ContextBlock label="Revision">
        <DefRow label="Current">{`rev ${String(epic.revision)}`}</DefRow>
        <DefRow label="Last rewritten">{formatRevisionTime(epic.updatedAt)}</DefRow>
      </ContextBlock>
    </>
  );

  return (
    <div>
      <DetailHead
        kind="epic"
        entityKey={epic.key}
        title={epic.title}
        chips={<StatusCell status={epic.status} />}
      />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "streams", label: "Streams", count: streams.length },
          { id: "rules", label: "Rules", count: epic.ruleApplications.length },
          { id: "changes", label: "Changes", count: epic.revision },
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
                label="Purpose"
                hint="The standing business capability this Epic represents. Not a deliverable and not time-boxed, which is why an Epic has no completed state."
              >
                {epic.purpose ? (
                  <p className="text-ledger py-2 leading-[19px]">{epic.purpose}</p>
                ) : (
                  <div className="py-2">
                    <AbsentBox label="none recorded" />
                  </div>
                )}
              </DocSection>

              {epic.businessProblem ? (
                <DocSection label="Business problem">
                  <p className="text-ledger py-2 leading-[19px]">{epic.businessProblem}</p>
                </DocSection>
              ) : null}

              {groups.map((group) => (
                <DocSection
                  key={group.section}
                  label={sectionLabel(group.section)}
                  count={group.items.length}
                  hint={
                    group.section === "scope_excluded"
                      ? "Recorded exclusions, not omissions. An exclusion usually names the phase or the Stream that owns the work instead."
                      : group.section === "success_metrics"
                        ? "A measurable target with a number. Distinct from an Outcome, which states the effect without committing to a threshold."
                        : undefined
                  }
                >
                  {group.items.map((fragment) => (
                    <SpecFragment key={fragment.id} fragment={fragment} />
                  ))}
                </DocSection>
              ))}

              {groups.length === 0 && !epic.purpose ? (
                <EmptyState
                  label="This Epic's document is empty"
                  hint="Only a purpose is structurally required, and an Epic may legitimately carry nothing else. Inventing scope or outcomes here would be exactly the failure that allows."
                />
              ) : null}
            </>
          }
          context={context}
        />
      ) : null}

      {tab === "streams" ? (
        <div className="pt-5">
          <EntityTable
            label={`Streams in ${epic.key}`}
            columns={[...streamColumns(nav, { hideEpic: true }), openColumn<StreamRow>(nav)]}
            rows={streams}
            selectedKey={rootSearch.inspect}
            onSelect={nav.inspect}
            defaultOrderLabel={`The Streams table, filtered to ${epic.key}`}
            emptyLabel="No Streams in this Epic"
          />
        </div>
      ) : null}

      {tab === "rules" ? (
        <div className="w-[880px] max-w-full pt-5">
          <DocSection
            label="Rules applied by this Epic"
            count={epic.ruleApplications.length}
            hint="Direct consumers only. A Rule applied by a Stream under this Epic is that Stream's application, not this Epic's — the two are separate facts and are counted separately."
          >
            {epic.ruleApplications.length > 0 ? (
              <div className="border-border border-t">
                {epic.ruleApplications.map((use) => {
                  const rule = model.ruleByKey.get(use.ruleKey);
                  return (
                    <div key={use.id + use.ruleKey} className="border-border border-b py-2.5">
                      <div className="flex items-baseline gap-3">
                        <EntityKey
                          entityKey={use.ruleKey}
                          className="w-[70px] text-left"
                          onClick={() => nav.inspect(use.ruleKey)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-ledger">
                            {rule?.title ?? "Rule not in this Project"}
                          </div>
                          {rule ? (
                            <p className="text-muted-foreground mt-0.5 text-xs leading-[17px]">
                              {rule.statement}
                            </p>
                          ) : null}
                          {use.appliesWhen ? (
                            <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
                              <span className="font-mono text-[10px] uppercase">applies when</span>{" "}
                              {use.appliesWhen}
                            </p>
                          ) : null}
                          {use.application ? (
                            <p className="text-muted-foreground mt-1 text-xs leading-[17px]">
                              <span className="font-mono text-[10px] uppercase">here</span>{" "}
                              {use.application}
                            </p>
                          ) : null}
                        </div>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          {use.id}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground py-2 text-xs">
                This Epic applies no Rule directly. A local application narrows when a canonical
                Rule applies; it never overrides the Rule's own text.
              </p>
            )}
          </DocSection>
        </div>
      ) : null}

      {tab === "changes" ? (
        <div className="w-[664px] max-w-full pt-5">
          <DocSection
            label="Revision"
            hint="The per-entity history is real and immutable, and it reads on Recent changes — where a revision is a structural diff rather than an activity entry. This tab carries the current revision only."
          >
            <DefRow label="Current">{`rev ${String(epic.revision)}`}</DefRow>
            <DefRow label="Last rewritten">{formatRevisionTime(epic.updatedAt)}</DefRow>
            <DefRow label="Created">{formatRevisionTime(epic.createdAt)}</DefRow>
            <DefRow label="Beneath it">
              {`${String(epic.streamCount)} Streams, ${String(epic.taskCount)} Tasks`}
            </DefRow>
          </DocSection>
        </div>
      ) : null}
    </div>
  );
}
