import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailPage } from "~/components/zpecs/entity-detail-page";

export const Route = createFileRoute("/milestone/$milestoneKey")({
  component: MilestonePage,
});

function MilestonePage() {
  const { milestoneKey } = Route.useParams();
  return <EntityDetailPage entity={{ kind: "milestone", key: milestoneKey }} />;
}
