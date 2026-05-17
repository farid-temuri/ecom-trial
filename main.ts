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

const BITGN_URL =
  process.env.BITGN_HOST ?? process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const BITGN_API_KEY = process.env.BITGN_API_KEY ?? "";
const BENCH_ID = process.env.BENCH_ID ?? process.env.BENCHMARK_ID ?? "bitgn/ecom1-dev";
const MODEL_ID = process.env.MODEL_ID ?? "z-ai/glm-5.1";
const MAX_TASKS = process.env.MAX_TASKS ? Number(process.env.MAX_TASKS) : Infinity;
const WEB_PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;

const CLI = {
  red: "\x1B[31m",
  green: "\x1B[32m",
  blue: "\x1B[34m",
  clr: "\x1B[0m",
} as const;

function policyName(p: EvalPolicy): string {
  return EvalPolicy[p] ?? `EvalPolicy(${p})`;
}

async function main(): Promise<void> {
  const taskFilter = new Set(process.argv.slice(2));
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
      ts: Date.now(),
    });

    const run = await client.startRun({
      name: "ECOM TypeScript Sample",
      benchmarkId: BENCH_ID,
      apiKey: BITGN_API_KEY,
    });

    try {
      let executed = 0;
      for (const trialId of run.trialIds) {
        if (executed >= MAX_TASKS) break;
        const trial = await client.startTrial({ trialId });
        if (taskFilter.size > 0 && !taskFilter.has(trial.taskId)) continue;
        executed++;

        console.log(`${"=".repeat(30)} Starting task: ${trial.taskId} ${"=".repeat(30)}`);
        console.log(`${CLI.blue}${trial.instruction}${CLI.clr}\n${"-".repeat(80)}`);
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
          console.error(err);
        }

        const result = await client.endTrial({ trialId: trial.trialId });
        if (result.scoreAvailable) {
          const score = result.score ?? 0;
          scores.push([trial.taskId, score]);
          const style = score === 1 ? CLI.green : CLI.red;
          const explain = result.scoreDetail.map((s) => `  ${s}`).join("\n");
          console.log(`\n${style}Score: ${score.toFixed(2)}\n${explain}\n${CLI.clr}`);
        } else {
          console.log(`\n${CLI.blue}Score: not available${CLI.clr}\n`);
        }
        bus.emit({
          type: "trial:end",
          taskId: trial.taskId,
          scoreAvailable: result.scoreAvailable,
          score: result.score,
          scoreDetail: result.scoreDetail,
          ts: Date.now(),
        });
      }
    } finally {
      await client.submitRun({ runId: run.runId, force: true });
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
    for (const [taskId, score] of scores) {
      const style = score === 1 ? CLI.green : CLI.red;
      console.log(`${taskId}: ${style}${score.toFixed(2)}${CLI.clr}`);
    }
    finalPct = (scores.reduce((acc, [, s]) => acc + s, 0) / scores.length) * 100;
    console.log(`FINAL: ${finalPct.toFixed(2)}%`);
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
