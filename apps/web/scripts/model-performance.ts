import { performance } from "node:perf_hooks";
import { dependencyWaves, possibleCollisions } from "~/lib/graph";
import { buildProjectModel } from "~/lib/model";
import type { Aggregate, LoadedBoard } from "~/server/board";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const SAMPLES = 7;
const WARMUPS = 2;

interface Scale {
  readonly name: string;
  readonly epics: number;
  readonly streamsPerEpic: number;
  readonly tasksPerStream: number;
  readonly rules: number;
  readonly buildBudgetMs: number;
  readonly fullBudgetMs: number;
}

const SCALES: readonly Scale[] = [
  {
    name: "small",
    epics: 10,
    streamsPerEpic: 5,
    tasksPerStream: 4,
    rules: 20,
    buildBudgetMs: 10,
    fullBudgetMs: 15,
  },
  {
    name: "medium",
    epics: 25,
    streamsPerEpic: 10,
    tasksPerStream: 4,
    rules: 100,
    buildBudgetMs: 20,
    fullBudgetMs: 30,
  },
  {
    name: "large",
    epics: 50,
    streamsPerEpic: 10,
    tasksPerStream: 4,
    rules: 200,
    buildBudgetMs: 40,
    fullBudgetMs: 60,
  },
] as const;

function verifyGraphRegressionCase() {
  const result = dependencyWaves([
    { dependent: "B", prerequisite: "A", reason: null },
    { dependent: "B", prerequisite: "C", reason: null },
    { dependent: "C", prerequisite: "B", reason: null },
    { dependent: "D", prerequisite: "A", reason: null },
  ]);
  const actual = JSON.stringify(result);
  const expected = JSON.stringify({ waves: [["A"], ["D"]], unresolved: ["B", "C"] });
  if (actual !== expected) {
    throw new Error(
      `dependency wave regression check failed: expected ${expected}, received ${actual}`,
    );
  }

  const collisions = possibleCollisions(
    [
      { key: "T-1", streamKey: "S-1", scope: ["repo", "api", "api"] },
      { key: "T-2", streamKey: "S-2", scope: ["repo", "api"] },
      { key: "T-3", streamKey: "S-1", scope: ["repo", "api"] },
      { key: "T-4", streamKey: "S-3", scope: ["repo", "api"] },
      { key: "T-5", streamKey: "S-4", scope: ["repo", "api"] },
    ],
    new Map([
      ["S-1", 0],
      ["S-2", 0],
      ["S-3", 0],
      ["S-4", 1],
    ]),
  );
  const collisionShape = collisions.map(({ key, shared }) => ({ key, shared }));
  const expectedCollisions = [
    { key: "T-1:T-2", shared: ["repo", "api", "api"] },
    { key: "T-1:T-4", shared: ["repo", "api", "api"] },
    { key: "T-2:T-3", shared: ["repo", "api"] },
    { key: "T-2:T-4", shared: ["repo", "api"] },
    { key: "T-3:T-4", shared: ["repo", "api"] },
  ];
  if (JSON.stringify(collisionShape) !== JSON.stringify(expectedCollisions)) {
    throw new Error(
      `collision regression check failed: expected ${JSON.stringify(expectedCollisions)}, received ${JSON.stringify(collisionShape)}`,
    );
  }
}

type Epic = Aggregate["epics"][number];
type Stream = Epic["streams"][number];
type Task = Stream["tasks"][number];
type Rule = Aggregate["rules"][number];
type Link = Aggregate["links"][number];

function entityFields(key: string, ruleKey?: string) {
  return {
    id: `id-${key}`,
    key,
    title: `Synthetic ${key}`,
    summary: null,
    revision: 1,
    ruleApplications: ruleKey
      ? [
          {
            id: `use-${key}`,
            ruleKey,
            appliesWhen: null,
            application: null,
          },
        ]
      : [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function syntheticBoard(scale: Scale): LoadedBoard & { readonly aggregate: Aggregate } {
  const streamCount = scale.epics * scale.streamsPerEpic;
  let nextStream = 1;
  let nextTask = 1;

  const epics: Epic[] = Array.from({ length: scale.epics }, (_, epicIndex) => {
    const epicKey = `E-${String(epicIndex + 1)}`;
    const streams: Stream[] = Array.from({ length: scale.streamsPerEpic }, () => {
      const streamIndex = nextStream;
      nextStream += 1;
      const streamKey = `S-${String(streamIndex)}`;
      const tasks: Task[] = Array.from({ length: scale.tasksPerStream }, () => {
        const taskIndex = nextTask;
        nextTask += 1;
        const taskKey = `T-${String(taskIndex)}`;
        const ruleKey = `R-${String((taskIndex % scale.rules) + 1)}`;
        return {
          ...entityFields(taskKey),
          streamId: `id-${streamKey}`,
          status: "ready",
          taskType: "implementation",
          document: {
            meta: { priority: "medium" },
            content: {
              objective: `Deliver ${taskKey}`,
              constrained_by_rule_keys: [ruleKey],
              // Every Task shares one broad repository but has a unique component.
              // The old pairwise scan still inspected every pair; the indexed model
              // can prove that no pair shares the required two names.
              technical_scope: {
                repositories: ["repo:synthetic"],
                components: [`component:${taskKey}`],
              },
              implements: {},
              verification: [],
              done_when: [],
            },
            execution: { executor_kind: "either" },
          },
        } satisfies Task;
      });
      const ruleKey = `R-${String((streamIndex % scale.rules) + 1)}`;
      return {
        ...entityFields(streamKey, ruleKey),
        epicId: `id-${epicKey}`,
        status: "ready",
        streamType: "feature",
        document: {
          meta: { priority: "medium" },
          content: { purpose: `Purpose of ${streamKey}` },
        },
        tasks,
      } satisfies Stream;
    });
    const ruleKey = `R-${String((epicIndex % scale.rules) + 1)}`;
    return {
      ...entityFields(epicKey, ruleKey),
      status: "active",
      document: {
        meta: { priority: "high" },
        content: { purpose: `Purpose of ${epicKey}`, business_problem: "Synthetic scale" },
      },
      streams,
    } satisfies Epic;
  });

  const rules: Rule[] = Array.from({ length: scale.rules }, (_, index) => {
    const key = `R-${String(index + 1)}`;
    return {
      ...entityFields(key),
      status: "active",
      document: {
        meta: { priority: "medium" },
        content: { statement: `Rule ${key}`, evidence: { basis: "stated", source_ids: [] } },
      },
    } satisfies Rule;
  });

  const links: Link[] = [];
  for (let streamIndex = 2; streamIndex <= streamCount; streamIndex += 1) {
    links.push({
      sourceType: "stream",
      sourceKey: `S-${String(streamIndex)}`,
      targetType: "stream",
      targetKey: "S-1",
      relationship: "blocked_by",
      reason: null,
    });
    links.push({
      sourceType: "stream",
      sourceKey: `S-${String(streamIndex - 1)}`,
      targetType: "stream",
      targetKey: `S-${String(streamIndex)}`,
      relationship: "related_to",
      reason: null,
    });
  }

  const aggregate = {
    project: {
      id: "00000000-0000-4000-8000-000000000001",
      name: `Synthetic ${scale.name}`,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    fragmentCount: 0,
    epics,
    milestones: [],
    rules,
    links,
  } satisfies Aggregate;

  return {
    status: "ok",
    workspace: {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Synthetic workspace",
      slug: "synthetic",
    },
    projects: [{ id: aggregate.project.id, name: aggregate.project.name }],
    aggregate,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

function measure(scale: Scale) {
  const board = syntheticBoard(scale);
  let checksum = 0;
  const run = () => {
    const started = performance.now();
    const model = buildProjectModel(board);
    const buildMs = performance.now() - started;
    const collisionStarted = performance.now();
    const collisions = model.collisions;
    const fullMs = buildMs + performance.now() - collisionStarted;
    checksum += model.tasks.length + model.streams.length + model.rules.length + collisions.length;
    return { buildMs, fullMs };
  };

  for (let index = 0; index < WARMUPS; index += 1) run();
  const samples = Array.from({ length: SAMPLES }, run);
  const buildSamples = samples.map((sample) => sample.buildMs).sort((left, right) => left - right);
  const fullSamples = samples.map((sample) => sample.fullMs).sort((left, right) => left - right);
  return {
    name: scale.name,
    entities:
      scale.epics +
      scale.epics * scale.streamsPerEpic +
      scale.epics * scale.streamsPerEpic * scale.tasksPerStream +
      scale.rules,
    streams: scale.epics * scale.streamsPerEpic,
    tasks: scale.epics * scale.streamsPerEpic * scale.tasksPerStream,
    rules: scale.rules,
    buildMedianMs: percentile(buildSamples, 0.5),
    buildP95Ms: percentile(buildSamples, 0.95),
    fullMedianMs: percentile(fullSamples, 0.5),
    fullP95Ms: percentile(fullSamples, 0.95),
    buildBudgetMs: scale.buildBudgetMs,
    fullBudgetMs: scale.fullBudgetMs,
    checksum,
  };
}

verifyGraphRegressionCase();
const stabilityScale = SCALES[0];
if (!stabilityScale) throw new Error("ProjectModel performance scales are empty");
const stabilityModel = buildProjectModel(syntheticBoard(stabilityScale));
if (stabilityModel.collisions !== stabilityModel.collisions) {
  throw new Error("ProjectModel collisions getter did not return a stable memoized value");
}
const results = SCALES.map(measure);
for (const result of results) {
  console.log(
    `${result.name.padEnd(6)} ${String(result.entities).padStart(5)} entities · ${String(result.streams).padStart(3)} streams · ${String(result.tasks).padStart(4)} tasks · ${String(result.rules).padStart(3)} rules · build ${result.buildMedianMs.toFixed(2).padStart(7)} ms median / ${result.buildP95Ms.toFixed(2).padStart(7)} p95 · with collisions ${result.fullMedianMs.toFixed(2).padStart(7)} ms median / ${result.fullP95Ms.toFixed(2).padStart(7)} p95`,
  );
}

const measureOnly = process.argv.includes("--measure-only");
if (!measureOnly) {
  const failures = results.flatMap((result) => [
    ...(result.buildMedianMs > result.buildBudgetMs
      ? [
          `${result.name} build median ${result.buildMedianMs.toFixed(2)} ms exceeded ${String(result.buildBudgetMs)} ms`,
        ]
      : []),
    ...(result.fullMedianMs > result.fullBudgetMs
      ? [
          `${result.name} full median ${result.fullMedianMs.toFixed(2)} ms exceeded ${String(result.fullBudgetMs)} ms`,
        ]
      : []),
  ]);
  const medium = results.find((result) => result.name === "medium");
  const large = results.find((result) => result.name === "large");
  if (medium && large && large.fullMedianMs / medium.fullMedianMs > 2.8) {
    failures.push(
      `doubling Tasks scaled full model construction by ${(large.fullMedianMs / medium.fullMedianMs).toFixed(2)}× (budget 2.8×)`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`ProjectModel performance budget failed:\n${failures.join("\n")}`);
  }
}
