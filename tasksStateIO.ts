import { writeFileSync, renameSync } from "fs";
import { tasksState, type TaskState } from "./tasksState";

const STATE_FILE = `${import.meta.dir}/tasksState.ts`;

export function defaultTaskState(): TaskState {
  return { enabled: true, lastScore: null, lastRunAt: null, runs: 0, sumScore: 0 };
}

export function loadState(): Record<string, TaskState> {
  // Deep copy so callers can mutate freely without touching the imported module
  const out: Record<string, TaskState> = {};
  for (const [id, s] of Object.entries(tasksState)) out[id] = { ...s };
  return out;
}

export function updateTaskState(
  state: Record<string, TaskState>,
  taskId: string,
  score: number,
  runAt: string,
): void {
  const prev = state[taskId] ?? defaultTaskState();
  state[taskId] = {
    enabled: prev.enabled,
    lastScore: score,
    lastRunAt: runAt,
    runs: prev.runs + 1,
    sumScore: prev.sumScore + score,
  };
}

function fmtNum(n: number | null): string {
  if (n === null) return "null";
  // Avoid noisy floats like 0.6100000000000001 — round display to 4 dp, strip trailing zeros
  const s = Number.parseFloat(n.toFixed(6)).toString();
  return s;
}

function serializeState(state: Record<string, TaskState>): string {
  const ids = Object.keys(state).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const rows = ids.map((id) => {
    const s = state[id]!;
    const lastRunAt = s.lastRunAt ? `"${s.lastRunAt}"` : "null";
    return `  ${id}: { enabled: ${s.enabled}, lastScore: ${fmtNum(s.lastScore)}, lastRunAt: ${lastRunAt}, runs: ${s.runs}, sumScore: ${fmtNum(s.sumScore)} },`;
  });
  return [
    "export type TaskState = {",
    "  enabled: boolean;",
    "  lastScore: number | null;",
    "  lastRunAt: string | null;",
    "  runs: number;",
    "  sumScore: number;",
    "};",
    "",
    "export const tasksState: Record<string, TaskState> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}

// Concurrent endTrial callers all flow through this chain — last write wins
// without corrupting (atomic rename) and without losing updates (the shared
// state object accumulates mutations before each serialize).
let writeChain: Promise<void> = Promise.resolve();

export function persistState(state: Record<string, TaskState>): Promise<void> {
  writeChain = writeChain.then(() => {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, serializeState(state));
    renameSync(tmp, STATE_FILE);
  });
  return writeChain;
}

export function selectTasks(
  allTaskIds: string[],
  argvFilter: Set<string>,
  state: Record<string, TaskState>,
): { runIds: Set<string>; skippedDisabled: string[] } {
  if (argvFilter.size > 0) {
    // Explicit argv overrides the enabled flag
    return { runIds: new Set(argvFilter), skippedDisabled: [] };
  }
  const runIds = new Set<string>();
  const skipped: string[] = [];
  for (const id of allTaskIds) {
    const s = state[id];
    if (!s || s.enabled) runIds.add(id);
    else skipped.push(id);
  }
  return { runIds, skippedDisabled: skipped };
}

export type FinalSummary = {
  executedCount: number;
  executedPct: number; // average over tasks actually executed this run
  totalCount: number; // executed + skipped-with-history
  totalPct: number; // average using lastScore for skipped tasks
};

export function computeSummary(
  thisRun: Array<[string, number]>,
  state: Record<string, TaskState>,
  skippedDisabled: string[],
): FinalSummary {
  const executedSum = thisRun.reduce((acc, [, s]) => acc + s, 0);
  const executedCount = thisRun.length;
  const executedPct = executedCount > 0 ? (executedSum / executedCount) * 100 : 0;

  let extraSum = 0;
  let extraCount = 0;
  for (const id of skippedDisabled) {
    const s = state[id];
    if (s && s.lastScore !== null) {
      extraSum += s.lastScore;
      extraCount++;
    }
  }
  const totalCount = executedCount + extraCount;
  const totalPct =
    totalCount > 0 ? ((executedSum + extraSum) / totalCount) * 100 : 0;

  return { executedCount, executedPct, totalCount, totalPct };
}
