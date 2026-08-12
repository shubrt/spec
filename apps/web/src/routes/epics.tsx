import { createFileRoute, useSearch } from "@tanstack/react-router";
import { epicColumns, openColumn } from "~/components/zpecs/columns";
import { EntityTable } from "~/components/zpecs/entity-table";
import { PageHead } from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { useEntityNav } from "~/lib/entityNav";
import type { EpicRow } from "~/lib/model";

/**
 * Epics — one row per long-lived business capability.
 *
 * Every number in the table is counted from the Streams and Tasks beneath it. An
 * Epic stores no aggregates at all, which is also why it has no completion column:
 * `active`, `paused` and `archived` are the whole vocabulary, because finishing one
 * of its Streams does not finish the capability.
 */
export const Route = createFileRoute("/epics")({ component: EpicsPage });

function EpicsPage() {
  return <Screen>{(model) => <EpicsScreen epics={model.epics} />}</Screen>;
}

function EpicsScreen({ epics }: { readonly epics: readonly EpicRow[] }) {
  const nav = useEntityNav();
  const search = useSearch({ from: "__root__" });

  return (
    <div>
      <PageHead
        title="Epics"
        count={epics.length}
        hint="An Epic is a long-lived business capability, never a sprint or a release. It has only active, paused and archived — there is no completed Epic. Every number in this table is counted from the Streams and Tasks beneath it."
      />
      <EntityTable
        label="Epics"
        columns={[...epicColumns(nav), openColumn<EpicRow>(nav)]}
        rows={epics}
        selectedKey={search.inspect}
        onSelect={nav.inspect}
        defaultOrderLabel="Ordered by lifecycle, then key"
        emptyLabel="No Epics"
      />
    </div>
  );
}
