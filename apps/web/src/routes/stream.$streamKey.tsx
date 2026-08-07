import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailPage } from "~/components/zpecs/entity-detail-page";

export const Route = createFileRoute("/stream/$streamKey")({
  component: StreamPage,
});

function StreamPage() {
  const { streamKey } = Route.useParams();
  return <EntityDetailPage entity={{ kind: "stream", key: streamKey }} />;
}
