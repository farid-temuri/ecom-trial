import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { join } from "path";
import type { TrialEvent } from "./events";

const RUNS_DIR = join(import.meta.dir, "runs");
const HINTS_PATH = join(import.meta.dir, "hints", "system.md");

function ensureRunsDir(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

export function makeRunId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = randomBytes(3).toString("hex");
  return `${date}-${time}-${rand}`;
}

export function loadHints(): { text: string; hash: string } {
  const text = existsSync(HINTS_PATH) ? readFileSync(HINTS_PATH, "utf8") : "";
  const hash = "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { text, hash };
}

export function saveHints(text: string): { hash: string } {
  const dir = join(import.meta.dir, "hints");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  Bun.write(HINTS_PATH, text);
  const hash = "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { hash };
}

export function openRunWriter(runId: string): {
  write: (e: TrialEvent) => void;
  close: () => void;
} {
  ensureRunsDir();
  const path = join(RUNS_DIR, `${runId}.jsonl`);
  return {
    write(e: TrialEvent): void {
      try {
        appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
      } catch (err) {
        console.error("logs.write failed:", err);
      }
    },
    close(): void {
      // appendFileSync is synchronous; nothing to flush.
    },
  };
}

export type RunSummary = {
  runId: string;
  startedAt: number;
  endedAt?: number;
  modelId?: string;
  benchmarkId?: string;
  hintsHash?: string;
  scores: Record<string, number | null>;
  finalPct?: number;
  status: "running" | "done" | "incomplete";
};

function readJsonlLines(path: string): TrialEvent[] {
  const text = readFileSync(path, "utf8");
  const out: TrialEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TrialEvent);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function readRun(runId: string): TrialEvent[] {
  const path = join(RUNS_DIR, `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  return readJsonlLines(path);
}

export function listRuns(): RunSummary[] {
  ensureRunsDir();
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".jsonl"));
  const summaries: RunSummary[] = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, "");
    const events = readJsonlLines(join(RUNS_DIR, f));
    if (events.length === 0) continue;
    const start = events.find((e) => e.type === "run:start");
    const end = events.find((e) => e.type === "run:end");
    const scores: Record<string, number | null> = {};
    for (const e of events) {
      if (e.type === "trial:end") {
        scores[e.taskId] = e.scoreAvailable ? (e.score ?? 0) : null;
      }
    }
    summaries.push({
      runId,
      startedAt: start?.ts ?? 0,
      endedAt: end?.ts,
      modelId: start && start.type === "run:start" ? start.modelId : undefined,
      benchmarkId:
        start && start.type === "run:start" ? start.benchmarkId : undefined,
      hintsHash:
        start && start.type === "run:start" ? start.hintsHash : undefined,
      scores,
      finalPct: end && end.type === "run:end" ? end.finalPct : undefined,
      status: end ? "done" : start ? "incomplete" : "running",
    });
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}

export type FailureCluster = {
  detail: string;
  count: number;
  taskIds: string[];
  runIds: string[];
};

export function clusterFailures(): FailureCluster[] {
  const summaries = listRuns();
  const byDetail = new Map<
    string,
    { detail: string; taskIds: Set<string>; runIds: Set<string>; count: number }
  >();
  for (const s of summaries) {
    const events = readRun(s.runId);
    for (const e of events) {
      if (e.type !== "trial:end") continue;
      if (!e.scoreAvailable) continue;
      if ((e.score ?? 0) >= 1) continue;
      for (const d of e.scoreDetail ?? []) {
        const detail = d.trim();
        if (!detail) continue;
        let bucket = byDetail.get(detail);
        if (!bucket) {
          bucket = {
            detail,
            taskIds: new Set(),
            runIds: new Set(),
            count: 0,
          };
          byDetail.set(detail, bucket);
        }
        bucket.taskIds.add(e.taskId);
        bucket.runIds.add(s.runId);
        bucket.count++;
      }
    }
  }
  return [...byDetail.values()]
    .map((b) => ({
      detail: b.detail,
      count: b.count,
      taskIds: [...b.taskIds].sort(),
      runIds: [...b.runIds].sort(),
    }))
    .sort((a, b) => b.count - a.count);
}
