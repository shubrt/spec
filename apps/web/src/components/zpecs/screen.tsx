import type { ReactNode } from "react";
import { isEmptyProject, useBoardState, useMcpEndpoint } from "~/lib/boardState";
import type { ProjectModel } from "~/lib/model";
import { BoardFailure, EmptyProject, NoProject } from "./states";

/**
 * The four states every screen shares, resolved once.
 *
 * An empty Project replaces the whole surface rather than each screen rendering
 * its own version of nothing: every screen in the sidebar would show the same
 * emptiness, and making someone visit ten of them to establish that is worse than
 * one page that says it and names the next move.
 *
 * `allowEmpty` is for the screens that still mean something in an empty Project —
 * Settings and Connection are about the workspace and the endpoint, neither of
 * which depends on there being any content.
 */
export function Screen({
  allowEmpty = false,
  children,
}: {
  readonly allowEmpty?: boolean;
  readonly children: (model: ProjectModel) => ReactNode;
}) {
  const state = useBoardState();
  const mcp = useMcpEndpoint();

  if (state.kind === "failure") return <BoardFailure failure={state.failure} />;
  if (state.kind === "no_project") return <NoProject workspaceName={state.workspaceName} />;
  if (!allowEmpty && isEmptyProject(state.model)) {
    return <EmptyProject model={state.model} mcpEndpoint={mcp.url} />;
  }
  return <>{children(state.model)}</>;
}
