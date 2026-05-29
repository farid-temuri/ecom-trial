import { ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  HarnessService,
  EvalPolicy,
} from "@buf/bitgn_api.bufbuild_es/bitgn/harness_pb";
import { runAgent } from "./agent";
import { bus } from "./events";
import { startWebServer } from "./web";
import { loadHints, makeRunId, openRunWriter } from "./logs";
import {
  loadState,
  updateTaskState,
  persistState,
  selectTasks,
  computeSummary,
} from "./tasksStateIO";

const BITGN_URL =
  process.env.BITGN_HOST ?? process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const BITGN_API_KEY = process.env.BITGN_API_KEY ?? "";
const BENCH_ID = process.env.BENCH_ID ?? process.env.BENCHMARK_ID ?? "bitgn/ecom1-dev";
const MODEL_ID = process.env.MODEL_ID ?? "z-ai/glm-5.1";
const MAX_TASKS = process.env.MAX_TASKS ? Number(process.env.MAX_TASKS) : Infinity;
const WEB_PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;
const CONCURRENCY = Math.max(
  1,
  process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 1,
);

class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private available: number) {}
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available--;
  }
  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const CLI = {
  red: "\x1B[31m",
  green: "\x1B[32m",
  blue: "\x1B[34m",
  clr: "\x1B[0m",
} as const;

function policyName(p: EvalPolicy): string {
  return EvalPolicy[p] ?? `EvalPolicy(${p})`;
}

const SCORE_POLL_TIMEOUT_MS = process.env.SCORE_POLL_TIMEOUT_MS
  ? Number(process.env.SCORE_POLL_TIMEOUT_MS)
  : 5 * 60 * 1000;
const SCORE_POLL_INITIAL_DELAY_MS = 3000;
const SCORE_POLL_MAX_DELAY_MS = 15000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type ScoredTrial = {
  taskId: string;
  trialId: string;
  score: number;
  scoreDetail: string[];
};

async function fetchScoreDetail(
  client: ReturnType<typeof createClient<typeof HarnessService>>,
  trialId: string,
): Promise<string[]> {
  try {
    const t = await client.getTrial({ trialId });
    return t.scoreDetail ?? [];
  } catch (err) {
    console.error(`  getTrial(${trialId}) failed:`, err);
    return [];
  }
}

async function batchFetchScores(
  client: ReturnType<typeof createClient<typeof HarnessService>>,
  runId: string,
): Promise<ScoredTrial[]> {
  const start = Date.now();
  let delay = SCORE_POLL_INITIAL_DELAY_MS;
  let attempt = 0;
  const collect = async (
    trials: Array<{ taskId: string; trialId: string; score?: number; scoreAvailable: boolean }>,
  ): Promise<ScoredTrial[]> => {
    const scored = trials.filter((t) => t.scoreAvailable && typeof t.score === "number");
    return Promise.all(
      scored.map(async (t) => ({
        taskId: t.taskId,
        trialId: t.trialId,
        score: t.score as number,
        scoreDetail: await fetchScoreDetail(client, t.trialId),
      })),
    );
  };
  while (Date.now() - start < SCORE_POLL_TIMEOUT_MS) {
    attempt++;
    try {
      const r = await client.getRun({ runId });
      const scoredCount = r.trials.filter(
        (t) => t.scoreAvailable && typeof t.score === "number",
      ).length;
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(
        `  [poll ${attempt}] scored ${scoredCount}/${r.trials.length} (runScoreAvailable=${r.scoreAvailable}, elapsed=${elapsed}s)`,
      );
      if (r.scoreAvailable || scoredCount === r.trials.length) {
        return collect(r.trials);
      }
    } catch (err) {
      console.error(`  [poll ${attempt}] getRun error:`, err);
    }
    await sleep(delay);
    delay = Math.min(Math.floor(delay * 1.5), SCORE_POLL_MAX_DELAY_MS);
  }
  console.log(
    `score-poll timed out after ${Math.round((Date.now() - start) / 1000)}s — returning whatever landed`,
  );
  try {
    const r = await client.getRun({ runId });
    return collect(r.trials);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const argvFilter = new Set(process.argv.slice(2));
  const taskStateMap = loadState();
  const scores: Array<[string, number]> = [];

  const web = WEB_PORT > 0 ? startWebServer(WEB_PORT) : null;
  if (web) console.log(`${CLI.blue}Web UI: ${web.url}${CLI.clr}`);

  const runId = makeRunId();
  const writer = openRunWriter(runId);
  const unsubscribe = bus.on((e) => writer.write(e));
  console.log(`${CLI.blue}Run ID: ${runId}${CLI.clr}`);

  const transport = createConnectTransport({ baseUrl: BITGN_URL, httpVersion: "1.1" });
  const client = createClient(HarnessService, transport);

  try {
    const status = await client.status({});
    console.log("Connecting to BitGN", status);

    const bench = await client.getBenchmark({ benchmarkId: BENCH_ID });
    console.log(
      `${policyName(bench.policy)} benchmark: ${bench.benchmarkId} with ${bench.tasks.length} tasks.\n${CLI.green}${bench.description}${CLI.clr}`,
    );

    const hints = loadHints();
    const envFlags = {
      FEAT_LAZY_MD: process.env.FEAT_LAZY_MD ?? "",
      FEAT_READ_BEFORE_MUTATE: process.env.FEAT_READ_BEFORE_MUTATE ?? "",
      FEAT_AUTO_CITE: process.env.FEAT_AUTO_CITE ?? "",
      FEAT_ALLOWED_OPS: process.env.FEAT_ALLOWED_OPS ?? "",
      FEAT_GATE_OUTCOME: process.env.FEAT_GATE_OUTCOME ?? "",
      FEAT_STRICT_REFS: process.env.FEAT_STRICT_REFS ?? "",
      CITING_REASONING: process.env.CITING_REASONING ?? "",
      STRUCTURED_FACTS: process.env.STRUCTURED_FACTS ?? "",
      REASONING_EFFORT: process.env.REASONING_EFFORT ?? "",
      JUDGE_REASONING_EFFORT: process.env.JUDGE_REASONING_EFFORT ?? "",
      JUDGE_ENABLED: process.env.JUDGE_ENABLED ?? "",
      JUDGE_MODEL: process.env.JUDGE_MODEL ?? "",
    };
    bus.emit({
      type: "run:start",
      runId,
      benchmarkId: bench.benchmarkId,
      modelId: MODEL_ID,
      policy: policyName(bench.policy),
      description: bench.description,
      tasks: bench.tasks.map((t) => ({ taskId: t.taskId, hint: t.hint })),
      hints: hints.text,
      hintsHash: hints.hash,
      envFlags,
      ts: Date.now(),
    });

    const run = await client.startRun({
      name: `GeorgeDroid [${MODEL_ID}]`,
      benchmarkId: BENCH_ID,
      apiKey: BITGN_API_KEY,
    });

    // Ctrl-C handler: force-submit the run so in-flight trials are recorded
    // (forfeited as 0) and the run isn't left orphaned. Scores for completed
    // trials are preserved by BitGN — recover via `bun run finalizeRun.ts <runId>`.
    let cleaningUp = false;
    const onSignal = (sig: string): void => {
      if (cleaningUp) {
        console.log(`\n${sig} again — hard exit`);
        process.exit(130);
      }
      cleaningUp = true;
      console.log(
        `\n${sig} received — force-submitting run ${run.runId} (in-flight trials forfeit). Scores landed so far are preserved.`,
      );
      void (async () => {
        try {
          await client.submitRun({ runId: run.runId, force: true });
          console.log(`Submitted. Recover scores: bun run finalizeRun.ts ${run.runId}`);
        } catch (err) {
          console.error("submitRun on signal failed:", err);
        } finally {
          process.exit(130);
        }
      })();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    try {
      const sem = new Semaphore(CONCURRENCY);
      let executed = 0;
      console.log(`${CLI.blue}Concurrency: ${CONCURRENCY}${CLI.clr}`);

      const shouldRunTask = (taskId: string): boolean => {
        if (argvFilter.size > 0) return argvFilter.has(taskId);
        const s = taskStateMap[taskId];
        return !s || s.enabled;
      };

      const trialJobs = run.trialIds.map((trialId) => async () => {
        await sem.acquire();
        try {
          const trial = await client.startTrial({ trialId });
          if (executed >= MAX_TASKS || !shouldRunTask(trial.taskId)) {
            // CRITICAL: must endTrial even when skipping — leaving trials open
            // makes BitGN reject submitRun. We don't update tasksState here
            // (preserves lastScore for tasks we chose not to re-run).
            const reason =
              executed >= MAX_TASKS
                ? `MAX_TASKS=${MAX_TASKS} cap reached`
                : "disabled in tasksState.ts";
            console.log(`${CLI.blue}[${trial.taskId}] closing trial (${reason})${CLI.clr}`);
            try {
              await client.endTrial({ trialId: trial.trialId });
            } catch (err) {
              console.error(`[${trial.taskId}] endTrial-on-skip failed:`, err);
            }
            return;
          }
          executed++;
          const tag = `[${trial.taskId}]`;

          console.log(`${"=".repeat(20)} ${tag} START ${"=".repeat(20)}`);
          console.log(`${CLI.blue}${tag} ${trial.instruction}${CLI.clr}`);
          bus.emit({
            type: "trial:start",
            taskId: trial.taskId,
            trialId: trial.trialId,
            instruction: trial.instruction,
            ts: Date.now(),
          });
          try {
            await runAgent(MODEL_ID, trial.harnessUrl, trial.instruction, trial.taskId);
          } catch (err) {
            console.error(tag, err);
          }

          const endRes = await client.endTrial({ trialId: trial.trialId });
          // Score is fetched in bulk after the whole run is submitted — see
          // batchFetchScores below. Per-trial polling here blocks sem slots
          // and serializes everyone behind scoring latency.
          bus.emit({
            type: "trial:end",
            taskId: trial.taskId,
            scoreAvailable: endRes.scoreAvailable,
            score: endRes.score,
            scoreDetail: endRes.scoreDetail,
            ts: Date.now(),
          });
          console.log(`${CLI.blue}${tag} agent done (scoring deferred)${CLI.clr}`);
        } finally {
          sem.release();
        }
      });

      await Promise.all(trialJobs.map((job) => job()));
      console.log(`${CLI.blue}All trials closed — submitting run for grading${CLI.clr}`);
    } finally {
      // force=false: only submits if all trials are terminal (DONE/ERROR).
      // If any trial slipped through unclosed, retry with force=true as a
      // backstop so we don't leave the run orphaned.
      try {
        await client.submitRun({ runId: run.runId, force: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unfinished trials")) {
          console.error(
            `submitRun(force=false) refused — unfinished trials. Retrying with force=true (in-flight forfeit).`,
          );
          try {
            await client.submitRun({ runId: run.runId, force: true });
          } catch (err2) {
            console.error("submitRun(force=true) also failed:", err2);
          }
        } else {
          console.error("submitRun failed:", err);
        }
      }
    }

    console.log(`${CLI.blue}Fetching scores for run ${run.runId}${CLI.clr}`);
    const fetched = await batchFetchScores(client, run.runId);
    for (const t of fetched) {
      scores.push([t.taskId, t.score]);
      updateTaskState(taskStateMap, t.taskId, t.score, new Date().toISOString());
      if (t.scoreDetail.length > 0) {
        const style = t.score === 1 ? CLI.green : CLI.red;
        for (const d of t.scoreDetail) {
          console.log(`  ${style}[${t.taskId} grader] ${d}${CLI.clr}`);
        }
      }
      bus.emit({
        type: "trial:score",
        taskId: t.taskId,
        trialId: t.trialId,
        score: t.score,
        scoreDetail: t.scoreDetail,
        ts: Date.now(),
      });
    }
    try {
      await persistState(taskStateMap);
    } catch (err) {
      console.error("failed to persist tasksState:", err);
    }
  } catch (err) {
    if (err instanceof ConnectError) {
      console.log(`${err.code}: ${err.message}`);
    } else {
      throw err;
    }
  }

  let finalPct: number | undefined;
  if (scores.length > 0) {
    scores.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    for (const [taskId, score] of scores) {
      const style = score === 1 ? CLI.green : CLI.red;
      console.log(`${taskId}: ${style}${score.toFixed(2)}${CLI.clr}`);
    }
    const executedIds = new Set(scores.map(([id]) => id));
    const skipped = Object.keys(taskStateMap).filter((id) => !executedIds.has(id));
    const summary = computeSummary(scores, taskStateMap, skipped);
    finalPct = summary.executedPct;
    console.log(
      `FINAL (this run, ${summary.executedCount} executed): ${summary.executedPct.toFixed(2)}%`,
    );
    if (skipped.length > 0) {
      console.log(
        `FULL (last-known scores over ${summary.totalCount} tasks): ${summary.totalPct.toFixed(2)}%`,
      );
    }
  }
  bus.emit({ type: "run:end", finalPct, ts: Date.now() });
  unsubscribe();
  writer.close();
  console.log(`${CLI.blue}Saved run to runs/${runId}.jsonl${CLI.clr}`);

  if (web) {
    console.log(`${CLI.blue}Web UI still running at ${web.url} (Ctrl-C to exit)${CLI.clr}`);
  }
}

await main();
