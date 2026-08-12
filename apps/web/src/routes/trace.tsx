import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AbsentBox, Box } from "~/components/zpecs/box";
import { SearchSelect } from "~/components/zpecs/controls";
import {
  Chip,
  DefRow,
  DocSection,
  EmptyState,
  EntityKey,
  PageHead,
} from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { SpecFragment } from "~/components/zpecs/spec-fragment";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import { fragmentText, sectionLabel } from "~/lib/fragments";
import type { ProjectModel, RuleRow } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { keySequence } from "~/lib/vocabulary";
import { getFragments, type FragmentEntry } from "~/server/fragments";

/**
 * Traceability — a contextual view from one starting point, never a matrix.
 *
 * A hundred Rules against several hundred fragments is sixty-five thousand cells,
 * almost all of them empty *by design* — most Rules were never meant to touch most
 * requirements. A grid would present that emptiness as missing work, which is
 * exactly backwards.
 *
 * So it starts from one Rule or one Requirement and shows what genuinely points at
 * it. Every edge here is a real stored reference or the reversal of one, and the
 * reversal says so: a Requirement stores nothing about who verifies it, so
 * "Verified by" is read backwards off the criterion's own `verifies` edge.
 */

interface TraceSearch extends RootSearch {
  /** A Rule key, or a fragment anchor like `S-14#FR-2`. */
  readonly anchor?: string;
}

export const Route = createFileRoute("/trace")({
  validateSearch: (search: Record<string, unknown>): TraceSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    anchor: typeof search.anchor === "string" ? search.anchor : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project, anchor: search.anchor }),
  /**
   * Two pages of the fragment endpoint: the Requirements the picker offers, and — when
   * an anchor is selected — every fragment of its owner, which is what the reversal of
   * a verifies-edge is read from.
   */
  loader: async ({ deps }) => {
    const owner = deps.anchor?.includes("#") ? deps.anchor.split("#")[0] : undefined;
    const [requirements, ownerFragments] = await Promise.all([
      getFragments({ data: { projectId: deps.projectId, section: "functional", limit: 400 } }),
      owner
        ? getFragments({ data: { projectId: deps.projectId, owner, limit: 400 } })
        : Promise.resolve(null),
    ]);
    return { requirements, ownerFragments };
  },
  component: TracePage,
});

function TracePage() {
  return <Screen>{(model) => <TraceScreen model={model} />}</Screen>;
}

function TraceScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const set = (anchor: string | undefined) => {
    void navigate({ search: (previous) => ({ ...previous, anchor }) });
  };

  const loaded = Route.useLoaderData();
  const requirements = loaded.requirements.fragments;

  const rule = search.anchor ? (model.ruleByKey.get(search.anchor) ?? null) : null;
  const ownerFragments = loaded.ownerFragments?.fragments ?? [];
  const fragment =
    search.anchor && !rule
      ? (ownerFragments.find((candidate) => candidate.anchor === search.anchor) ?? null)
      : null;

  return (
    <div>
      <PageHead
        title="Traceability"
        hint="A lookup from one starting point, not a report. Starting from one entity keeps every edge on screen labelled and checkable; a full matrix would show tens of thousands of cells, almost all of them empty by design rather than by omission."
      />

      <div className="border-border flex flex-wrap items-center gap-4 border-b py-2.5">
        <SearchSelect
          label="From a Rule"
          value={rule?.key}
          width={130}
          placeholder="—"
          options={model.rules.map((candidate) => ({ key: candidate.key, label: candidate.title }))}
          onChange={set}
        />
        <span className="text-border text-xs">or</span>
        <SearchSelect
          label="a Requirement"
          value={fragment?.anchor}
          width={150}
          placeholder="—"
          options={requirements.map((candidate) => ({
            key: candidate.anchor,
            label: fragmentText(candidate),
          }))}
          onChange={set}
        />
        <span className="text-muted-foreground ml-auto text-xs">
          {`${String(requirements.length)} Requirements · ${String(model.rules.length)} Rules`}
        </span>
      </div>

      <div className="pt-5">
        {rule ? <RuleTrace rule={rule} nav={nav} /> : null}
        {fragment ? (
          <FragmentTrace
            fragment={fragment}
            ownerFragments={ownerFragments}
            model={model}
            nav={nav}
          />
        ) : null}
        {!rule && !fragment ? (
          <EmptyState
            label="Pick a Rule or a Requirement to trace"
            hint="Traceability here is a lookup rather than a report. Every edge shown is a stored reference or the labelled reversal of one — nothing is inferred from similarity, ownership or naming."
          />
        ) : null}
      </div>
    </div>
  );
}

function RuleTrace({ rule, nav }: { readonly rule: RuleRow; readonly nav: EntityNav }) {
  return (
    <div className="w-[880px] max-w-full">
      <DocSection label="Rule">
        <div className="py-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs font-medium">{rule.key}</span>
            <span className="text-muted-foreground text-xs">{rule.title}</span>
          </div>
          <p className="text-ledger mt-1">{rule.statement}</p>
        </div>
      </DocSection>

      <DocSection
        label="Named by"
        count={rule.consumerCount}
        hint="Entities whose own document names this Rule. This is the whole of its recorded reach — no descendant is added, because the data does not say the Rule governs one."
      >
        <DefRow label="Epics">
          <KeyList keys={rule.namedByEpics} nav={nav} empty="No Epic names this Rule." />
        </DefRow>
        <DefRow label="Streams">
          <KeyList keys={rule.namedByStreams} nav={nav} empty="No Stream names this Rule." />
        </DefRow>
        <DefRow label="Tasks">
          <KeyList keys={rule.namedByTasks} nav={nav} empty="No Task names this Rule." />
        </DefRow>
      </DocSection>

      <DocSection
        label="Evidence"
        hint="How this Rule was established. Freshness is superseding-based: a Source becomes stale by being explicitly replaced by a newer one, never by getting old."
      >
        <div className="py-2">
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
        </div>
      </DocSection>
    </div>
  );
}

function FragmentTrace({
  fragment,
  ownerFragments,
  model,
  nav,
}: {
  readonly fragment: FragmentEntry;
  readonly ownerFragments: readonly FragmentEntry[];
  readonly model: ProjectModel;
  readonly nav: EntityNav;
}) {
  const owner = model.streamByKey.get(fragment.owner);

  // Read backwards off each criterion's own `verifies` edge: the Requirement stores
  // nothing about who checks it, so this direction is derived and labelled as such.
  const verifiedBy = ownerFragments.filter(
    (candidate) =>
      candidate.section === "acceptance_criteria" && candidate.verifies.includes(fragment.id),
  );
  const implementedBy = fragment.implementedBy;

  return (
    <div className="w-[880px] max-w-full">
      <DocSection label={sectionLabel(fragment.section)}>
        <div className="border-border border-t">
          <SpecFragment fragment={fragment} showOwner />
        </div>
      </DocSection>

      <DocSection
        label="Owner"
        hint="A fragment is contained by its owner and has no existence above it. Its local key is unique only inside that entity."
      >
        <DefRow label="Stream">
          <span className="flex items-baseline gap-2">
            <EntityKey entityKey={fragment.owner} onClick={() => nav.inspect(fragment.owner)} />
            <span className="text-muted-foreground min-w-0 text-xs">{owner?.title}</span>
          </span>
        </DefRow>
        <DefRow label="Epic">
          {owner ? (
            <EntityKey entityKey={owner.epicKey} onClick={() => nav.inspect(owner.epicKey)} />
          ) : (
            <AbsentBox label="unknown" />
          )}
        </DefRow>
      </DocSection>

      <DocSection
        label="Verified by"
        count={verifiedBy.length}
        hint="Acceptance criteria of the same Stream naming this Requirement in their verifies edge. Derived by reversing the criterion's own reference — the Requirement stores nothing about who checks it."
      >
        {verifiedBy.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 py-2">
            {verifiedBy.map((criterion) => (
              <Chip key={criterion.id}>{criterion.anchor}</Chip>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground py-2 text-xs leading-[17px]">
            {`No Acceptance criterion of ${fragment.owner} names this. That is a gap in the recorded verification, not proof that the requirement is unchecked.`}
          </p>
        )}
      </DocSection>

      <DocSection
        label="Implemented by"
        count={implementedBy.length}
        hint="Tasks whose implements edge names this fragment. A real stored reference in both directions — the Task writes it, and this reads it back."
      >
        <div className="py-2">
          <KeyList
            keys={implementedBy}
            nav={nav}
            empty={`No Task of ${fragment.owner} names this.`}
          />
        </div>
      </DocSection>
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
      {[...keys]
        .sort((left, right) => keySequence(left) - keySequence(right))
        .map((key) => (
          <EntityKey key={key} entityKey={key} onClick={() => nav.inspect(key)} />
        ))}
    </span>
  );
}
