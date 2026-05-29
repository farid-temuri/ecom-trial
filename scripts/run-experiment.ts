// Orchestrator for flag-bisection experiments.
//
// Usage: bun run scripts/run-experiment.ts <config-name> <FLAG=val,FLAG=val> <run-count>
// Example: bun run scripts/run-experiment.ts solo_LAZY_MD "FEAT_LAZY_MD=true" 2
//
// Writes per-run results to docs/flag-experiments.results.jsonl and appends a
// row to docs/flag-experiments.md.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const TASKS = ["t02", "t13", "t22", "t27", "t34", "t39", "t41"];
const REPO = process.cwd();
const RESULTS_JSONL = `${REPO}/docs/flag-experiments.results.jsonl`;
const REPORT_MD = `${REPO}/docs/flag-experiments.md`;

type RunResult = {
  config: string;
  flags: Record<string, string>;
  runIdx: number;
  runId?: string;
  scores: Record<string, number>;
  perTaskAvg?: Record<string, number>;
  finalPct?: number;
  durationSec: number;
  stdoutTail: string;
};

function parseFlags(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s.trim()) return out;
  for (const kv of s.split(",")) {
    const [k, v] = kv.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

async function runOne(
  config: string,
  flags: Record<string, string>,
  runIdx: number,
): Promise<RunResult> {
  const env: Record<string, string> = {
    ...process.env,
    WEB_PORT: "0",
    // ensure default-off flags start OFF unless explicitly enabled
    FEAT_LAZY_MD: "false",
    FEAT_READ_BEFORE_MUTATE: "false",
    FEAT_AUTO_CITE: "false",
    FEAT_ALLOWED_OPS: "false",
    FEAT_GATE_OUTCOME: "false",
    FEAT_STRICT_REFS: "false",
    ...flags,
  };

  const start = Date.now();
  const child = spawn("bun", ["run", "main.ts", ...TASKS], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    // Live tail so we know something's happening
    process.stdout.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    process.stderr.write(s);
  });

  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const durationSec = Math.round((Date.now() - start) / 1000);

  // Parse per-task scores: lines like `tXX: 0.50`
  const scores: Record<string, number> = {};
  const re = /^(t\d+):\s+([0-9]+(?:\.[0-9]+)?)\s*$/gm;
  // Strip ANSI codes first
  const clean = stdout.replace(/\x1B\[[0-9;]*m/g, "");
  for (const m of clean.matchAll(re)) {
    scores[m[1]] = Number(m[2]);
  }

  // runId
  const idMatch = clean.match(/Run ID:\s+(\S+)/);
  const runId = idMatch?.[1];

  // finalPct
  const finalMatch = clean.match(/FINAL[^:]*:\s+([0-9.]+)%/);
  const finalPct = finalMatch ? Number(finalMatch[1]) : undefined;

  const result: RunResult = {
    config,
    flags,
    runIdx,
    runId,
    scores,
    finalPct,
    durationSec,
    stdoutTail: clean.slice(-2000),
  };
  appendFileSync(RESULTS_JSONL, JSON.stringify(result) + "\n");
  return result;
}

function aggregate(results: RunResult[]): { perTaskAvg: Record<string, number>; meanPct: number } {
  const perTaskAvg: Record<string, number> = {};
  for (const t of TASKS) {
    const vals = results.map((r) => r.scores[t]).filter((v) => typeof v === "number");
    perTaskAvg[t] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }
  const total = TASKS.reduce((a, t) => a + (perTaskAvg[t] || 0), 0);
  const meanPct = (total / TASKS.length) * 100;
  return { perTaskAvg, meanPct };
}

function appendReportRow(
  config: string,
  flags: Record<string, string>,
  perTaskAvg: Record<string, number>,
  meanPct: number,
  runs: RunResult[],
): void {
  const md = readFileSync(REPORT_MD, "utf8");
  const header =
    "| Config | Flags | " + TASKS.join(" | ") + " | Mean% | RunIds |";
  const sep = "| --- | --- | " + TASKS.map(() => "---").join(" | ") + " | --- | --- |";
  const flagStr = Object.keys(flags).length
    ? Object.entries(flags).map(([k, v]) => `${k}=${v}`).join(" ")
    : "(all OFF)";
  const row =
    `| ${config} | ${flagStr} | ` +
    TASKS.map((t) => (Number.isFinite(perTaskAvg[t]) ? perTaskAvg[t].toFixed(2) : "—")).join(" | ") +
    ` | **${meanPct.toFixed(1)}%** | ${runs.map((r) => r.runId ?? "?").join(", ")} |`;

  if (!md.includes("| Config | Flags |")) {
    writeFileSync(REPORT_MD, md + "\n\n" + header + "\n" + sep + "\n" + row + "\n");
  } else {
    writeFileSync(REPORT_MD, md.trimEnd() + "\n" + row + "\n");
  }
}

async function main(): Promise<void> {
  const [, , config, flagsStr = "", countStr = "2"] = process.argv;
  if (!config) {
    console.error("usage: bun run scripts/run-experiment.ts <config> <FLAG=val,...> <count>");
    process.exit(2);
  }
  const flags = parseFlags(flagsStr);
  const count = Number(countStr);

  console.log(`\n===== ${config} x${count} =====`);
  console.log("flags:", flags);

  const results: RunResult[] = [];
  const interRunSleepMs = Number(process.env.INTER_RUN_SLEEP_MS ?? "75000");
  for (let i = 1; i <= count; i++) {
    console.log(`\n--- ${config} run ${i}/${count} ---`);
    let r = await runOne(config, flags, i);
    // Retry rate-limit hits with a 75s sleep
    let retries = 0;
    while (
      (r.finalPct === undefined || Object.keys(r.scores).length === 0) &&
      r.stdoutTail.includes("run rate limit hit") &&
      retries < 3
    ) {
      retries++;
      console.log(`[${config}] rate-limit hit, sleeping 75s then retrying (${retries}/3)`);
      await new Promise((res) => setTimeout(res, 75000));
      r = await runOne(config, flags, i);
    }
    console.log(
      `[${config} run ${i}] scores:`,
      r.scores,
      "final%:",
      r.finalPct,
      "(",
      r.durationSec,
      "s )",
    );
    results.push(r);
    if (i < count && interRunSleepMs > 0) {
      console.log(`[${config}] sleeping ${interRunSleepMs}ms before next run`);
      await new Promise((res) => setTimeout(res, interRunSleepMs));
    }
  }

  const { perTaskAvg, meanPct } = aggregate(results);
  console.log(`\n[${config}] avg per task:`, perTaskAvg);
  console.log(`[${config}] mean across tasks: ${meanPct.toFixed(2)}%`);
  appendReportRow(config, flags, perTaskAvg, meanPct, results);
}

await main();
