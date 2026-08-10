import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailPage } from "~/components/zpecs/entity-detail-page";

export const Route = createFileRoute("/rule/$ruleKey")({
  component: RulePage,
});

function RulePage() {
  const { ruleKey } = Route.useParams();
  return <EntityDetailPage entity={{ kind: "rule", key: ruleKey }} />;
}
