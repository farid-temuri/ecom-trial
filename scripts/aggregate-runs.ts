#!/usr/bin/env bun
/**
 * Aggregate per-task scores across multiple runs to see signal through the
 * ~20% run-to-run variance. Reads `runs/*.jsonl`, groups trial:score by task,
 * and reports mean / pass-rate / spread per task plus per-run and overall means.
 *
 * Usage:
 *   bun run scripts/aggregate-runs.ts                 # 5 newest runs
 *   bun run scripts/aggregate-runs.ts <n>             # n newest runs
 *   bun run scripts/aggregate-runs.ts run1.jsonl ...  # explicit run files
 *
 * A task only counts in a run where the agent actually started it (trial:start),
 * so disabled/skipped tasks don't pollute the means with structural zeros.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUNS_DIR = join(import.meta.dir, "..", "runs");

function newestRuns(n: number): string[] {
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(RUNS_DIR, f))
    .map((p) => ({ p, m: Bun.file(p).lastModified }))
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map((x) => x.p);
}

const args = process.argv.slice(2);
let files: string[];
if (args.length === 0) files = newestRuns(5);
else if (args.length === 1 && /^\d+$/.test(args[0]!)) files = newestRuns(Number(args[0]));
else files = args;

type RunData = {
  id: string;
  started: Set<string>;
  scores: Map<string, number>;
};

function parseRun(path: string): RunData {
  const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
  const started = new Set<string>();
  const scores = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "trial:start") started.add(e.taskId);
    else if (e.type === "trial:score" && typeof e.score === "number")
      scores.set(e.taskId, e.score);
  }
  return { id, started, scores };
}

const runs = files.map(parseRun).reverse(); // oldest→newest for display
const allTasks = [...new Set(runs.flatMap((r) => [...r.started]))].sort();

// Per-task aggregation across runs where the task was actually started.
type Agg = { task: string; vals: number[]; mean: number; pass: number; spread: number };
const aggs: Agg[] = allTasks.map((task) => {
  const vals = runs.filter((r) => r.started.has(task)).map((r) => r.scores.get(task) ?? 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const pass = vals.filter((v) => v >= 0.999).length / vals.length;
  const spread = Math.max(...vals) - Math.min(...vals);
  return { task, vals, mean, pass, spread };
});

const fmt = (n: number, d = 2) => n.toFixed(d);
const RUN_LABEL = runs.map((r, i) => `r${i + 1}`);

console.log(`\nAggregating ${runs.length} runs:`);
runs.forEach((r, i) => console.log(`  ${RUN_LABEL[i]} = ${r.id} (${r.started.size} tasks)`));

// Per-run mean over each run's own started set.
console.log(`\nPer-run mean (over that run's started tasks):`);
runs.forEach((r, i) => {
  const v = [...r.started].map((t) => r.scores.get(t) ?? 0);
  console.log(`  ${RUN_LABEL[i]}: ${fmt(v.reduce((a, b) => a + b, 0) / v.length, 3)}  (n=${v.length})`);
});

const overall = aggs.reduce((a, b) => a + b.mean, 0) / aggs.length;
console.log(`\nOverall mean of per-task means: ${fmt(overall, 3)}  (${aggs.length} tasks)`);

// Full table, sorted by mean ascending (worst first).
console.log(`\nPer-task (sorted worst→best). spread = max−min across runs (variance flag):`);
const head = `task   mean  pass%  spread  ${RUN_LABEL.join("    ")}`;
console.log(head);
console.log("-".repeat(head.length));
for (const a of [...aggs].sort((x, y) => x.mean - y.mean)) {
  const cells = runs.map((r) =>
    r.started.has(a.task) ? fmt(r.scores.get(a.task) ?? 0).padStart(4) : "  - ",
  );
  const flag = a.spread >= 0.999 ? "  ⚑ flips" : a.spread > 0.01 ? "  ~" : "";
  console.log(
    `${a.task.padEnd(6)} ${fmt(a.mean)}  ${fmt(a.pass * 100, 0).padStart(3)}%  ${fmt(a.spread).padStart(5)}  ${cells.join("  ")}${flag}`,
  );
}

// Highlight the tasks the 2026-05-30 prompt edits targeted.
const TARGETED = ["t15", "t22", "t36", "t42", "t43", "t44"];
const WATCH = ["t16", "t25", "t27", "t31", "t38", "t41", "t51"];
const summary = (label: string, ids: string[]) => {
  const rows = aggs.filter((a) => ids.includes(a.task));
  if (!rows.length) return;
  const m = rows.reduce((a, b) => a + b.mean, 0) / rows.length;
  console.log(`\n${label} (mean ${fmt(m, 3)}):`);
  for (const a of rows)
    console.log(`  ${a.task}: mean ${fmt(a.mean)} pass ${fmt(a.pass * 100, 0)}% [${a.vals.map((v) => fmt(v, 1)).join(",")}]`);
};
summary("TARGETED by the fixes — want high & stable", TARGETED);
summary("WATCH — regression-suspects from the single-run A/B", WATCH);

const flips = aggs.filter((a) => a.spread >= 0.999).length;
console.log(`\nVariance: ${flips}/${aggs.length} tasks (${fmt((flips / aggs.length) * 100, 0)}%) flip 0↔1 across runs.`);
