import { jsonish } from "./format";
import type { Scratchpad, ScriptHarness, ScriptOutcome } from "./types";

const SCRIPT_PRELUDE = `"use strict";
const harness = __h;
const scratchpad = __sp;
const console = __console;
`;

// Execute one model-emitted script in a Bun AsyncFunction sandbox with the
// three injected locals (harness, scratchpad, console). Returns the captured
// console output, any thrown error, and whether harness.answer was called.
export async function executeScript(
  code: string,
  harness: ScriptHarness,
  scratchpad: Scratchpad,
): Promise<ScriptOutcome> {
  const outLines: string[] = [];
  const captureConsole = {
    log: (...args: unknown[]) => outLines.push(args.map(jsonish).join(" ")),
    error: (...args: unknown[]) =>
      outLines.push("[error] " + args.map(jsonish).join(" ")),
    warn: (...args: unknown[]) =>
      outLines.push("[warn] " + args.map(jsonish).join(" ")),
  };

  let answered = false;
  const wrappedHarness: ScriptHarness = {
    ...harness,
    answer: async (sp, verify) => {
      await harness.answer(sp, verify);
      answered = true;
    },
  };

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (...args: string[]) => (
      ...inner: unknown[]
    ) => Promise<void>;
    const fn = new AsyncFunction("__h", "__sp", "__console", SCRIPT_PRELUDE + code);
    await fn(wrappedHarness, scratchpad, captureConsole);
    return { output: outLines.join("\n"), answered };
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { output: outLines.join("\n"), error: errMsg, answered };
  }
}
