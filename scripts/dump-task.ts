#!/usr/bin/env bun
/**
 * Dump the full execution trace of one or more tasks across the 9 most-recent
 * score-disabled runs of the t001–t100 competition set. For each task: the
 * instruction, every step's executed code + output + reasoning, and the final
 * scratchpad (answer / refs / facts / outcome). No grader scores exist for this
 * set (competition locked), so this is the raw material for INFERENTIAL
 * correctness judgement — read what the agent actually gathered and decide.
 *
 * Usage: bun run scripts/dump-task.ts t001 [t002 ...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 9 latest score-disabled runs over the new 100-task set (7 full + 2 partial).
const RUNS = [
  "20260530-114149-8fee0d",
  "20260530-114102-5ce0a8",
  "20260530-114102-97e375",
  "20260530-114102-65eb5b",
  "20260530-114102-161561",
  "20260530-112557-d6c1e7",
  "20260530-110611-0c35b3",
  "20260530-113908-0aded5",
  "20260530-113756-1e8a80",
];
const dir = join(import.meta.dir, "..", "runs");

type Ev = any;
const cache = new Map<string, Ev[]>();
function load(run: string): Ev[] {
  if (cache.has(run)) return cache.get(run)!;
  const evs = readFileSync(join(dir, run + ".jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Ev[];
  cache.set(run, evs);
  return evs;
}

function codeOf(input: unknown): string {
  if (typeof input === "string") {
    try { const o = JSON.parse(input); return o.code ?? input; } catch { return input; }
  }
  if (input && typeof input === "object") return (input as any).code ?? JSON.stringify(input);
  return String(input ?? "");
}

const CODE_TRIM = 1000;
const OUT_TRIM = 550;
const REAS_TRIM = 350;
const tasks = process.argv.slice(2);

for (const task of tasks) {
  console.log(`\n################################ ${task} ################################`);
  let printedInstruction = false;
  for (const run of RUNS) {
    const L = load(run);
    const ev = L.filter((e) => e.taskId === task);
    if (!ev.length) continue;
    const inst = ev.find((e) => e.type === "trial:start")?.instruction;
    if (inst && !printedInstruction) {
      console.log(`\nINSTRUCTION: ${inst}`);
      printedInstruction = true;
    }
    const steps = ev.filter((e) => e.type === "step");
    const last = steps[steps.length - 1];
    console.log(`\n===== RUN ${run.slice(-6)} | steps=${steps.length} =====`);
    for (const s of steps) {
      const code = codeOf(s.input).replace(/\n/g, "\n    ").slice(0, CODE_TRIM);
      console.log(`\n  [step ${s.step} ok=${s.ok}]`);
      if (s.reasoning) console.log("  THINK: " + String(s.reasoning).replace(/\n/g, " ").slice(0, REAS_TRIM));
      console.log("  CODE: " + code);
      console.log("  OUT:  " + String(s.output ?? "").replace(/\n/g, "\n    ").slice(0, OUT_TRIM));
    }
    const sp = last?.scratchpadAfter ?? {};
    console.log(`\n  FINAL outcome=${sp.outcome}`);
    console.log(`  FINAL refs=${JSON.stringify(sp.refs)}`);
    if (sp.facts) console.log(`  FINAL facts=${JSON.stringify(sp.facts).slice(0, 700)}`);
    console.log(`  FINAL answer=${String(sp.answer ?? "").slice(0, 600)}`);
  }
}
