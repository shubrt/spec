import type { RevisionEntry } from "~/lib/revisions";
import { cn } from "~/lib/utils";
import type { BoxTone } from "./box";

/**
 * The structural diff of one revision.
 *
 * The before value is plain and only the after value carries colour — green when a
 * section gained entries, red when it lost them. Nothing else in the row is
 * coloured, so direction is the only thing the eye has to pick up.
 *
 * The three empty cases each say something different, and the difference matters:
 * a first revision has nothing to compare against, a status-only revision left the
 * document alone, and a revision with no section movement changed wording inside a
 * clause — or changed a field that is a column rather than document JSON, which
 * this projection genuinely cannot see.
 */

const KIND_TONE = {
  created: "info",
  status: "warning",
  structure: "neutral",
  text: "quiet",
} as const satisfies Record<RevisionEntry["kind"], BoxTone>;

const KIND_LABEL = {
  created: "Created",
  status: "Status",
  structure: "Structure",
  text: "Text only",
} as const satisfies Record<RevisionEntry["kind"], string>;

export function revisionKindTone(kind: RevisionEntry["kind"]): BoxTone {
  return KIND_TONE[kind];
}

export function revisionKindLabel(kind: RevisionEntry["kind"]): string {
  return KIND_LABEL[kind];
}

function DeltaRow({
  section,
  from,
  to,
}: {
  readonly section: string;
  readonly from: number;
  readonly to: number;
}) {
  const change = to - from;
  const tone = change > 0 ? "text-success" : change < 0 ? "text-danger" : "text-muted-foreground";
  return (
    <div className="border-border flex items-baseline gap-2 border-b py-1.5">
      <span className="min-w-0 flex-1 font-mono text-[11px]">
        {section.replaceAll("_", " ").replaceAll(".", " · ")}
      </span>
      <span className="font-mono text-xs tabular-nums">
        <span className="text-foreground">{from}</span>
        <span className="text-border px-1">→</span>
        <span className={cn(tone, "font-medium")}>{to}</span>
      </span>
      <span className={cn("w-9 shrink-0 text-right font-mono text-[11px] tabular-nums", tone)}>
        {change > 0 ? `+${String(change)}` : change < 0 ? String(change) : "±0"}
      </span>
    </div>
  );
}

export function RevisionDiff({ entry }: { readonly entry: RevisionEntry }) {
  if (entry.sectionDeltas.length > 0) {
    const grew = entry.sectionDeltas.filter((delta) => delta.to > delta.from).length;
    const shrank = entry.sectionDeltas.filter((delta) => delta.to < delta.from).length;
    return (
      <>
        <p className="text-muted-foreground mb-1.5 text-xs">
          {`entries before → after · ${String(grew)} section${grew === 1 ? "" : "s"} gained, ${String(shrank)} lost`}
        </p>
        <div className="border-border border-t">
          {entry.sectionDeltas.map((delta) => (
            <DeltaRow key={delta.section} section={delta.section} from={delta.from} to={delta.to} />
          ))}
        </div>
      </>
    );
  }

  if (entry.kind === "created") {
    return (
      <p className="text-muted-foreground text-xs leading-[17px]">
        The first revision. There is no earlier state to differ from, so every section it holds
        arrived here.
      </p>
    );
  }

  if (entry.kind === "status") {
    return (
      <p className="text-muted-foreground text-xs leading-[17px]">
        Only the status moved. The document itself is unchanged.
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-xs leading-[17px]">
      No section gained or lost an entry. The revision exists, so something changed — wording inside
      an existing clause, or a field outside the document such as the Milestone assignment or the
      Roadmap rank. Those live in columns rather than in document JSON, and this projection cannot
      see them.
    </p>
  );
}
