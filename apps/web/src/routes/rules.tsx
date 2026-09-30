import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AbsentBox, Box, StatusCell } from "~/components/spec/box";
import { ClearFilters, FilterBar, PlainSelect, SearchField } from "~/components/spec/controls";
import { EntityTable, countCell, type Column } from "~/components/spec/entity-table";
import { Chip, DefRow, EntityKey, PageHead } from "~/components/spec/parts";
import { Screen } from "~/components/spec/screen";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import type { ProjectModel, RuleRow } from "~/lib/model";
import { carry, type RootSearch } from "~/lib/search";
import { RULE_STATUS, formatRevisionTime, keySequence, label } from "~/lib/vocabulary";

/**
 * Rules — the canonical constraint catalogue.
 *
 * ## A Rule is a row, not a page
 *
 * Everything a Rule holds — statement, rationale, impact, consequence, evidence and
 * its named consumers — fits in one expandable row, so that is where it lives. A
 * dedicated page would be this row with more whitespace, and it would put the Rule
 * a navigation away from the hundred others you are comparing it against.
 *
 * The key stays addressable: `?rule=R-57` filters the table to it and opens the
 * row, so a Rule chip on a Task, a search hit and a pasted link all land in the same
 * place — with the Rule on screen rather than three pages away in a list of a
 * hundred.
 *
 * ## Consumers are direct and only direct
 *
 * An Epic, Stream or Task that names the Rule in its own document. Nothing is rolled
 * up from descendants: a Rule its Epic applies does not thereby govern every Stream
 * beneath it, and an inherited count would read as reach the Rule does not have.
 */

interface RulesSearch extends RootSearch {
  readonly q?: string;
  readonly evidence?: string;
  readonly named?: string;
  readonly status?: string;
  /** The Rule to filter down to and expand. How a Rule key is addressed. */
  readonly rule?: string;
}

export const Route = createFileRoute("/rules")({
  validateSearch: (search: Record<string, unknown>): RulesSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    evidence: typeof search.evidence === "string" ? search.evidence : undefined,
    named: typeof search.named === "string" ? search.named : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    rule: typeof search.rule === "string" ? search.rule : undefined,
  }),
  component: RulesPage,
});

function RulesPage() {
  return <Screen>{(model) => <RulesScreen model={model} />}</Screen>;
}

const FILTER_KEYS = ["q", "evidence", "named", "status", "rule"] as const;

function RulesScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const set = (patch: Partial<RulesSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  };

  const rows = model.rules.filter((row) => matches(row, search));
  const activeFilters = FILTER_KEYS.filter((key) => search[key] !== undefined).length;
  const withEvidence = model.rules.filter((row) => row.evidenceBasis !== null).length;
  const orphans = model.rules.filter((row) => row.consumerCount === 0).length;

  // The addressed Rule is the one that opens. Everything else stays collapsed, so
  // the table remains one line per Rule at a hundred rows.
  const expanded = search.rule ? { [search.rule]: true } : {};

  return (
    <div>
      <PageHead
        title="Rules"
        count={
          rows.length === model.rules.length
            ? model.rules.length
            : `${String(rows.length)} / ${String(model.rules.length)}`
        }
        hint="A Project Rule is a canonical constraint. It is not an ownership tier: a Rule governs the entities that name it and nothing else. Select a row to read its rationale, its evidence and the entities that name it."
      >
        <ClearFilters
          count={activeFilters}
          onClear={() => {
            void navigate({ search: (previous) => carry(previous) });
          }}
        />
      </PageHead>

      <FilterBar>
        <SearchField
          value={search.q}
          onChange={(value) => set({ q: value })}
          placeholder="Search key, title, statement or rationale…"
          width={300}
          label="Search Rules"
        />
        <PlainSelect
          label="Evidence"
          value={search.evidence}
          width={150}
          options={[
            ["any", "Any basis"],
            ["verified", "verified"],
            ["stated", "stated"],
            ["inferred", "inferred"],
            ["assumed", "assumed"],
            ["none", "None recorded"],
          ]}
          onChange={(value) => set({ evidence: value })}
        />
        <PlainSelect
          label="Named by"
          value={search.named}
          width={150}
          options={[
            ["epic", "an Epic"],
            ["stream", "a Stream"],
            ["task", "a Task"],
            ["nothing", "nothing"],
          ]}
          onChange={(value) => set({ named: value })}
        />
        <PlainSelect
          label="Status"
          value={search.status}
          width={130}
          options={RULE_STATUS.map((status) => [status, label(status)] as const)}
          onChange={(value) => set({ status: value })}
        />
        <span className="text-muted-foreground ml-auto text-[11px]">
          {`${String(withEvidence)} carry an evidence basis · ${String(orphans)} are named by nothing`}
        </span>
      </FilterBar>

      <EntityTable
        label="Rules"
        columns={ruleColumns(model)}
        rows={rows}
        expandedKeys={expanded}
        onSelect={(key) => set({ rule: search.rule === key ? undefined : key })}
        renderExpanded={(rule) => <RuleDetail rule={rule} nav={nav} />}
        defaultOrderLabel="Ordered by key · select a row to expand it"
        emptyLabel="No Rule matches this filter"
        initialPageSize={20}
      />
    </div>
  );
}

function RuleDetail({ rule, nav }: { readonly rule: RuleRow; readonly nav: EntityNav }) {
  return (
    <div className="flex flex-wrap gap-6 px-2 py-1">
      <div className="w-[600px] shrink-0">
        <div className="text-muted-foreground text-micro mb-1 font-mono font-semibold uppercase tracking-wider">
          Statement
        </div>
        <p className="text-ledger">{rule.statement}</p>

        {rule.rationale ? (
          <>
            <div className="text-muted-foreground text-micro mb-1 mt-3 font-mono font-semibold uppercase tracking-wider">
              Rationale
            </div>
            <p className="text-muted-foreground text-xs leading-[17px]">{rule.rationale}</p>
          </>
        ) : null}

        {rule.impact ? (
          <>
            <div className="text-muted-foreground text-micro mb-1 mt-3 font-mono font-semibold uppercase tracking-wider">
              Impact
            </div>
            <p className="text-muted-foreground text-xs leading-[17px]">{rule.impact}</p>
          </>
        ) : null}

        {rule.consequence ? (
          <>
            <div className="text-muted-foreground text-micro mb-1 mt-3 font-mono font-semibold uppercase tracking-wider">
              Consequence of breaking it
            </div>
            <p className="text-muted-foreground text-xs leading-[17px]">{rule.consequence}</p>
          </>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-micro mb-1 font-mono font-semibold uppercase tracking-wider">
          Direct consumers
        </div>
        <DefRow label="Epics">
          <KeyList keys={rule.namedByEpics} nav={nav} empty="No Epic names this Rule." />
        </DefRow>
        <DefRow label="Streams">
          <KeyList keys={rule.namedByStreams} nav={nav} empty="No Stream names this Rule." />
        </DefRow>
        <DefRow label="Tasks">
          <KeyList keys={rule.namedByTasks} nav={nav} empty="No Task names this Rule." />
        </DefRow>
        <DefRow
          label="Evidence"
          hint="How this Rule was established, and which local Sources it cites. Freshness is superseding-based — a Source becomes stale by being explicitly replaced, never through age."
        >
          {rule.evidenceBasis ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Box tone={rule.evidenceBasis === "verified" ? "success" : "dashed"}>
                {rule.evidenceBasis}
              </Box>
              {rule.evidenceSourceIds.map((sourceId) => (
                <Chip key={sourceId} variant="dotted">
                  {sourceId}
                </Chip>
              ))}
            </span>
          ) : (
            <AbsentBox label="none recorded" />
          )}
        </DefRow>
        <DefRow label="Revision">
          {`rev ${String(rule.revision)} · ${formatRevisionTime(rule.updatedAt)}`}
        </DefRow>
      </div>
    </div>
  );
}

function KeyList({
  keys,
  nav,
  empty,
}: {
  readonly keys: readonly string[];
  readonly nav: EntityNav;
  readonly empty: string;
}) {
  if (keys.length === 0) return <span className="text-muted-foreground text-xs">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {keys.map((key) => (
        <EntityKey
          key={key}
          entityKey={key}
          onClick={(event) => {
            event.stopPropagation();
            nav.inspect(key);
          }}
        />
      ))}
    </span>
  );
}

function ruleColumns(model: ProjectModel): readonly Column<RuleRow>[] {
  const withEvidence = model.rules.filter((row) => row.evidenceBasis !== null).length;
  return [
    {
      id: "key",
      label: "Key",
      width: 60,
      cellClass: "font-mono text-xs font-medium",
      sort: (row) => keySequence(row.key),
      render: (row) => row.key,
    },
    {
      id: "title",
      label: "Rule",
      width: 220,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.title,
      render: (row) => row.title,
    },
    {
      id: "statement",
      label: "Statement",
      flex: true,
      sort: (row) => row.statement,
      render: (row) => <span className="line-clamp-2 text-xs leading-[17px]">{row.statement}</span>,
    },
    {
      id: "consumers",
      label: "Direct consumers",
      width: 148,
      align: "right",
      sort: (row) => row.consumerCount,
      hint: "Epics, Streams and Tasks that name this Rule in their own document. Nothing is rolled up from descendants — a Rule applied by an Epic is not counted again for every Stream beneath it, because the data does not say it governs them.",
      render: (row) =>
        row.consumerCount === 0 ? (
          countCell(0)
        ) : (
          <span className="font-mono text-xs tabular-nums">
            {row.consumerCount}
            <span className="text-muted-foreground ml-1.5 text-[10px]">
              {[
                row.namedByEpics.length > 0 ? `${String(row.namedByEpics.length)}E` : "",
                row.namedByStreams.length > 0 ? `${String(row.namedByStreams.length)}S` : "",
                row.namedByTasks.length > 0 ? `${String(row.namedByTasks.length)}T` : "",
              ]
                .filter(Boolean)
                .join(" ")}
            </span>
          </span>
        ),
    },
    {
      id: "evidence",
      label: "Evidence",
      width: 128,
      sort: (row) => row.evidenceBasis ?? "zzz",
      hint: `The evidence basis recorded on the Rule. A Source becomes stale only by being explicitly superseded, never through age — so there is no age column and no expiry. ${String(withEvidence)} of ${String(model.rules.length)} Rules carry a basis at all.`,
      render: (row) =>
        row.evidenceBasis === null ? (
          <AbsentBox label="none recorded" />
        ) : (
          <Box tone={row.evidenceBasis === "verified" ? "success" : "dashed"}>
            {row.evidenceBasis}
          </Box>
        ),
    },
    {
      id: "status",
      label: "Status",
      width: 116,
      sort: (row) => row.status,
      render: (row) => <StatusCell status={row.status} />,
      hint: "A deprecated Rule stays addressable, so every reference to it stays explainable. That is why it is quiet rather than struck through.",
    },
    {
      id: "revision",
      label: "Revision",
      width: 88,
      align: "right",
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.revision,
      render: (row) => `rev ${String(row.revision)}`,
    },
  ];
}

function matches(rule: RuleRow, filters: RulesSearch): boolean {
  if (filters.rule && rule.key !== filters.rule) return false;

  if (filters.q) {
    const needle = filters.q.trim().toLowerCase();
    const haystack =
      `${rule.key} ${rule.title} ${rule.statement} ${rule.rationale ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  if (filters.evidence) {
    if (filters.evidence === "any" && rule.evidenceBasis === null) return false;
    if (filters.evidence === "none" && rule.evidenceBasis !== null) return false;
    if (
      filters.evidence !== "any" &&
      filters.evidence !== "none" &&
      rule.evidenceBasis !== filters.evidence
    ) {
      return false;
    }
  }

  if (filters.named === "epic" && rule.namedByEpics.length === 0) return false;
  if (filters.named === "stream" && rule.namedByStreams.length === 0) return false;
  if (filters.named === "task" && rule.namedByTasks.length === 0) return false;
  if (filters.named === "nothing" && rule.consumerCount > 0) return false;

  if (filters.status && rule.status !== filters.status) return false;

  return true;
}
