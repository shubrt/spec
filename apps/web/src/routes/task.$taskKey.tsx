import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailPage } from "~/components/zpecs/entity-detail-page";

export const Route = createFileRoute("/task/$taskKey")({
  component: TaskPage,
});

function TaskPage() {
  const { taskKey } = Route.useParams();
  return <EntityDetailPage entity={{ kind: "task", key: taskKey }} />;
}
