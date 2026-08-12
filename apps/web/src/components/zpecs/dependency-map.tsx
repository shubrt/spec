import { useState } from "react";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import type { ProjectModel } from "~/lib/model";
import { cn } from "~/lib/utils";
import { keySequence, label } from "~/lib/vocabulary";
import { DependencyCell } from "./box";
import { EntityTable, type Column } from "./entity-table";
import { Chip, EntityKey, InfoHint, PartHead, TableNote } from "./parts";

/**
 * The stored dependency graph, drawn.
 *
 * ## Only Streams that are actually in a dependency get a lane
 *
 * A Stream with no stored edge at either end is not "early". It has nothing to
 * wait for, which is true of anything with no dependency at all, and putting it in
 * wave 1 makes the lane claim something it does not know. Those Streams are simply
 * not in the picture; the semantic relations table below lists the ones that are
 * connected in some other way, as the relations they actually are.
 *
 * ## Waves are a grouping, not a schedule
 *
 * Lanes are derived waves. There is no time axis, no width proportional to
 * anything, and the vertical order inside a lane is a drawing choice made to reduce
 * crossings — it carries no meaning at all.
 *
 * ## Solid blocks, dashed does not
 *
 * `blocked_by` is drawn solid because it claims an order. `extends`, `related_to`
 * and `supersedes` are dashed because they record that two entities are connected
 * and nothing more. Drawing them identically would turn a cross-reference into a
 * prerequisite.
 */

const NODE_WIDTH = 204;
const NODE_HEIGHT = 48;
const COLUMN_WIDTH = 268;
const ROW_HEIGHT = 60;
const HEADER_HEIGHT = 30;
const GUTTER = 46;

interface Placement {
  readonly x: number;
  readonly y: number;
  readonly column: number;
}

interface MapEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly blocking: boolean;
  readonly reason: string | null;
}

/**
 * Orders nodes inside each lane to reduce edge crossings.
 *
 * Barycentre sweeps for a decent starting order, then adjacent swaps for what the
 * sweeps cannot see. Same-lane edges are excluded from the ordering: they say
 * nothing about order and would only pull a node toward its own position.
 */
function orderColumns(columns: string[][], edges: readonly MapEdge[]): void {
  const columnOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  columns.forEach((nodes, index) => {
    nodes.forEach((key, position) => {
      columnOf.set(key, index);
      rowOf.set(key, position);
    });
  });

  const crossing = edges.filter(
    (edge) =>
      columnOf.has(edge.from) &&
      columnOf.has(edge.to) &&
      columnOf.get(edge.from) !== columnOf.get(edge.to),
  );

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
  };
  for (const edge of crossing) {
    push(outgoing, edge.from, edge.to);
    push(incoming, edge.to, edge.from);
  }

  const barycentre = (key: string, side: "incoming" | "outgoing"): number | null => {
    const neighbours = (side === "incoming" ? incoming : outgoing).get(key) ?? [];
    const known = neighbours.flatMap((neighbour) => {
      const row = rowOf.get(neighbour);
      return row === undefined ? [] : [row];
    });
    return known.length === 0 ? null : known.reduce((sum, row) => sum + row, 0) / known.length;
  };

  const sweep = (indices: readonly number[], side: "incoming" | "outgoing") => {
    for (const index of indices) {
      const nodes = columns[index];
      if (!nodes) continue;
      const scored = nodes.map((key, position) => ({
        key,
        position,
        score: barycentre(key, side) ?? position,
      }));
      scored.sort((left, right) => left.score - right.score || left.position - right.position);
      columns[index] = scored.map((entry) => entry.key);
      columns[index]?.forEach((key, position) => rowOf.set(key, position));
    }
  };

  const forward = columns.map((_, index) => index).slice(1);
  const backward = columns
    .map((_, index) => index)
    .slice(0, -1)
    .reverse();
  for (let pass = 0; pass < 5; pass += 1) {
    sweep(forward, "incoming");
    sweep(backward, "outgoing");
  }
}

function edgePath(from: Placement, to: Placement): string {
  const y1 = from.y + NODE_HEIGHT / 2;
  const y2 = to.y + NODE_HEIGHT / 2;

  // A same-lane edge arcs out into the gutter and back, so it reads as a
  // connection rather than as a line passing behind the cards.
  if (from.column === to.column) {
    const x = from.x + NODE_WIDTH;
    const bulge = x + GUTTER;
    return `M${String(x)},${String(y1)} C${String(bulge)},${String(y1)} ${String(bulge)},${String(y2)} ${String(x + 4)},${String(y2)}`;
  }
  if (to.column > from.column) {
    const x1 = from.x + NODE_WIDTH;
    const x2 = to.x - 4;
    const mid = (x1 + x2) / 2;
    return `M${String(x1)},${String(y1)} C${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2)},${String(y2)}`;
  }
  // Mirrored into the target's right side, so a line running against the flow
  // looks like it does.
  const x1 = from.x;
  const x2 = to.x + NODE_WIDTH + 4;
  const mid = (x1 + x2) / 2;
  return `M${String(x1)},${String(y1)} C${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2)},${String(y2)}`;
}

export function DependencyMap({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const [asList, setAsList] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const inGraph = new Set<string>();
  for (const edge of model.streamDependencies) {
    inGraph.add(edge.dependent);
    inGraph.add(edge.prerequisite);
  }

  const edges: readonly MapEdge[] = [
    ...model.streamDependencies.map((edge) => ({
      id: `d:${edge.dependent}:${edge.prerequisite}`,
      from: edge.prerequisite,
      to: edge.dependent,
      blocking: true,
      reason: edge.reason,
    })),
    ...model.relationEdges
      .filter((edge) => inGraph.has(edge.from) && inGraph.has(edge.to))
      .map((edge) => ({
        id: `r:${edge.from}:${edge.to}`,
        from: edge.from,
        to: edge.to,
        blocking: false,
        reason: edge.reason,
      })),
  ];

  const columns = model.waves
    .map((wave) => wave.filter((key) => inGraph.has(key)))
    .filter((wave) => wave.length > 0);
  orderColumns(columns, edges);

  const placement = new Map<string, Placement>();
  columns.forEach((nodes, columnIndex) => {
    nodes.forEach((key, rowIndex) => {
      placement.set(key, {
        x: columnIndex * COLUMN_WIDTH,
        y: HEADER_HEIGHT + rowIndex * ROW_HEIGHT,
        column: columnIndex,
      });
    });
  });

  const tallest = columns.reduce((max, nodes) => Math.max(max, nodes.length), 0);
  const height = HEADER_HEIGHT + tallest * ROW_HEIGHT + 8;
  const width = columns.length * COLUMN_WIDTH + GUTTER;

  const neighbours = new Set<string>();
  if (hover) {
    neighbours.add(hover);
    for (const edge of edges) {
      if (edge.from === hover) neighbours.add(edge.to);
      if (edge.to === hover) neighbours.add(edge.from);
    }
  }
  const dimmed = (key: string) => hover !== null && !neighbours.has(key);

  return (
    <div>
      <TableNote
        items={[
          {
            value: inGraph.size,
            label: "Streams in a dependency",
            hint: `Of ${String(model.streams.length)} Streams, these are the ones with a stored blocked_by edge at either end. A Stream with none is not early — it has nothing to wait for, which is why no lane holds it.`,
          },
          {
            value: model.waves.length,
            label: "derived waves",
            hint: "Computed from the dependency graph at read time. Waves are not stored entities, and an equal wave means only that nothing forces an order.",
          },
          {
            value: model.longestChain.length,
            label: "Streams in the longest blocker chain",
            hint: "The longest path through the graph. Not a critical path — there are no durations to weight it with, so this counts Streams in a row and never elapsed time.",
          },
          {
            value: model.collisions.length,
            label: "possible scope collisions",
            hint: "Two open Tasks in the same wave sharing at least two technical scopes. A warning that they may touch the same code, never a detected conflict.",
          },
        ]}
      />

      <div className="flex items-center gap-2 py-3">
        <button
          type="button"
          onClick={() => setAsList(!asList)}
          className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
        >
          {asList ? "Show graph" : "Show as list"}
        </button>
        <span className="text-muted-foreground text-[11px]">
          The list is the same edges, and it is the accessible alternative to the drawing.
        </span>
      </div>

      {asList || columns.length === 0 ? (
        <EntityTable
          label="Dependency edges"
          columns={edgeColumns(model, nav)}
          rows={model.streamDependencies.map((edge) => ({
            key: `${edge.dependent}:${edge.prerequisite}`,
            prerequisite: edge.prerequisite,
            dependent: edge.dependent,
            reason: edge.reason,
          }))}
          initialPageSize={25}
          defaultOrderLabel="Shown prerequisite → dependent, the direction the edge is stored in"
          emptyLabel="No dependency is stored between Streams"
          emptyHint="Nothing forces an order anywhere in this Project. That is a fact about the graph, not about whether the work is independent."
        />
      ) : (
        <div className="overflow-auto">
          <div className="relative" style={{ width, height }} onMouseLeave={() => setHover(null)}>
            {columns.map((nodes, index) => (
              <div
                key={`lane-${String(index)}`}
                className="absolute top-0"
                style={{ left: index * COLUMN_WIDTH - 8, width: NODE_WIDTH + 16, height }}
              >
                <div
                  className={cn(
                    "h-full rounded-sm",
                    index % 2 === 0 ? "bg-muted/40" : "bg-muted/15",
                  )}
                />
                <div className="text-muted-foreground text-micro absolute left-0 top-0 flex h-[30px] w-full items-center gap-1.5 px-2 font-mono font-semibold uppercase tracking-wider">
                  <span className="truncate">{`Derived wave ${String(index + 1).padStart(2, "0")}`}</span>
                  <span className="tabular-nums opacity-70">{nodes.length}</span>
                </div>
              </div>
            ))}

            <svg
              width={width}
              height={height}
              className="pointer-events-none absolute left-0 top-0"
            >
              <defs>
                <marker
                  id="zarrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path d="M0,1 L7,4 L0,7 z" fill="currentColor" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const from = placement.get(edge.from);
                const to = placement.get(edge.to);
                if (!from || !to) return null;
                const lit = hover !== null && (edge.from === hover || edge.to === hover);
                const faded = dimmed(edge.from) || dimmed(edge.to);
                return (
                  <path
                    key={edge.id}
                    d={edgePath(from, to)}
                    fill="none"
                    className={lit ? "text-primary" : faded ? "text-border" : "text-border-strong"}
                    stroke="currentColor"
                    strokeWidth={lit ? 2 : edge.blocking ? 1.5 : 1}
                    strokeDasharray={edge.blocking ? undefined : "5 4"}
                    strokeOpacity={faded && !lit ? 0.45 : 1}
                    markerEnd="url(#zarrow)"
                  />
                );
              })}
            </svg>

            {[...placement.entries()].map(([key, spot]) => {
              const stream = model.streamByKey.get(key);
              if (!stream) return null;
              const incoming = edges.filter((edge) => edge.to === key).length;
              const outgoing = edges.filter((edge) => edge.from === key).length;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => nav.inspect(key)}
                  onMouseEnter={() => setHover(key)}
                  onFocus={() => setHover(key)}
                  title={`${key} — ${String(incoming)} in, ${String(outgoing)} out`}
                  className={cn(
                    "focus-visible:ring-ring absolute flex flex-col justify-center gap-0.5 rounded-sm border px-2 text-left outline-none transition-opacity focus-visible:ring-2",
                    "border-border-strong bg-background hover:bg-muted",
                    dimmed(key) ? "opacity-25" : "",
                  )}
                  style={{ left: spot.x, top: spot.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-medium">{key}</span>
                    {stream.dependency.kind === "blocked" ? (
                      <DependencyCell dependency={stream.dependency} />
                    ) : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">{stream.title}</span>
                </button>
              );
            })}
          </div>

          <div className="text-muted-foreground mt-4 flex flex-wrap items-center gap-5 text-xs">
            <span className="inline-flex items-center gap-2">
              <svg width="28" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="28"
                  y2="4"
                  stroke="var(--border-strong)"
                  strokeWidth="1.5"
                />
              </svg>
              hard dependency
            </span>
            <span className="inline-flex items-center gap-2">
              <svg width="28" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="28"
                  y2="4"
                  stroke="var(--border-strong)"
                  strokeWidth="1"
                  strokeDasharray="5 4"
                />
              </svg>
              semantic relation — never a blocker
            </span>
            <span>point at a node to lift its own edges</span>
            <InfoHint width={340}>
              Arrows run prerequisite → dependent. Nodes sit in their derived wave and are then
              ordered to reduce crossings, which is a drawing choice and carries no meaning.
              Possible scope collision is deliberately not drawn as an edge: it is inferred from
              Task scopes, not stored between Streams, and an edge here would make it look like a
              blocker.
            </InfoHint>
          </div>
        </div>
      )}

      {model.relationEdges.length > 0 ? (
        <div className="mt-7">
          <PartHead
            title="Semantic relations"
            count={model.relationEdges.length}
            hint="extends, related_to, supersedes, derived_from and exception_to are stored between entities but carry no order, so no wave can hold them. Those joining two Streams that are also in the dependency graph are drawn above as dashed lines; the rest exist only here."
          />
          <EntityTable
            label="Semantic relations"
            columns={relationColumns(model, nav)}
            rows={model.relationEdges.map((edge) => ({
              key: `${edge.from}:${edge.relationship}:${edge.to}`,
              from: edge.from,
              to: edge.to,
              relationship: edge.relationship,
              reason: edge.reason,
            }))}
            initialPageSize={25}
            defaultOrderLabel="Read-only · the keys are the links"
            emptyLabel="No relation is stored"
          />
        </div>
      ) : null}

      <div className="mt-7">
        <PartHead
          title="Possible scope collision"
          count={model.collisions.length}
          hint="Pairs of open Tasks in the same derived wave whose stored technical scopes intersect in at least two names. Nothing has been executed, so this can never be an observed conflict — and two Tasks naming the same component may well touch different parts of it."
        />
        <EntityTable
          label="Possible scope collision"
          columns={collisionColumns(nav)}
          rows={model.collisions}
          defaultOrderLabel="Read-only · the Task keys are the links"
          emptyLabel="No overlap is inferred"
          emptyHint="No two open Tasks in one wave share two or more technical scope names. One shared name is usually the repository itself and would pair almost everything with almost everything."
        />
      </div>
    </div>
  );
}

interface EdgeRow {
  readonly key: string;
  readonly prerequisite: string;
  readonly dependent: string;
  readonly reason: string | null;
}

function edgeColumns(model: ProjectModel, nav: EntityNav): readonly Column<EdgeRow>[] {
  return [
    {
      id: "prerequisite",
      label: "Prerequisite",
      width: 82,
      sort: (row) => keySequence(row.prerequisite),
      render: (row) => (
        <EntityKey entityKey={row.prerequisite} onClick={() => nav.inspect(row.prerequisite)} />
      ),
    },
    {
      id: "prerequisiteTitle",
      label: "Title",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => model.streamByKey.get(row.prerequisite)?.title ?? "",
    },
    {
      id: "dependent",
      label: "Dependent",
      width: 82,
      sort: (row) => keySequence(row.dependent),
      render: (row) => (
        <EntityKey entityKey={row.dependent} onClick={() => nav.inspect(row.dependent)} />
      ),
    },
    {
      id: "dependentTitle",
      label: "Title",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => model.streamByKey.get(row.dependent)?.title ?? "",
    },
    {
      id: "reason",
      label: "Stored reason",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => row.reason ?? "—",
      hint: "Why this dependency exists, in the author's own words. Optional on the edge, so a dash means none was recorded rather than that none exists.",
    },
  ];
}

interface RelationRowShape {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly relationship: string;
  readonly reason: string | null;
}

function relationColumns(model: ProjectModel, nav: EntityNav): readonly Column<RelationRowShape>[] {
  return [
    {
      id: "from",
      label: "From",
      width: 78,
      sort: (row) => keySequence(row.from),
      render: (row) => <EntityKey entityKey={row.from} onClick={() => nav.inspect(row.from)} />,
    },
    {
      id: "fromTitle",
      label: "Title",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) =>
        model.streamByKey.get(row.from)?.title ?? model.taskByKey.get(row.from)?.title ?? "",
    },
    {
      id: "relationship",
      label: "Relation",
      width: 124,
      sort: (row) => row.relationship,
      render: (row) => <Chip>{label(row.relationship)}</Chip>,
    },
    {
      id: "to",
      label: "To",
      width: 78,
      sort: (row) => keySequence(row.to),
      render: (row) => <EntityKey entityKey={row.to} onClick={() => nav.inspect(row.to)} />,
    },
    {
      id: "toTitle",
      label: "Title",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) =>
        model.streamByKey.get(row.to)?.title ?? model.taskByKey.get(row.to)?.title ?? "",
    },
  ];
}

function collisionColumns(nav: EntityNav): readonly Column<ProjectModel["collisions"][number]>[] {
  return [
    {
      id: "left",
      label: "Task",
      width: 60,
      render: (row) => <EntityKey entityKey={row.left} onClick={() => nav.inspect(row.left)} />,
    },
    {
      id: "leftStream",
      label: "Stream",
      width: 72,
      cellClass: "text-muted-foreground font-mono text-xs",
      render: (row) => row.leftStream,
    },
    {
      id: "right",
      label: "Task",
      width: 60,
      render: (row) => <EntityKey entityKey={row.right} onClick={() => nav.inspect(row.right)} />,
    },
    {
      id: "rightStream",
      label: "Stream",
      width: 72,
      cellClass: "text-muted-foreground font-mono text-xs",
      render: (row) => row.rightStream,
    },
    {
      id: "shared",
      label: "Shared scope",
      flex: true,
      render: (row) => (
        <span className="flex flex-wrap gap-1.5">
          {row.shared.map((name) => (
            <Chip key={name} variant="dotted">
              {name}
            </Chip>
          ))}
        </span>
      ),
    },
  ];
}
