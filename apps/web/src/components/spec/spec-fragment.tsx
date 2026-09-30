import { useState, type ReactNode } from "react";
import {
  fragmentAnchor,
  isTargetable,
  sectionLabel,
  type SectionId,
  type SpecFragmentModel,
} from "~/lib/fragments";
import { cn } from "~/lib/utils";
import { label } from "~/lib/vocabulary";
import { Box, type BoxTone } from "./box";
import { Chip, EntityKey } from "./parts";

/**
 * One specification fragment, in whichever of the five shapes its section calls
 * for. See `lib/fragments.ts` for why there are five and not twenty-six.
 *
 * ## The key is the anchor and the copy control at once
 *
 * Clicking `FR-1` copies `S-1#FR-1`, and the title attribute shows what will be
 * copied. That replaced a second line under every fragment reading `S-1#FR-1
 * COPY`, which doubled the height of the document for one affordance.
 *
 * `showOwner` prints the whole anchor instead of the local key. Inside its own
 * document the owner is the page you are on and repeating it is noise; on a Task
 * page the fragment belongs to somebody else, and a local key without its owner
 * is not unique — `CHG-1` exists in as many Streams as have a change target.
 *
 * ## Where things sit
 *
 * A property of the statement rides at its right edge. A reference to something
 * else is a labelled row underneath, so Verifies and Implemented by read as
 * relations rather than as tags. Prose the fragment owns — an indicator, a
 * measurement, a finish condition — is a labelled detail line in the same place.
 *
 * ## No checkboxes
 *
 * Deliberately not adopted: in a read-only surface a checkbox promises you can
 * tick it. Whether a requirement is carried is answered by its implemented-by
 * row, which is a fact about the data rather than a control that does nothing.
 */

/** `dense` is the 440 px drawer: relations drop away, because the page carries them. */
export interface SpecFragmentProps {
  readonly fragment: SpecFragmentModel;
  /** Tasks whose `implements` edge names this fragment. `null` hides the row entirely. */
  readonly implementedBy?: readonly string[] | null;
  readonly onOpenEntity?: (key: string) => void;
  readonly dense?: boolean;
  readonly showOwner?: boolean;
}

const SEVERITY_TONE: Record<string, BoxTone> = {
  critical: "danger",
  high: "warning",
  medium: "neutral",
  low: "quiet",
};

const EXIT_STATE_TONE: Record<string, BoxTone> = {
  met: "success",
  waived: "dashed",
  open: "quiet",
};

/** MoSCoW: `must` is binding, the other three are not, so only `must` is loud. */
const REQUIREMENT_PRIORITY_TONE: Record<string, BoxTone> = {
  must: "neutral",
  should: "quiet",
  could: "quiet",
  wont: "struck",
};

function SpecAnchor({
  owner,
  id,
  dense,
  showOwner,
}: {
  readonly owner: string;
  readonly id: string;
  readonly dense: boolean;
  readonly showOwner: boolean;
}) {
  const [done, setDone] = useState(false);
  const anchor = fragmentAnchor(owner, id);
  return (
    <button
      type="button"
      title={`Copy ${anchor}`}
      aria-label={`Copy link to ${anchor}`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(anchor);
        setDone(true);
        setTimeout(() => setDone(false), 1000);
      }}
      className={cn(
        "hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-left font-mono font-medium underline decoration-transparent underline-offset-2 outline-none transition-colors hover:decoration-current focus-visible:ring-2",
        showOwner ? "w-[104px] text-xs" : dense ? "w-[58px] text-[11px]" : "w-[70px] text-xs",
        done ? "text-success" : "",
      )}
    >
      {done ? "copied" : showOwner ? anchor : id}
    </button>
  );
}

/** A labelled relation row — it points somewhere else. */
function SpecRelation({
  label: rowLabel,
  indent,
  children,
}: {
  readonly label: string;
  readonly indent: number;
  readonly children: ReactNode;
}) {
  return (
    <div className="mt-1 flex items-baseline gap-2" style={{ paddingLeft: indent }}>
      <span className="text-muted-foreground w-[92px] shrink-0 text-[11px]">{rowLabel}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</span>
    </div>
  );
}

/** One labelled line of a Given/When/Then criterion. */
function SpecLine({
  label: lineLabel,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-muted-foreground w-[42px] shrink-0 pt-px font-mono text-[10px] uppercase tracking-wide">
        {lineLabel}
      </span>
      <span className="text-ledger min-w-0 flex-1">{children}</span>
    </div>
  );
}

function SpecBody({ fragment }: { readonly fragment: SpecFragmentModel }) {
  const { shape } = fragment;

  if (shape.kind === "criterion") {
    return (
      <div className="min-w-0 flex-1">
        <SpecLine label="Given">{shape.given}</SpecLine>
        <SpecLine label="When">{shape.when}</SpecLine>
        <SpecLine label="Then">{shape.then}</SpecLine>
      </div>
    );
  }

  if (shape.kind === "condition") {
    return (
      <div className="min-w-0 flex-1">
        <p className="text-ledger">{shape.condition}</p>
        <p className="text-ledger mt-1 flex gap-2">
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">→</span>
          <span className="min-w-0">{shape.outcome}</span>
        </p>
      </div>
    );
  }

  if (shape.kind === "transition") {
    return (
      <div className="min-w-0 flex-1">
        {shape.preamble ? (
          <div className="text-muted-foreground mb-1 text-xs leading-[17px]">
            <span className="font-mono text-[10px] uppercase">{shape.preamble.label}</span>
            {shape.preamble.items.length === 1 ? (
              <span className="ml-1.5">{shape.preamble.items[0]}</span>
            ) : (
              <ol className="mt-0.5 list-inside list-decimal">
                {shape.preamble.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            )}
          </div>
        ) : null}
        {/* is → to be, stacked rather than side by side: the two states are often a
            sentence each, and two columns would wrap both into unreadable slivers. */}
        <div className="border-border overflow-hidden rounded-sm border">
          <div className="border-border text-muted-foreground border-b px-2 py-1.5 text-xs leading-[17px]">
            <span className="mr-1.5 font-mono text-[10px] uppercase">is</span>
            {shape.from}
          </div>
          <div className="text-ledger px-2 py-1.5">
            <span className="text-muted-foreground mr-1.5 font-mono text-[10px] uppercase">
              to be
            </span>
            {shape.to}
          </div>
        </div>
      </div>
    );
  }

  if (shape.kind === "workflow") {
    return (
      <div className="min-w-0 flex-1">
        {shape.actor ? (
          <p className="text-muted-foreground mb-1.5 text-xs">
            <span className="font-mono text-[10px] uppercase">actor</span> {shape.actor}
          </p>
        ) : null}
        {shape.preconditions.length > 0 ? (
          <p className="text-muted-foreground mb-1.5 text-xs leading-[17px]">
            <span className="font-mono text-[10px] uppercase">before</span>{" "}
            {shape.preconditions.join("; ")}
          </p>
        ) : null}
        <div className="border-border rounded-sm border">
          {shape.steps.map((step) => (
            <div
              key={step.id}
              className="border-border flex gap-2.5 border-b px-2 py-1.5 last:border-0"
            >
              <span
                title={step.id}
                className="border-border text-muted-foreground mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px]"
              >
                {step.id.slice(step.id.indexOf("-") + 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-ledger block">{step.action}</span>
                {step.result ? (
                  <span className="text-muted-foreground mt-0.5 block text-xs leading-[17px]">
                    → {step.result}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <p className="text-ledger min-w-0 flex-1">{shape.text}</p>;
}

export function SpecFragment({
  fragment,
  implementedBy,
  onOpenEntity,
  dense = false,
  showOwner = false,
}: SpecFragmentProps) {
  const indent = showOwner ? 112 : dense ? 66 : 78;
  const { marks, evidence } = fragment;

  const markBoxes = (
    <>
      {marks.priority ? (
        <Box tone={REQUIREMENT_PRIORITY_TONE[marks.priority] ?? "quiet"}>{marks.priority}</Box>
      ) : null}
      {marks.severity ? (
        <Box tone={SEVERITY_TONE[marks.severity] ?? "neutral"}>{marks.severity}</Box>
      ) : null}
      {marks.state ? <Box tone={EXIT_STATE_TONE[marks.state] ?? "quiet"}>{marks.state}</Box> : null}
      {marks.category ? <Box tone="quiet">{marks.category}</Box> : null}
      {marks.method ? <Box tone="quiet">{label(marks.method)}</Box> : null}
    </>
  );
  const hasMarks =
    marks.priority !== null ||
    marks.severity !== null ||
    marks.state !== null ||
    marks.category !== null ||
    marks.method !== null;

  const showRelations = !dense;

  return (
    <div
      id={`frag-${fragment.id}`}
      className="border-border scroll-mt-4 border-b py-2.5 last:border-0"
    >
      <div className="flex items-baseline gap-2">
        <SpecAnchor owner={fragment.owner} id={fragment.id} dense={dense} showOwner={showOwner} />
        <SpecBody fragment={fragment} />
        {hasMarks ? (
          <span className="flex shrink-0 items-center gap-1.5 pl-2">{markBoxes}</span>
        ) : null}
      </div>

      {showRelations
        ? fragment.details.map((line) => (
            <SpecRelation key={line.label} label={line.label} indent={indent}>
              <span className="text-muted-foreground text-xs leading-[17px]">{line.text}</span>
            </SpecRelation>
          ))
        : null}

      {showRelations && fragment.verifies.length > 0 ? (
        <SpecRelation label="Verifies" indent={indent}>
          {fragment.verifies.map((target) => (
            <Chip key={target}>{target}</Chip>
          ))}
        </SpecRelation>
      ) : null}

      {/* Only where a Task could actually point. A section outside the targetable
          namespaces has no `implements` field to be named by, so an empty row here
          would report an absence that is structurally impossible. */}
      {showRelations && implementedBy && onOpenEntity && isTargetable(fragment.section) ? (
        <SpecRelation label="Implemented by" indent={indent}>
          {implementedBy.length > 0 ? (
            implementedBy.map((taskKey) => (
              <EntityKey
                key={taskKey}
                entityKey={taskKey}
                className="text-muted-foreground"
                onClick={() => onOpenEntity(taskKey)}
              />
            ))
          ) : (
            // A fact about the references, not a verdict on the work — and the
            // wording says which of the two it is.
            <span className="text-muted-foreground text-[11px]">no Task implements this</span>
          )}
        </SpecRelation>
      ) : null}

      {showRelations && evidence ? (
        <SpecRelation label="Evidence" indent={indent}>
          <Box tone="dashed">{evidence.basis}</Box>
          {evidence.sourceIds.map((sourceId) => (
            <Chip key={sourceId} variant="dotted">
              {sourceId}
            </Chip>
          ))}
        </SpecRelation>
      ) : null}
    </div>
  );
}

/**
 * The section navigator: sticky, horizontal, and it filters rather than only
 * jumping. It replaced a vertical table of contents and gave its 192 px back to
 * the document.
 */
export function SectionChips({
  sections,
  active,
  counts,
  onPick,
}: {
  readonly sections: readonly SectionId[];
  readonly active: SectionId | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly onPick: (section: SectionId | null) => void;
}) {
  const total = sections.reduce((sum, section) => sum + (counts[section] ?? 0), 0);
  return (
    <div className="bg-background border-border sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b py-2">
      <button
        type="button"
        onClick={() => onPick(null)}
        className={cn(
          "border-input hover:bg-muted focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none focus-visible:ring-2",
          active === null ? "bg-accent border-border-strong" : "",
        )}
      >
        All
        <span className="font-mono text-[11px] tabular-nums opacity-70">{total}</span>
      </button>
      {sections.map((section) => (
        <button
          key={section}
          type="button"
          onClick={() => onPick(active === section ? null : section)}
          className={cn(
            "border-input hover:bg-muted focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none focus-visible:ring-2",
            active === section ? "bg-accent border-border-strong" : "",
          )}
        >
          {sectionLabel(section)}
          <span className="font-mono text-[11px] tabular-nums opacity-70">
            {counts[section] ?? 0}
          </span>
        </button>
      ))}
    </div>
  );
}
