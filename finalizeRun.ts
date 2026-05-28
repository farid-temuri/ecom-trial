// Read-only score fetch for a run (by runId).
//
// Fetches via getRun (NEVER submitRun — that flag is destructive while trials
// are still in flight) and persists landed scores into tasksState.ts.
//
// Usage:
//   bun run finalizeRun.ts <runId>
//
// Safe to call repeatedly while a benchmark is still running — it only reads.
// Run periodically; when all trials report scoreAvailable=true, you're done.
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HarnessService, TrialState } from "@buf/bitgn_api.bufbuild_es/bitgn/harness_pb";
import { loadState, updateTaskState, persistState } from "./tasksStateIO";

const BITGN_URL =
  process.env.BITGN_HOST ?? process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: bun run finalizeRun.ts <runId>");
    process.exit(1);
  }
  const transport = createConnectTransport({ baseUrl: BITGN_URL, httpVersion: "1.1" });
  const client = createClient(HarnessService, transport);

  console.log(`Fetching run ${runId}...`);
  const run = await client.getRun({ runId });
  console.log(
    `Run: ${run.runId} | benchmark=${run.benchmarkId} | name=${run.name} | trials=${run.trials.length} | runScoreAvailable=${run.scoreAvailable} | runScore=${run.score}`,
  );

  // Terminal states: DONE (3), ERROR (4). Anything else is still in flight.
  const inFlight = run.trials.filter(
    (t) => t.state !== TrialState.DONE && t.state !== TrialState.ERROR,
  );
  if (inFlight.length > 0) {
    console.log(
      `\nWARNING: ${inFlight.length}/${run.trials.length} trials are still in progress (state != SUCCESS/FAILED).`,
    );
    console.log(
      "Wait for them to complete naturally, then re-run this script. Do NOT call submitRun({force:true}) — that kills in-flight trials and zeros their scores.",
    );
  }

  const state = loadState();
  const ts = new Date().toISOString();
  let scored = 0;
  let unscored = 0;
  const fullScored: Array<[string, number]> = [];

  for (const t of run.trials) {
    if (t.scoreAvailable && typeof t.score === "number") {
      updateTaskState(state, t.taskId, t.score, ts);
      fullScored.push([t.taskId, t.score]);
      scored++;
    } else {
      unscored++;
    }
  }

  if (scored > 0) await persistState(state);
  console.log(
    `\nUpdated tasksState.ts: ${scored} newly persisted, ${unscored} not yet scored`,
  );

  if (fullScored.length > 0) {
    fullScored.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    console.log("\n=== scores ===");
    for (const [taskId, s] of fullScored) console.log(`  ${taskId}: ${s.toFixed(2)}`);
    const avg = fullScored.reduce((acc, [, s]) => acc + s, 0) / fullScored.length;
    console.log(`\nMEAN over ${fullScored.length} scored: ${(avg * 100).toFixed(2)}%`);
  }
}

await main();
