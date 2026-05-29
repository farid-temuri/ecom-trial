// Force-stop a run on demand.
//
// Calls submitRun({force:true}) — in-flight trials forfeit (graded 0 by BitGN),
// trials that already landed scores are preserved. After stopping, recover
// landed scores into tasksState.ts via finalizeRun.ts.
//
// Usage:
//   bun run stopRun.ts <runId>
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HarnessService } from "@buf/bitgn_api.bufbuild_es/bitgn/harness_pb";

const BITGN_URL =
  process.env.BITGN_HOST ?? process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: bun run stopRun.ts <runId>");
    process.exit(1);
  }

  const transport = createConnectTransport({ baseUrl: BITGN_URL, httpVersion: "1.1" });
  const client = createClient(HarnessService, transport);

  console.log(`Force-stopping run ${runId} (in-flight trials forfeit)...`);
  await client.submitRun({ runId, force: true });
  console.log(`Stopped. Recover landed scores: bun run finalizeRun.ts ${runId}`);
}

await main();
