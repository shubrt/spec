import { Link } from "@tanstack/react-router";
import { SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import {
  Criterion,
  Field,
  ListSection,
  Panel,
  PanelTitle,
  ProseSection,
  RuledBlock,
  Section,
} from "~/components/zpecs/document-sections";
import { EntityKey, SectionId, StatusBadge, TypeTag } from "~/components/zpecs/tokens";
import {
  asArray,
  asRecord,
  asText,
  contentOf,
  jsonToText,
  type TaskVerification,
  type TechnicalDecision,
} from "~/lib/document";
import { label, taskStatus } from "~/lib/vocabulary";
import type { StreamNode, TaskNode } from "~/server/board";

/**
 * Task detail — the task document.
 *
 * A task is the technical "how". It carries no business requirements of its own;
 * it *references* the parent stream's through `implements`, which is why the
 * traceability ids get their own section rather than being buried.
 *
 * `execution` is a sibling of `content` in the envelope, not part of it, because
 * it is operational rather than specifying — re-estimating a task does not change
 * what the task says to build. It is rendered last for the same reason.
 */

export function TaskDetail({ task, stream }: { task: TaskNode; stream: StreamNode | undefined }) {
  const content = contentOf(task.document);

  const implementsRef = asRecord(content.implements);
  const requirementIds = asArray(implementsRef.requirement_ids).map(asText).filter(Boolean);
  const criteriaIds = asArray(implementsRef.acceptance_criteria_ids).map(asText).filter(Boolean);

  const technicalScope = Object.entries(asRecord(content.technical_scope));
  const implementation = asRecord(content.implementation);
  const decisions = asArray<TechnicalDecision>(implementation.technical_decisions);
  const verifications = asArray<TaskVerification>(content.verification);

  // A sibling of `content`, so read from the envelope rather than through it.
  const execution = Object.entries(asRecord(task.document.execution));

  return (
    <>
      <SheetHeader className="border-b">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <span>Task</span>
          <EntityKey>{task.key}</EntityKey>
          <TypeTag>{label(task.taskType)}</TypeTag>
        </div>
        <SheetTitle>{task.title}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={taskStatus.toneOf(task.status)}>{label(task.status)}</StatusBadge>
            <span className="text-xs text-muted-foreground">revision {task.revision}</span>
            {stream ? (
              <>
                <span className="text-xs text-muted-foreground">in</span>
                <Link
                  to="."
                  search={(prev) => ({ project: prev.project, stream: stream.id })}
                  className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground hover:underline"
                >
                  {stream.key} {stream.title}
                </Link>
              </>
            ) : null}
          </div>
        </SheetDescription>
      </SheetHeader>

      <div className="px-6 pb-10 pt-5">
        {task.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">{task.summary}</p>
        ) : null}

        <ProseSection title="Objective" value={content.objective} />

        {requirementIds.length + criteriaIds.length > 0 ? (
          <Section title="Implements">
            {/* The link back to the business "what". A task with no reference to a
                requirement is the failure the readiness gate exists to catch, so
                when the reference is there it is worth showing plainly. */}
            <div className="flex flex-wrap gap-1.5">
              {[...requirementIds, ...criteriaIds].map((id) => (
                <SectionId key={id}>{id}</SectionId>
              ))}
            </div>
          </Section>
        ) : null}

        <ProseSection title="Approach" value={implementation.approach} />
        <ListSection title="Steps" items={asArray(implementation.steps)} ordered />

        {decisions.length > 0 ? (
          <Section title="Technical decisions">
            {decisions.map((decision, index) => (
              <RuledBlock key={index}>
                <div className="text-[13px] leading-relaxed">{asText(decision.decision)}</div>
                {/* The reason is the half that makes a decision reviewable. */}
                {decision.reason ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Because {asText(decision.reason)}
                  </div>
                ) : null}
                {asArray(decision.alternatives_considered).length > 0 ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Considered: {asArray(decision.alternatives_considered).map(asText).join("; ")}
                  </div>
                ) : null}
              </RuledBlock>
            ))}
          </Section>
        ) : null}

        {technicalScope.length > 0 ? (
          <Section title="Technical scope">
            {/* Rendered from whatever keys are present rather than a fixed list:
                these are five plain name lists, and iterating them cannot omit
                one the way a hand-written set of fields could. */}
            <div className="rounded-xl border p-4">
              {technicalScope.map(([name, value]) => (
                <Field key={name} name={name}>
                  {jsonToText(value)}
                </Field>
              ))}
            </div>
          </Section>
        ) : null}

        <ListSection title="Dependencies" items={asArray(content.dependencies)} />

        {verifications.length > 0 ? (
          <Section title="Verification">
            {verifications.map((verification, index) => (
              <Panel key={verification.id ?? index}>
                <PanelTitle id={verification.id}>
                  {verification.type ? label(asText(verification.type)) : "Check"}
                </PanelTitle>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Procedure</span>
                  <span className="text-secondary-foreground">
                    {asText(verification.procedure)}
                  </span>
                  <span className="text-muted-foreground">Expected</span>
                  <span className="text-secondary-foreground">{asText(verification.expected)}</span>
                </div>
              </Panel>
            ))}
          </Section>
        ) : null}

        {asArray(content.done_when).length > 0 ? (
          <Section title="Done when">
            {asArray(content.done_when)
              .map(asText)
              .filter(Boolean)
              .map((line, index) => (
                <Criterion key={index}>{line}</Criterion>
              ))}
          </Section>
        ) : null}

        <ListSection title="Artifacts" items={asArray(content.artifacts)} />
        <ListSection title="Open questions" items={asArray(content.open_questions)} />

        {execution.length > 0 ? (
          <Section title="Execution">
            <div className="rounded-xl border p-4">
              {execution.map(([name, value]) => (
                <Field key={name} name={name}>
                  {jsonToText(value)}
                </Field>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </>
  );
}
