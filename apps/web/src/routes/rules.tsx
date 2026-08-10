import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Card } from "~/components/ui/card";
import { BoardFailure, EmptyWorkspace } from "~/components/zpecs/board-failure";
import { Toolbar } from "~/components/zpecs/toolbar";
import { EntityKey, StatusBadge } from "~/components/zpecs/tokens";
import { asText, contentOf } from "~/lib/document";
import { indexRuleUses, ruleConsumerCount } from "~/lib/ruleUsage";
import { label, ruleStatus, type RuleStatus } from "~/lib/vocabulary";
import type { EpicNode, RuleNode } from "~/server/board";

const ANY_STATUS = "any" as const;

export const Route = createFileRoute("/rules")({
  component: RulesPage,
});

function RulesPage() {
  const board = useLoaderData({ from: "__root__" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RuleStatus | typeof ANY_STATUS>(ANY_STATUS);

  if (board.status !== "ok") return <BoardFailure failure={board} />;
  if (!board.aggregate) return <EmptyWorkspace workspaceName={board.workspace.name} />;

  const { rules, epics, project } = board.aggregate;
  const normalized = query.trim().toLocaleLowerCase();
  const shown = rules.filter((rule) => {
    if (statusFilter !== ANY_STATUS && rule.status !== statusFilter) return false;
    if (!normalized) return true;
    const content = contentOf(rule.document);
    return [rule.key, rule.title, rule.summary ?? "", asText(content.statement)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized);
  });

  return (
    <>
      <Toolbar title="Rules">
        <Input
          placeholder="Search Rules…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-64"
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as RuleStatus | typeof ANY_STATUS)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>All Rules</SelectItem>
            {ruleStatus.values.map((status) => (
              <SelectItem key={status} value={status}>
                {label(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <span className="text-sm tabular-nums text-muted-foreground">
          {shown.length} of {rules.length}
        </span>
      </Toolbar>

      <div className="px-8 pb-16 pt-6">
        <RuleCatalogue rules={shown} epics={epics} projectId={project.id} />
      </div>
    </>
  );
}

function RuleCatalogue({
  rules,
  epics,
  projectId,
}: {
  rules: readonly RuleNode[];
  epics: readonly EpicNode[];
  projectId: string;
}) {
  if (rules.length === 0) {
    return (
      <div className="p-16 text-center text-sm text-muted-foreground">
        No Rules match these filters.
      </div>
    );
  }

  const usage = indexRuleUses(epics);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {rules.map((rule) => {
        const statement = asText(contentOf(rule.document).statement);
        const consumerCount = ruleConsumerCount(usage.get(rule.key) ?? []);
        return (
          <Card key={rule.id} className="flex flex-col overflow-hidden">
            <Link
              to="/rule/$ruleKey"
              params={{ ruleKey: rule.key }}
              search={(previous) => ({ project: projectId, workspace: previous.workspace })}
              className="flex flex-1 flex-col p-4 transition-colors hover:bg-secondary/40"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <EntityKey>{rule.key}</EntityKey>
                <span className="flex-1 font-bold tracking-tight">{rule.title}</span>
                <StatusBadge tone={ruleStatus.toneOf(rule.status)}>
                  {label(rule.status)}
                </StatusBadge>
              </div>
              {statement || rule.summary ? (
                <p className="mt-3 flex-1 text-sm leading-relaxed text-secondary-foreground">
                  {statement || rule.summary}
                </p>
              ) : null}
              <div className="mt-4 text-xs text-muted-foreground">
                {consumerCount === 0
                  ? "Not referenced"
                  : `Used in ${String(consumerCount)} ${consumerCount === 1 ? "entity" : "entities"}`}
                <span> · revision {rule.revision}</span>
              </div>
            </Link>
          </Card>
        );
      })}
    </div>
  );
}
