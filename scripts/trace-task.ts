#!/usr/bin/env bun
/**
 * Dump the full execution trace of a task across the 5 complete runs:
 * instruction, every step's executed code + output + ok, final scratchpad
 * (refs/answer/outcome), and the grader's scoreDetail. Reads step.input.code
 * (the actually-executed JS), NOT just outputs — so mechanism analysis is
 * grounded in what the agent did, not what its final state implies.
 *
 * Usage: bun run scripts/trace-task.ts t21 [t36 ...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNS = [
  "20260530-004955-0a137f",
  "20260530-005743-d4a346",
  "20260530-010341-0d735a",
  "20260530-010958-97ccc5",
  "20260530-011355-9ab47f",
];
const dir = join(import.meta.dir, "..", "runs");

type Ev = any;
function load(run: string): Ev[] {
  return readFileSync(join(dir, run + ".jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Ev[];
}

function codeOf(input: unknown): string {
  if (typeof input === "string") {
    try { const o = JSON.parse(input); return o.code ?? input; } catch { return input; }
  }
  if (input && typeof input === "object") return (input as any).code ?? JSON.stringify(input);
  return String(input ?? "");
}

const tasks = process.argv.slice(2);
const TRIM = 700;
for (const task of tasks) {
  console.log(`\n################################ ${task} ################################`);
  for (const run of RUNS) {
    const L = load(run);
    const ev = L.filter((e) => e.taskId === task);
    if (!ev.length) continue;
    const inst = ev.find((e) => e.type === "trial:start")?.instruction;
    const score = ev.find((e) => e.type === "trial:score");
    const steps = ev.filter((e) => e.type === "step");
    const last = steps[steps.length - 1];
    console.log(`\n===== RUN ${run.slice(-6)} | score=${score?.score} | detail=${JSON.stringify(score?.scoreDetail ?? [])} =====`);
    if (inst) console.log(`INSTRUCTION: ${inst}`);
    for (const s of steps) {
      console.log(`\n  [step ${s.step} tool=${s.tool} ok=${s.ok}]`);
      const code = codeOf(s.input);
      console.log("  CODE: " + code.replace(/\n/g, "\n  ").slice(0, TRIM));
      console.log("  OUT:  " + String(s.output ?? "").replace(/\n/g, "\n  ").slice(0, 400));
    }
    console.log(`\n  FINAL outcome=${last?.scratchpadAfter?.outcome}`);
    console.log(`  FINAL refs=${JSON.stringify(last?.scratchpadAfter?.refs)}`);
    console.log(`  FINAL answer=${String(last?.scratchpadAfter?.answer ?? "").slice(0, 350)}`);
  }
}
