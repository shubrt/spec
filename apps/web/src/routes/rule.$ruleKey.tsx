import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/rule/R-57` → `/rules?rule=R-57`.
 *
 * A Rule has no page of its own. Everything it holds — statement, rationale,
 * impact, consequence, evidence and its named consumers — fits in one expandable
 * row on the Rules table, and a dedicated page would be that row with more
 * whitespace and one navigation away from the hundred others you are comparing it
 * against.
 *
 * The address stays live rather than 404-ing, because `/rule/R-57` was a real,
 * shareable URL and links to it exist. It lands on the table filtered to that Rule
 * with the row open, which is strictly more than the page showed.
 */
export const Route = createFileRoute("/rule/$ruleKey")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/rules", search: { ...search, rule: params.ruleKey } });
  },
});
