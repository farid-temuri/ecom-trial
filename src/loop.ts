import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  EcomRuntime,
  Outcome,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import { type Config, loadConfig } from "./config";
import { buildHarness } from "./harness";
import { makeOpenRouterClient, type LlmClient } from "./openrouter";
import { parseNextStep } from "./parse";
import { truncateForLog } from "./format";
import { buildSystemPrompt } from "./prompt";
import { executeScript } from "./sandbox";
import { preloadContext } from "./preload";
import { CLI } from "./cli";
import { errMsg } from "./util";
import type {
  ChatMessage,
  LlmCallResult,
  NextStep,
  Scratchpad,
  ScriptHarness,
} from "./types";
import { bus } from "../events";
import type { TrialEvent } from "../events";
import { loadHints } from "../logs";

const NUDGE_SUBMIT = `You have not called \`await harness.answer(scratchpad, verify)\` yet. Populate scratchpad.answer, scratchpad.outcome, scratchpad.refs, define a verify(sp) that encodes the task's literal demands, then call \`await harness.answer(scratchpad, verify)\` inside your code. If you cannot determine the answer, set scratchpad.outcome = "OUTCOME_NONE_CLARIFICATION", write a verify that just returns {ok:true}, and submit.`;

const MAX_PRIMARY_STEPS = 35;
const NUDGE_EXTRA_STEPS = 5;
const BUDGET_WARNING_AT_REMAINING = 5;
const MAX_SYNTAX_REFUNDS = 3;
const MAX_RECOVERY_REFUNDS = 3;
const LAZY_MD_BUDGET_BYTES = 50_000;

type NextStepResult =
  | { ok: true; step: NextStep; raw: string; llm: LlmCallResult }
  | { ok: false; raw: string; llm: LlmCallResult | null; error: string };

// Ask the model for the next step; retry once on a parse failure with a
// corrective message. Surfaces OpenRouter failures as a structured result so
// the loop can recover rather than dying.
async function requestNextStep(
  llm: LlmClient,
  model: string,
  log: ChatMessage[],
): Promise<NextStepResult> {
  let attempt: ChatMessage[] = log;
  let lastErr: unknown;
  let lastRaw = "";
  let lastLlm: LlmCallResult | null = null;
  for (let i = 0; i < 2; i++) {
    let res: LlmCallResult;
    try {
      res = await llm(model, attempt, "medium");
    } catch (err) {
      return {
        ok: false,
        raw: lastRaw,
        llm: lastLlm,
        error: `OpenRouter call failed: ${errMsg(err)}`,
      };
    }
    lastLlm = res;
    lastRaw = res.content;
    try {
      return { ok: true, step: parseNextStep(res.content), raw: res.content, llm: res };
    } catch (err) {
      lastErr = err;
      attempt = [
        ...log,
        { role: "assistant", content: res.content },
        {
          role: "user",
          content: `Your previous response did not validate. Error: ${errMsg(
            err,
          )}\nReturn corrected JSON only — no markdown fences, no prose, just the raw JSON object.`,
        },
      ];
    }
  }
  return {
    ok: false,
    raw: lastRaw,
    llm: lastLlm,
    error: `NextStep validation failed after retry: ${String(lastErr)}`,
  };
}

export type RunAgentDeps = {
  config?: Config;
  llm?: LlmClient;
  makeVm?: (harnessUrl: string) => Client<typeof EcomRuntime>;
  emit?: (event: TrialEvent) => void;
};

function defaultMakeVm(harnessUrl: string): Client<typeof EcomRuntime> {
  const transport = createConnectTransport({ baseUrl: harnessUrl, httpVersion: "1.1" });
  return createClient(EcomRuntime, transport);
}

export async function runAgent(
  model: string,
  harnessUrl: string,
  taskText: string,
  taskId: string,
  deps: RunAgentDeps = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  const { features } = config;
  if (!deps.llm && !config.openrouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  const emit = deps.emit ?? ((e: TrialEvent) => bus.emit(e));
  const llm =
    deps.llm ??
    makeOpenRouterClient(config.openrouter, config.reasoningEffort, (m) =>
      console.error(m),
    );
  const vm = (deps.makeVm ?? defaultMakeVm)(harnessUrl);

  const openedPaths = new Set<string>();
  const readSet = new Set<string>();
  const preloadedMdPaths = new Set<string>();
  const pendingMdPaths = new Set<string>();
  const dynamicDocs: Array<{ path: string; content: string }> = [];
  const mdBudgetSkipped: Array<{ path: string; bytes: number }> = [];

  const scratchpad: Scratchpad = {
    refs: [],
    ...(features.structuredFacts ? { facts: {} } : {}),
  };

  const { agentsMd, workspaceTree, workspaceDocs, workspaceMdIndex } =
    await preloadContext({
      vm,
      taskId,
      openedPaths,
      readSet,
      preloadedMdPaths,
      scratchpad,
      features,
      emit,
    });

  // Inject scratchpad.cite(path, reason) — atomic citation under canonical mode.
  // Non-enumerable so it doesn't pollute scratchpadAfter snapshots.
  if (features.refsWhyCanonical) {
    Object.defineProperty(scratchpad, "cite", {
      value: (path: unknown, reason: unknown): void => {
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error(
            `scratchpad.cite: path must be an absolute workspace path string starting with "/". Got: ${JSON.stringify(path)}`,
          );
        }
        if (typeof reason !== "string" || reason.trim().length < 8) {
          throw new Error(
            `scratchpad.cite(${path}): reason must be a string of >= 8 non-whitespace chars explaining why THIS file's content backs the final answer. If you cannot articulate a load-bearing reason, do NOT cite this path.`,
          );
        }
        if (!readSet.has(path) && !preloadedMdPaths.has(path)) {
          throw new Error(
            `scratchpad.cite(${path}): path was not read this trial and is not preloaded. Read it via harness.read first, or remove the citation.`,
          );
        }
        const why =
          scratchpad.refs_why && typeof scratchpad.refs_why === "object"
            ? (scratchpad.refs_why as Record<string, string>)
            : ((scratchpad.refs_why = {} as Record<string, string>),
              scratchpad.refs_why as Record<string, string>);
        why[path] = reason.trim();
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });
    if (!scratchpad.refs_why || typeof scratchpad.refs_why !== "object") {
      scratchpad.refs_why = {};
    }
  }

  const harness: ScriptHarness = buildHarness({
    vm,
    state: { openedPaths, readSet, preloadedMdPaths, pendingMdPaths, scratchpad },
    features,
    taskId,
    emit: (e) => emit(e as TrialEvent),
  });

  const { text: hints } = loadHints();
  const envHint = process.env.HINT ?? "";

  const rebuildSystemPrompt = (): string =>
    buildSystemPrompt({
      features,
      agentsMd,
      workspaceTree,
      workspaceDocs,
      workspaceMdIndex: features.lazyMd ? workspaceMdIndex : [],
      dynamicDocs: features.lazyMd ? dynamicDocs : [],
      mdBudgetSkipped: features.lazyMd ? mdBudgetSkipped : [],
      scratchpad,
      hints,
      envHint,
      lazyMdBudgetBytes: LAZY_MD_BUDGET_BYTES,
    });

  // Drain pendingMdPaths: read up to LAZY_MD_BUDGET_BYTES total, append to dynamicDocs.
  const drainPendingMd = async (): Promise<void> => {
    if (pendingMdPaths.size === 0) return;
    const turnSkipped: Array<{ path: string; bytes: number }> = [];
    let used = 0;
    const drained = [...pendingMdPaths];
    for (const p of drained) {
      try {
        const r = await vm.read({ path: p, number: false, startLine: 0, endLine: 0 });
        const content = r.content ?? "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (used + bytes > LAZY_MD_BUDGET_BYTES) {
          turnSkipped.push({ path: p, bytes });
          continue;
        }
        used += bytes;
        dynamicDocs.push({ path: p, content });
        openedPaths.add(p);
        readSet.add(p);
        preloadedMdPaths.add(p);
        pendingMdPaths.delete(p);
        if (features.autoCite && !features.refsWhyCanonical) {
          const refs = Array.isArray(scratchpad.refs) ? (scratchpad.refs as string[]) : [];
          if (!refs.includes(p)) refs.push(p);
          scratchpad.refs = refs;
        }
      } catch {
        pendingMdPaths.delete(p);
      }
    }
    if (turnSkipped.length > 0) {
      mdBudgetSkipped.push(...turnSkipped);
      emit({
        type: "bootstrap",
        taskId,
        tool: "md_budget_exceeded",
        input: { cap: LAZY_MD_BUDGET_BYTES, used },
        output: turnSkipped.map((s) => `skipped ${s.path} (${s.bytes} bytes)`).join("\n"),
        outputBytes: 0,
        ok: false,
        errorMessage: `lazy md preload cap (${LAZY_MD_BUDGET_BYTES}B) reached; skipped ${turnSkipped.length} paths`,
        ts: Date.now(),
      });
    }
  };

  const initialPrompt = rebuildSystemPrompt();
  const log: ChatMessage[] = [
    { role: "system", content: initialPrompt },
    { role: "user", content: taskText },
  ];
  const promptBytes = Buffer.byteLength(initialPrompt, "utf8");
  emit({
    type: "bootstrap",
    taskId,
    tool: "system_prompt",
    input: { length: initialPrompt.length, bytes: promptBytes },
    output: initialPrompt,
    outputBytes: promptBytes,
    ok: true,
    ts: Date.now(),
  });
  emit({
    type: "bootstrap",
    taskId,
    tool: "initial_scratchpad",
    input: { keys: Object.keys(scratchpad) },
    output: JSON.stringify(scratchpad, null, 2),
    outputBytes: 0,
    ok: true,
    ts: Date.now(),
  });

  let stepCounter = 0;
  let budgetWarningSent = false;
  let nudgeSent = false;
  let stepBudget = MAX_PRIMARY_STEPS;
  let syntaxRefunds = 0;
  let recoveryRefunds = 0;
  let answered = false;

  try {
    while (stepCounter < stepBudget) {
      stepCounter++;
      const stepIdx = stepCounter;

      if (
        !budgetWarningSent &&
        stepIdx >= MAX_PRIMARY_STEPS - BUDGET_WARNING_AT_REMAINING + 1
      ) {
        const remaining = MAX_PRIMARY_STEPS - stepIdx + 1;
        log.push({
          role: "user",
          content: `<budget-warning>${remaining} steps remaining. Finalize answer and call await harness.answer(scratchpad, verify) now.</budget-warning>`,
        });
        budgetWarningSent = true;
      }

      log[0] = { role: "system", content: rebuildSystemPrompt() };

      const startedAt = Date.now();
      const res = await requestNextStep(llm, model, log);
      const elapsedMs = Date.now() - startedAt;

      if (!res.ok) {
        emit({
          type: "step",
          taskId,
          step: stepIdx,
          tool: "execute",
          planFirst: "next-step request failed",
          input: { code: "" },
          output: res.raw,
          outputBytes: Buffer.byteLength(res.raw, "utf8"),
          latencyMs: elapsedMs,
          ok: false,
          errorMessage: res.error,
          reasoning: res.llm?.reasoning,
          reasoningTokens: res.llm?.reasoningTokens,
          completionTokens: res.llm?.completionTokens,
          promptTokens: res.llm?.promptTokens,
          ts: Date.now(),
        });
        console.log(`${CLI.red}requestNextStep failed: ${res.error}${CLI.clr}`);

        if (res.raw) log.push({ role: "assistant", content: res.raw });
        log.push({
          role: "user",
          content: `Your previous response could not be parsed (${res.error}). Return raw JSON only — no markdown fences, no prose framing. Continue the task from where you were.`,
        });
        if (recoveryRefunds < MAX_RECOVERY_REFUNDS) {
          recoveryRefunds++;
          stepCounter--;
          console.log(
            `${CLI.yellow}RECOVERY (${recoveryRefunds}/${MAX_RECOVERY_REFUNDS}): refunding step ${stepIdx}${CLI.clr}`,
          );
        }
        continue;
      }

      const { step, raw, llm: stepLlm } = res;

      const codePreview =
        step.code.length > 200 ? step.code.slice(0, 200) + "…" : step.code;
      console.log(
        `Next step_${stepIdx}... ${step.plan_remaining_steps_brief[0]} (${elapsedMs} ms)\n${codePreview}`,
      );

      log.push({ role: "assistant", content: raw });

      const result = await executeScript(step.code, harness, scratchpad);

      const outputParts: string[] = [];
      if (result.output) outputParts.push(result.output);
      if (result.error) outputParts.push(`[runtime error] ${result.error}`);
      if (result.answered) outputParts.push("[answer submitted]");
      const txt = outputParts.length ? outputParts.join("\n") : "[no output]";

      const ok = !result.error;
      const errorMessage = result.error;
      if (result.error) {
        console.log(`${CLI.red}SCRIPT ERR: ${result.error}${CLI.clr}`);
      } else {
        console.log(`${CLI.green}OUT${CLI.clr}: ${result.output || "[no output]"}`);
      }

      const { text: outputText, bytes: outputBytes } = truncateForLog(txt);
      let scratchpadAfter: unknown;
      try {
        scratchpadAfter = JSON.parse(JSON.stringify(scratchpad));
      } catch {
        scratchpadAfter = "<<scratchpad not serializable>>";
      }
      emit({
        type: "step",
        taskId,
        step: stepIdx,
        tool: "execute",
        planFirst: step.plan_remaining_steps_brief[0] ?? "",
        input: { code: step.code },
        output: outputText,
        outputBytes,
        latencyMs: elapsedMs,
        ok,
        errorMessage,
        reasoning: stepLlm.reasoning,
        reasoningTokens: stepLlm.reasoningTokens,
        completionTokens: stepLlm.completionTokens,
        promptTokens: stepLlm.promptTokens,
        scratchpadAfter,
        ts: Date.now(),
      });

      if (result.answered) {
        answered = true;
        console.log(
          `${CLI.green}AGENT submitted answer (outcome=${String(scratchpad.outcome)})${CLI.clr}`,
        );
        for (const ref of Array.isArray(scratchpad.refs) ? (scratchpad.refs as unknown[]) : [])
          console.log(`- ${CLI.blue}${String(ref)}${CLI.clr}`);
        return;
      }

      if (
        result.error &&
        result.error.startsWith("SyntaxError:") &&
        syntaxRefunds < MAX_SYNTAX_REFUNDS
      ) {
        syntaxRefunds++;
        stepCounter--;
        console.log(
          `${CLI.yellow}SYNTAX REFUND (${syntaxRefunds}/${MAX_SYNTAX_REFUNDS}): not consuming step ${stepIdx}${CLI.clr}`,
        );
      }

      if (features.lazyMd) await drainPendingMd();

      log.push({ role: "user", content: txt });

      if (stepCounter >= stepBudget && !nudgeSent) {
        nudgeSent = true;
        stepBudget += NUDGE_EXTRA_STEPS;
        console.log(
          `${CLI.yellow}NUDGE: injecting submit reminder, +${NUDGE_EXTRA_STEPS} steps${CLI.clr}`,
        );
        log.push({ role: "user", content: NUDGE_SUBMIT });
      }
    }
  } finally {
    if (!answered) {
      const reason = `agent did not submit harness.answer (loop exhausted or unhandled exception)`;
      console.log(
        `${CLI.red}NO-ANSWER GATE: ${reason} — submitting OUTCOME_ERR_INTERNAL${CLI.clr}`,
      );
      emit({
        type: "step",
        taskId,
        step: stepCounter + 1,
        tool: "execute",
        planFirst: "no-answer gate auto-reject",
        input: { code: "/* no-answer gate */" },
        output: "",
        outputBytes: 0,
        latencyMs: 0,
        ok: false,
        errorMessage: reason,
        ts: Date.now(),
      });
      try {
        await vm.answer({ message: reason, outcome: Outcome.ERR_INTERNAL, refs: [] });
      } catch (err) {
        console.error("no-answer gate: vm.answer failed", err);
      }
    }
  }
}
