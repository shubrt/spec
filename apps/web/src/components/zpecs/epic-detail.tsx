import { Link } from "@tanstack/react-router";
import { SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import {
  Field,
  ListSection,
  Panel,
  PanelTitle,
  ProseSection,
  RuledBlock,
  Section,
} from "~/components/zpecs/document-sections";
import { EntityKey, StatusBadge, StatusDot, TypeTag } from "~/components/zpecs/tokens";
import { asArray, asNumber, asRecord, asText, contentOf } from "~/lib/document";
import { epicStatus, label, streamStatus } from "~/lib/vocabulary";
import type { EpicNode } from "~/server/board";

/**
 * The long-horizon "why" for the streams nested below it. This deliberately
 * renders only sections the epic schema owns; stream requirements and workflows
 * stay in the stream drawer where they can remain bounded and actionable.
 */
export function EpicDetail({ epic }: { epic: EpicNode }) {
  const content = contentOf(epic.document);
  const scope = asRecord(content.scope);
  const included = asArray(scope.included);
  const excluded = asArray(scope.excluded);
  const outcomes = asArray(content.outcomes);
  const metrics = asArray(content.success_metrics);
  const rules = asArray(content.business_rules);

  return (
    <>
      <SheetHeader className="border-b">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <span>Epic</span>
          <EntityKey>{epic.key}</EntityKey>
        </div>
        <SheetTitle>{epic.title}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={epicStatus.toneOf(epic.status)}>{label(epic.status)}</StatusBadge>
            <span className="text-xs text-muted-foreground">revision {epic.revision}</span>
          </div>
        </SheetDescription>
      </SheetHeader>

      <div className="px-6 pb-10 pt-5">
        {epic.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">{epic.summary}</p>
        ) : null}

        <ProseSection title="Purpose" value={content.purpose} />
        <ProseSection title="Business problem" value={content.business_problem} />

        {included.length + excluded.length > 0 ? (
          <Section title="Scope">
            <ScopeLines title="Included" items={included} />
            <ScopeLines title="Excluded" items={excluded} muted />
          </Section>
        ) : null}

        {outcomes.length > 0 ? (
          <Section title="Outcomes">
            {outcomes.map((value, index) => {
              const outcome = asRecord(value);
              return (
                <Panel key={asText(outcome.id) || index}>
                  <PanelTitle id={asText(outcome.id)}>{asText(outcome.outcome)}</PanelTitle>
                  {asText(outcome.indicator) ? (
                    <div className="text-xs text-muted-foreground">
                      Indicator: {asText(outcome.indicator)}
                    </div>
                  ) : null}
                </Panel>
              );
            })}
          </Section>
        ) : null}

        {metrics.length > 0 ? (
          <Section title="Success metrics">
            {metrics.map((value, index) => {
              const metric = asRecord(value);
              return (
                <Panel key={asText(metric.id) || index}>
                  <PanelTitle id={asText(metric.id)}>{asText(metric.metric)}</PanelTitle>
                  <div className="rounded-xl border p-3">
                    {asNumber(metric.baseline) !== null ? (
                      <Field name="baseline">{asNumber(metric.baseline)}</Field>
                    ) : null}
                    <Field name="target">
                      {asText(metric.operator)} {asNumber(metric.target) ?? "—"}{" "}
                      {asText(metric.unit)}
                    </Field>
                  </div>
                </Panel>
              );
            })}
          </Section>
        ) : null}

        {rules.length > 0 ? (
          <Section title="Business rules">
            {rules.map((value, index) => {
              const rule = asRecord(value);
              return (
                <RuledBlock key={asText(rule.id) || index} label={asText(rule.id)}>
                  <div className="text-[13px] leading-relaxed">{asText(rule.rule)}</div>
                  {asText(rule.impact) ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Impact: {asText(rule.impact)}
                    </div>
                  ) : null}
                  {asText(rule.consequence) ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      → {asText(rule.consequence)}
                    </div>
                  ) : null}
                </RuledBlock>
              );
            })}
          </Section>
        ) : null}

        <ListSection title="Open questions" items={asArray(content.open_questions)} />
        <ListSection title="Assumptions" items={asArray(content.assumptions)} muted />

        {epic.streams.length > 0 ? (
          <Section title={`Streams · ${epic.streams.length}`}>
            {epic.streams.map((stream) => (
              <Link
                key={stream.id}
                to="."
                search={(prev) => ({
                  project: prev.project,
                  workspace: prev.workspace,
                  stream: stream.id,
                })}
                className="flex items-center gap-3 border-t py-2.5 text-left first:border-t-0 hover:bg-secondary/50"
              >
                <StatusDot tone={streamStatus.toneOf(stream.status)} />
                <EntityKey>{stream.key}</EntityKey>
                <span className="flex-1 text-[13px] font-medium">{stream.title}</span>
                <TypeTag>{label(stream.streamType)}</TypeTag>
              </Link>
            ))}
          </Section>
        ) : null}
      </div>
    </>
  );
}

function ScopeLines({ title, items, muted }: { title: string; items: unknown[]; muted?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={title === "Excluded" ? "mt-3" : undefined}>
      <div
        className={`mb-1 text-xs font-semibold ${muted ? "text-muted-foreground" : "text-secondary-foreground"}`}
      >
        {title}
      </div>
      <ul>
        {items.map((value, index) => {
          const item = asRecord(value);
          return (
            <li
              key={asText(item.id) || index}
              className={`flex gap-2 py-1.5 text-sm ${muted ? "text-muted-foreground" : "text-secondary-foreground"}`}
            >
              {asText(item.id) ? (
                <span className="rule-tag flex-none">{asText(item.id)}</span>
              ) : null}
              <span>{asText(item.statement)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
