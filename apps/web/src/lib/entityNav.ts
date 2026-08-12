import { useNavigate, useSearch } from "@tanstack/react-router";
import { carry } from "./search";

/**
 * The two ways into an entity, and what they mean.
 *
 * `inspect` opens the Inspector over the table you are reading, so a row you asked
 * about is answered without losing your place in it. `openPage` leaves for the
 * entity's own page. All three levels have a page — Epic, Stream and Task — so the
 * drawer is a preview everywhere rather than the last stop for one of them.
 *
 * ## Two kinds route differently, deliberately
 *
 * A **Rule** has no drawer and no page. Everything it holds — statement,
 * rationale, evidence, named consumers — is one expandable row on the Rules table,
 * and a dedicated page for it would be that row with more whitespace. So a Rule key
 * lands on `/rules` filtered to it with the row open. Caught here rather than at
 * each call site, so a Rule chip on a Task, a search hit and a consumer list all
 * get the same answer for free.
 *
 * A **Milestone** is a section of the Roadmap rather than an entity you open. Its
 * exit criteria only mean anything beside the Streams assigned to it, so its key
 * lands on `/roadmap` scrolled to that section.
 *
 * Both were standalone routes before. The keys stay addressable — `/rules?rule=R-57`
 * is as linkable as `/rule/R-57` was — but the content lives where it is legible.
 */

export type EntityKind = "epic" | "stream" | "task" | "rule" | "milestone" | "revision";

/** What a key refers to, read from its prefix. */
export function entityKindOf(key: string): EntityKind {
  if (key.startsWith("rev:")) return "revision";
  if (key.startsWith("E-")) return "epic";
  if (key.startsWith("S-")) return "stream";
  if (key.startsWith("T-")) return "task";
  if (key.startsWith("M-")) return "milestone";
  return "rule";
}

/** The Inspector reference for one revision of one entity. */
export function revisionRef(entityKey: string, revision: number): string {
  return `rev:${entityKey}@${String(revision)}`;
}

export function parseRevisionRef(
  reference: string,
): { readonly entityKey: string; readonly revision: number } | null {
  const match = /^rev:(.+)@(\d+)$/.exec(reference);
  if (!match) return null;
  const [, entityKey, revision] = match;
  return entityKey && revision ? { entityKey, revision: Number.parseInt(revision, 10) } : null;
}

export interface EntityNav {
  /** Open the Inspector over the current screen. */
  readonly inspect: (key: string) => void;
  /** Leave for the entity's own page. */
  readonly openPage: (key: string) => void;
  readonly close: () => void;
}

export function useEntityNav(): EntityNav {
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" });

  const goToRule = (key: string) => {
    void navigate({
      to: "/rules",
      search: { ...carry(search), rule: key, q: undefined, evidence: undefined, named: undefined },
    });
  };

  const goToMilestone = (key: string) => {
    void navigate({ to: "/roadmap", search: { ...carry(search), milestone: key, tab: "plan" } });
  };

  /**
   * A revision is only resolvable where the log is loaded, which is Recent
   * changes. Routing there rather than setting `?inspect=` in place means a
   * `rev:` link works from anywhere instead of silently opening nothing.
   */
  const goToRevision = (reference: string) => {
    void navigate({ to: "/changes", search: { ...carry(search), inspect: reference } });
  };

  const inspect = (key: string) => {
    const kind = entityKindOf(key);
    if (kind === "rule") {
      goToRule(key);
      return;
    }
    if (kind === "milestone") {
      goToMilestone(key);
      return;
    }
    if (kind === "revision") {
      goToRevision(key);
      return;
    }
    void navigate({ to: ".", search: (previous) => ({ ...previous, inspect: key }) });
  };

  const openPage = (key: string) => {
    const kind = entityKindOf(key);
    if (kind === "rule") {
      goToRule(key);
      return;
    }
    if (kind === "milestone") {
      goToMilestone(key);
      return;
    }
    if (kind === "epic") {
      void navigate({ to: "/epic/$epicKey", params: { epicKey: key }, search: carry(search) });
      return;
    }
    if (kind === "stream") {
      void navigate({
        to: "/stream/$streamKey",
        params: { streamKey: key },
        search: carry(search),
      });
      return;
    }
    if (kind === "task") {
      void navigate({ to: "/task/$taskKey", params: { taskKey: key }, search: carry(search) });
      return;
    }
    // A revision has no page and never will: it is an immutable snapshot, not a
    // thing with a life of its own. Inspecting it is the whole of what it offers.
    inspect(key);
  };

  const close = () => {
    void navigate({ to: ".", search: (previous) => ({ ...previous, inspect: undefined }) });
  };

  return { inspect, openPage, close };
}
