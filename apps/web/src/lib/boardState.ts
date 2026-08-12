import { useLoaderData } from "@tanstack/react-router";
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { ApiFailure } from "./apiFailure";
import { buildProjectModel, type ProjectModel } from "./model";

/**
 * The three states any screen can be in, resolved once.
 *
 * Every route narrows on `kind` and then reads a fully-typed value, rather than
 * re-checking `status !== "ok"` and `aggregate !== null` in fifteen places. The
 * root loader holds the aggregate for the whole app, so this is a projection of
 * data already in memory and not a fetch.
 *
 * The empty-Project case is deliberately *not* a fourth state here. A Project
 * with no content is `ready` with a model whose counters are genuinely zero —
 * that is a real Project, not a missing one, and treating it as an error state
 * would be the same mistake as reporting a signed-in session with no organization
 * as a crash. `ProjectModel.isEmpty` is how a screen chooses to stand in for the
 * ten screens that would all show the same emptiness.
 */
export type BoardState =
  | { readonly kind: "failure"; readonly failure: ApiFailure }
  /** A workspace that holds no Project at all. Nothing has been created yet. */
  | { readonly kind: "no_project"; readonly workspaceName: string }
  | { readonly kind: "ready"; readonly model: ProjectModel };

const BoardStateContext = createContext<BoardState | null>(null);

/**
 * Builds the read model once for the signed-in application tree.
 *
 * AppFrame, every Screen and both overlays consume the same object. Keeping this at
 * the root matters because `useMemo` belongs to a component instance: putting the
 * projection inside `useBoardState` made every caller build its own copy.
 */
export function BoardStateProvider({ children }: { readonly children: ReactNode }) {
  const { board } = useLoaderData({ from: "__root__" });

  const state = useMemo((): BoardState => {
    if (board.status !== "ok") return { kind: "failure", failure: board };
    if (!board.aggregate) return { kind: "no_project", workspaceName: board.workspace.name };
    return { kind: "ready", model: buildProjectModel({ ...board, aggregate: board.aggregate }) };
  }, [board]);

  return createElement(BoardStateContext.Provider, { value: state }, children);
}

export function useBoardState(): BoardState {
  const state = useContext(BoardStateContext);
  if (!state) throw new Error("useBoardState must be used inside BoardStateProvider");
  return state;
}

/** Where an MCP client connects, and whether that origin is only reachable locally. */
export function useMcpEndpoint(): { readonly url: string; readonly isLocal: boolean } {
  return useLoaderData({ from: "__root__" }).mcp;
}

/** True when every counter on the Project is genuinely zero. */
export function isEmptyProject(model: ProjectModel): boolean {
  return (
    model.epics.length === 0 &&
    model.streams.length === 0 &&
    model.tasks.length === 0 &&
    model.milestones.length === 0 &&
    model.rules.length === 0
  );
}
