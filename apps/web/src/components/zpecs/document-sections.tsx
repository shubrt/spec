import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEntityDetailSurface } from "~/components/zpecs/entity-detail-surface";
import { SectionId } from "~/components/zpecs/tokens";
import { asArray, asRecord, asText, type RuleApplication } from "~/lib/document";

/**
 * The presentational vocabulary the two detail views share.
 *
 * Every one of these renders nothing when it has nothing, which is the rule the
 * brief sets for the drawer: not every stream type has every section, so an
 * empty heading would tell a reader a section exists and is blank when in fact
 * the schema never had it. `Section` is therefore the only place a heading is
 * emitted, and it is only reached once its content is known to be non-empty.
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const Heading = useEntityDetailSurface() === "page" ? "h2" : "h3";

  return (
    <section className="mb-6">
      <Heading className="mb-3 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </Heading>
      {children}
    </section>
  );
}

/**
 * A section that disappears when its value is absent or not a string.
 *
 * The coercion matters as much as the emptiness check: `document` is passed
 * through unvalidated, so a field that should hold prose may hold an object, and
 * an object reaching JSX takes the whole drawer down.
 */
export function ProseSection({ title, value }: { title: string; value: unknown }) {
  const text = asText(value);
  if (!text) return null;
  return (
    <Section title={title}>
      <p className="text-sm leading-relaxed text-secondary-foreground">{text}</p>
    </Section>
  );
}

/** A free-text list section — steps, prerequisites, artifacts, assumptions. */
export function ListSection({
  title,
  items,
  ordered,
  muted,
}: {
  title: string;
  items: unknown[];
  ordered?: boolean;
  muted?: boolean;
}) {
  const texts = items.map(asText).filter(Boolean);
  if (texts.length === 0) return null;
  return (
    <Section title={title}>
      {ordered ? <OrderedList items={texts} /> : <BulletList items={texts} muted={muted} />}
    </Section>
  );
}

export function BulletList({ items, muted }: { items: string[]; muted?: boolean }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li
          key={index}
          className={`relative py-1.5 pl-4 text-sm before:absolute before:left-0.5 before:top-3 before:size-[5px] before:rounded-full before:bg-border ${
            muted ? "text-muted-foreground" : "text-secondary-foreground"
          }`}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

export function OrderedList({ items }: { items: string[] }) {
  return (
    <ol className="list-none [counter-reset:n]">
      {items.map((item, index) => (
        <li
          key={index}
          className="relative border-t py-2 pl-[30px] text-sm text-secondary-foreground first:border-t-0 [counter-increment:n] before:absolute before:left-0 before:top-2 before:flex before:size-[19px] before:items-center before:justify-center before:rounded-md before:bg-secondary before:text-[11px] before:font-semibold before:text-muted-foreground before:[content:counter(n)]"
        >
          {item}
        </li>
      ))}
    </ol>
  );
}

/** Structured unknowns shared by every v2 document that can carry them. */
export function UnknownsSections({
  questions,
  assumptions,
}: {
  questions: unknown;
  assumptions: unknown;
}) {
  const questionItems = asArray(questions).map(asRecord);
  const assumptionItems = asArray(assumptions).map(asRecord);
  return (
    <>
      {questionItems.length > 0 ? (
        <Section title="Open questions">
          {questionItems.map((question, index) => (
            <Panel key={asText(question.id) || index}>
              <PanelTitle id={asText(question.id)}>{asText(question.question)}</PanelTitle>
            </Panel>
          ))}
        </Section>
      ) : null}
      {assumptionItems.length > 0 ? (
        <Section title="Assumptions">
          {assumptionItems.map((assumption, index) => {
            const sourceIds = asArray(assumption.source_ids).map(asText).filter(Boolean);
            return (
              <Panel key={asText(assumption.id) || index}>
                <PanelTitle id={asText(assumption.id)}>{asText(assumption.statement)}</PanelTitle>
                {sourceIds.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Sources: {sourceIds.join(", ")}
                  </div>
                ) : null}
              </Panel>
            );
          })}
        </Section>
      ) : null}
    </>
  );
}

/** A bordered block, used wherever one item of a structured list needs grouping. */
export function Panel({ children }: { children: ReactNode }) {
  return <div className="mb-3 rounded-xl border p-4">{children}</div>;
}

/** A panel heading that may carry a section id such as `WF-1` or `EC-2`. */
export function PanelTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold">
      {id ? <SectionId>{id}</SectionId> : null}
      {children}
    </div>
  );
}

/** A checkbox-shaped row for anything a reviewer ticks off: a criterion, a done-when line. */
export function Criterion({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 border-t py-2.5 text-[13px] leading-relaxed text-secondary-foreground first:border-t-0">
      <span className="mt-0.5 size-[17px] flex-none rounded-[5px] border-[1.6px] border-input" />
      <div>
        {id ? <SectionId>{id}</SectionId> : null}
        {id ? " " : null}
        {children}
      </div>
    </div>
  );
}

/** A `key → value` row for the flat named lists (technical scope, execution). */
export function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t py-2 text-[13px] first:border-t-0">
      <span className="font-mono text-muted-foreground">{name}</span>
      <span className="max-w-[60%] text-right text-secondary-foreground">{children}</span>
    </div>
  );
}

/**
 * A left-ruled block for a rule or a decision.
 */
export function RuledBlock({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3.5 border-l-[3px] border-accent pl-3.5">
      {label ? (
        <div className="mb-1 font-mono text-[11px] font-medium text-primary">{label}</div>
      ) : null}
      {children}
    </div>
  );
}

/** Local context for canonical project Rules, without duplicating their text. */
export function RuleApplicationsSection({ applications }: { applications: RuleApplication[] }) {
  if (applications.length === 0) return null;

  return (
    <Section title="Rule applications">
      {applications.map((application, index) => {
        const id = asText(application.id);
        const ruleKey = asText(application.rule_key);
        const appliesWhen = asText(application.applies_when);
        const localApplication = asText(application.application);
        const reference = [ruleKey, id].filter(Boolean).join(" · ");

        return (
          <RuledBlock
            key={id || `${ruleKey}-${index}`}
            label={
              ruleKey ? (
                <Link
                  to="/rule/$ruleKey"
                  params={{ ruleKey }}
                  search={(previous) => ({
                    project: previous.project,
                    workspace: previous.workspace,
                  })}
                  className="hover:underline"
                >
                  {reference}
                </Link>
              ) : (
                reference || undefined
              )
            }
          >
            {localApplication ? (
              <div className="text-[13px] leading-relaxed">{localApplication}</div>
            ) : null}
            {appliesWhen ? (
              <div className="mt-1 text-xs text-muted-foreground">Applies when: {appliesWhen}</div>
            ) : null}
          </RuledBlock>
        );
      })}
    </Section>
  );
}
