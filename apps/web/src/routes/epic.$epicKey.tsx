import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailPage } from "~/components/zpecs/entity-detail-page";

export const Route = createFileRoute("/epic/$epicKey")({
  component: EpicPage,
});

function EpicPage() {
  const { epicKey } = Route.useParams();
  return <EntityDetailPage entity={{ kind: "epic", key: epicKey }} />;
}
