import { createFileRoute } from "@tanstack/react-router";

// Placeholder so `/` resolves and `<Link to="/">` type-checks against the
// generated route tree. The project overview (C4) replaces this component.
export const Route = createFileRoute("/")({
  component: () => (
    <div className="p-16 text-sm text-muted-foreground">
      The project overview has not been built yet.
    </div>
  ),
});
