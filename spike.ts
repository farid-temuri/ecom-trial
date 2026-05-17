import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HarnessService } from "@buf/bitgn_api.bufbuild_es/bitgn/harness_pb";

const baseUrl =
  process.env.BITGN_HOST ?? process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const benchId = process.env.BENCH_ID ?? process.env.BENCHMARK_ID ?? "bitgn/ecom1-dev";

const transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });
const client = createClient(HarnessService, transport);

const status = await client.status({});
console.log("status:", status);

const bench = await client.getBenchmark({ benchmarkId: benchId });
console.log(
  `benchmark: ${bench.benchmarkId} policy=${bench.policy} tasks=${bench.tasks.length}`,
);
console.log(bench.description);
