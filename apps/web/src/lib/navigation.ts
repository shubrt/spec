import type { ProjectModel } from "./model";

/**
 * The sidebar, and how a URL becomes a breadcrumb.
 *
 * Navigation is routing rather than screen state, so the address bar is the single
 * source of where you are: the sidebar highlight, the breadcrumb and the browser's
 * back button all read the same value and cannot disagree.
 */

export type NavCount = keyof ProjectModel & ("epics" | "streams" | "tasks" | "rules" | "fragments");

/**
 * The twelve screens, as literals rather than `string`.
 *
 * Router links are typed against the generated route tree, so a `string` here
 * would have to be cast at every call site — and a typo in a nav entry would then
 * be a dead link nobody notices. As a union it is a build error instead.
 */
export type ScreenPath =
  | "/"
  | "/focus"
  | "/roadmap"
  | "/epics"
  | "/streams"
  | "/tasks"
  | "/rules"
  | "/criteria"
  | "/trace"
  | "/changes"
  | "/connection"
  | "/settings";

export type NavEntry =
  | { readonly kind: "group"; readonly label: string | null }
  | {
      readonly kind: "item";
      readonly to: ScreenPath;
      readonly label: string;
      /** Which model collection this item counts, if any. */
      readonly count?: NavCount;
      /** Paths whose entity belongs to this screen, so a detail page keeps it lit. */
      readonly owns?: readonly string[];
    };

/**
 * The nav, in the order a lead reads it: what to do now, what is planned, the work
 * itself, what constrains it, and finally what changed.
 *
 * A detail page lights its list — a Stream page is still "Streams" — so the
 * highlight answers "where am I" rather than "which route matched".
 */
export const NAV: readonly NavEntry[] = [
  { kind: "item", to: "/", label: "Overview" },
  { kind: "item", to: "/focus", label: "Focus" },
  { kind: "item", to: "/roadmap", label: "Roadmap" },
  { kind: "group", label: "Work" },
  { kind: "item", to: "/epics", label: "Epics", count: "epics", owns: ["/epic"] },
  { kind: "item", to: "/streams", label: "Streams", count: "streams", owns: ["/stream"] },
  { kind: "item", to: "/tasks", label: "Tasks", count: "tasks", owns: ["/task"] },
  { kind: "group", label: "Specs" },
  { kind: "item", to: "/rules", label: "Rules", count: "rules" },
  {
    kind: "item",
    to: "/criteria",
    label: "Requirements & Criteria",
    count: "fragments",
  },
  { kind: "item", to: "/trace", label: "Traceability" },
  { kind: "group", label: null },
  { kind: "item", to: "/changes", label: "Recent changes" },
  { kind: "item", to: "/connection", label: "Connection" },
  { kind: "item", to: "/settings", label: "Settings" },
];

/** Which nav item a path belongs to, detail pages included. */
export function activeNavPath(pathname: string): string {
  for (const entry of NAV) {
    if (entry.kind !== "item") continue;
    for (const owned of entry.owns ?? []) {
      if (pathname.startsWith(`${owned}/`)) return entry.to;
    }
  }
  if (pathname === "/") return "/";
  const [, first] = pathname.split("/");
  return first ? `/${first}` : "/";
}

/** The list a detail page belongs to, for its own in-page back link. */
export function listPathFor(kind: "epic" | "stream" | "task"): ScreenPath {
  return kind === "epic" ? "/epics" : kind === "stream" ? "/streams" : "/tasks";
}

export const SCREEN_LABEL: Readonly<Record<string, string>> = {
  "/": "Overview",
  "/focus": "Focus",
  "/roadmap": "Roadmap",
  "/epics": "Epics",
  "/streams": "Streams",
  "/tasks": "Tasks",
  "/rules": "Rules",
  "/criteria": "Requirements & Criteria",
  "/trace": "Traceability",
  "/changes": "Recent changes",
  "/settings": "Settings",
  "/connection": "Connection",
};

/**
 * `Specs` groups three screens in the sidebar but is not itself a screen, so it
 * appears in the breadcrumb as an inert segment rather than as a link to nothing.
 */
const SPEC_SCREENS = new Set(["/rules", "/criteria", "/trace"]);

export interface Crumb {
  readonly label: string;
  /** Where this segment goes. Absent makes it inert — the last one always is. */
  readonly to?: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * The trail for one location.
 *
 * Every segment above the current one is a real control: the screen segment
 * returns to the list, the entity segment leaves the tab you are on. Only the last
 * segment is inert, because you are already there.
 */
export function breadcrumb(pathname: string): readonly Crumb[] {
  const detail = /^\/(epic|stream|task)\/([^/]+)/.exec(pathname);
  if (detail) {
    const [, kind, key] = detail;
    const list = listPathFor((kind ?? "epic") as "epic" | "stream" | "task");
    return [
      { label: SCREEN_LABEL[list] ?? list, to: list },
      { label: decodeURIComponent(key ?? "") },
    ];
  }

  const screen = activeNavPath(pathname);
  const label = SCREEN_LABEL[screen] ?? screen;
  return SPEC_SCREENS.has(screen) ? [{ label: "Specs" }, { label }] : [{ label }];
}
