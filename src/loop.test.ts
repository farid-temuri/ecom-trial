import { describe, expect, test } from "bun:test";
import { Outcome } from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import { runAgent, type RunAgentDeps } from "./loop";
import type { Config } from "./config";
import { makeFakeVm, scriptedLlm } from "./test-helpers";
import type { TrialEvent } from "../events";

function baseConfig(over: Partial<Config["features"]> = {}): Config {
  return {
    features: {
      lazyMd: false,
      autoCite: false,
      strictRefs: false,
      citingReasoning: false,
      structuredFacts: false,
      refsWhyCanonical: false,
      debugRefProbe: false,
      ...over,
    },
    reasoningEffort: "off",
    openrouter: { url: "http://test", apiKey: "k", timeoutMs: 1000, maxAttempts: 1 },
  };
}

// Drive runAgent with injected fakes. Returns the recorded vm.answer calls and
// emitted events.
async function run(
  codes: string[],
  opts: { config?: Config; vmOpts?: Parameters<typeof makeFakeVm>[0] } = {},
): Promise<{ calls: ReturnType<typeof makeFakeVm>["calls"]; events: TrialEvent[]; llmCalls: number }> {
  const { vm, calls } = makeFakeVm(opts.vmOpts);
  const { llm, callCount } = scriptedLlm(codes);
  const events: TrialEvent[] = [];
  const deps: RunAgentDeps = {
    config: opts.config ?? baseConfig(),
    llm,
    makeVm: () => vm,
    emit: (e) => events.push(e),
  };
  await runAgent("model", "http://harness", "do the task", "t01", deps);
  return { calls, events, llmCalls: callCount() };
}

describe("runAgent happy path", () => {
  test("submits the answer once with the right outcome and refs", async () => {
    const code = `
      await harness.read({ path: "/a.json" });
      scratchpad.refs = ["/a.json"];
      scratchpad.outcome = "OUTCOME_OK";
      scratchpad.answer = "Total: 1";
      await harness.answer(scratchpad, () => ({ ok: true }));
    `;
    const { calls, events, llmCalls } = await run([code], {
      vmOpts: { files: { "/a.json": "{}" } },
    });
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0]!.outcome).toBe(Outcome.OK);
    expect(calls.answer[0]!.refs).toEqual(["/a.json"]);
    expect(llmCalls).toBe(1); // returned immediately after answering
    // a system_prompt bootstrap and a step event were emitted
    expect(events.some((e) => e.type === "bootstrap" && e.tool === "system_prompt")).toBe(true);
    expect(events.some((e) => e.type === "step")).toBe(true);
  });
});

describe("runAgent no-answer gate", () => {
  test("submits OUTCOME_ERR_INTERNAL when the model never answers", async () => {
    // Code that never calls harness.answer.
    const { calls } = await run([`console.log("thinking");`]);
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0]!.outcome).toBe(Outcome.ERR_INTERNAL);
    expect(calls.answer[0]!.message).toContain("did not submit");
    expect(calls.answer[0]!.refs).toEqual([]);
  });
});

describe("runAgent gate-rejection recovery", () => {
  test("a rejected submission is retried and then succeeds (answer called once)", async () => {
    const bad = `
      scratchpad.refs = ["/never.json"];
      scratchpad.outcome = "OUTCOME_OK";
      scratchpad.answer = "x";
      await harness.answer(scratchpad, () => true);
    `;
    const good = `
      await harness.read({ path: "/a.json" });
      scratchpad.refs = ["/a.json"];
      scratchpad.outcome = "OUTCOME_OK";
      scratchpad.answer = "x";
      await harness.answer(scratchpad, () => true);
    `;
    const { calls, events, llmCalls } = await run([bad, good], {
      vmOpts: { files: { "/a.json": "{}" } },
    });
    // Only the successful submission reaches vm.answer.
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0]!.refs).toEqual(["/a.json"]);
    expect(llmCalls).toBe(2);
    // The first step recorded the gate error.
    const errStep = events.find(
      (e) => e.type === "step" && e.ok === false && /never opened/.test(e.errorMessage ?? ""),
    );
    expect(errStep).toBeDefined();
  });
});

describe("runAgent canonical citation mode", () => {
  test("scratchpad.cite drives refs and the answer submits", async () => {
    const code = `
      await harness.read({ path: "/policy.md" });
      scratchpad.cite("/policy.md", "policy governing the decision");
      scratchpad.outcome = "OUTCOME_OK";
      scratchpad.answer = "<NO>";
      await harness.answer(scratchpad, () => true);
    `;
    const { calls } = await run([code], {
      config: baseConfig({ refsWhyCanonical: true }),
      vmOpts: { files: { "/policy.md": "rule" } },
    });
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0]!.refs).toEqual(["/policy.md"]);
  });
});
