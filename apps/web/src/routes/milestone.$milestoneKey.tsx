import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/milestone/M-1` → `/roadmap?milestone=M-1`.
 *
 * A Milestone is an advisory overlay, not an ownership tier, and its exit criteria
 * only mean anything beside the Streams assigned to it. On its own page those
 * Streams would be a list quoted out of the Roadmap; on the Roadmap they are the
 * Roadmap, filtered.
 *
 * The address stays live rather than 404-ing, because `/milestone/M-1` was a real,
 * shareable URL. It lands on the Roadmap narrowed to that section.
 */
export const Route = createFileRoute("/milestone/$milestoneKey")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/roadmap",
      search: { ...search, milestone: params.milestoneKey, tab: "plan" as const },
    });
  },
});
