// One-shot analysis to choose competition submissions.
// Classifies every COMPLETE prod run (100 trials) by config era + health,
// then surfaces per-task structural quality signals for inferential accuracy.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "runs");

type Ev = any;
function load(path: string): Ev[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Ev[];
}

type Trial = {
  taskId: string;
  steps: number;
  outcome: string | null;
  answer: string | null;
  refs: string[];
  sqlCalls: number;
  sqlEmpty: number;
  noAnswer: boolean;
  errInternal: boolean;
};

type RunInfo = {
  id: string;
  bench: string;
  effort: string;
  navHints: string;
  concurrency: any;
  promptNoSql: boolean; // prompt explicitly says NO WORKING SQL (filesystem-first era)
  envFlags: Record<string, string>;
  trials: number;
  answered: number;
  noAnswer: number;
  errInternal: number;
  wallSec: number;
  medLat: number;
  byTask: Map<string, Trial>;
};

function analyze(path: string): RunInfo | null {
  const L = load(path);
  const rs = L.find((e) => e.type === "run:start");
  if (!rs) return null;
  const bench = (rs.benchmarkId ?? "?").replace("bitgn/", "");
  const starts = L.filter((e) => e.type === "trial:start");
  if (starts.length < 50) return null;

  // prompt era: find a bootstrap system_prompt
  const sysProm = L.find((e) => e.type === "bootstrap" && e.tool === "system_prompt");
  const promptText: string = sysProm?.content ?? sysProm?.text ?? sysProm?.output ?? "";
  const promptNoSql = /NO WORKING SQL/i.test(promptText);
  const navHints = String(rs.envFlags?.FEAT_NAV_HINTS ?? "absent");

  const steps = L.filter((e) => e.type === "step");
  const byTask = new Map<string, Trial>();
  // group steps by task
  const stepsByTask = new Map<string, Ev[]>();
  for (const s of steps) {
    if (!stepsByTask.has(s.taskId)) stepsByTask.set(s.taskId, []);
    stepsByTask.get(s.taskId)!.push(s);
  }
  for (const st of starts) {
    const ts = stepsByTask.get(st.taskId) ?? [];
    const last = ts.length ? ts[ts.length - 1] : null;
    const sp = last?.scratchpadAfter ?? {};
    let sqlCalls = 0, sqlEmpty = 0;
    for (const s of ts) {
      const code = String(s.code ?? "");
      const out = String(s.output ?? "");
      const n = (code.match(/\/bin\/sql|exec\(.*sql/gi) || []).length;
      sqlCalls += n;
      // crude: a step that called sql and whose output shows empty-ish result
      if (n > 0 && /\[\]|no rows|empty|0 rows|\(0\)/i.test(out)) sqlEmpty += 1;
    }
    const outcome = sp.outcome ?? null;
    const answer = typeof sp.answer === "string" ? sp.answer : null;
    const errInternal = outcome === "OUTCOME_ERR_INTERNAL";
    const noAnswer = !(outcome && outcome !== "OUTCOME_ERR_INTERNAL" && answer && answer.trim().length > 0);
    byTask.set(st.taskId, {
      taskId: st.taskId,
      steps: ts.length,
      outcome,
      answer,
      refs: Array.isArray(sp.refs) ? sp.refs : [],
      sqlCalls,
      sqlEmpty,
      noAnswer,
      errInternal,
    });
  }
  const answered = [...byTask.values()].filter((t) => !t.noAnswer).length;
  const noAnswer = [...byTask.values()].filter((t) => t.noAnswer && !t.errInternal).length;
  const errInternal = [...byTask.values()].filter((t) => t.errInternal).length;
  const tsv = L.map((e) => e.ts).filter((t) => typeof t === "number");
  const wallSec = tsv.length ? (Math.max(...tsv) - Math.min(...tsv)) / 1000 : 0;
  const lats = steps.map((s) => s.latencyMs).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const medLat = lats.length ? lats[Math.floor(lats.length / 2)] : 0;

  return {
    id: path.split("/").pop()!.replace(/\.jsonl$/, ""),
    bench, effort: String(rs.envFlags?.REASONING_EFFORT ?? "?"),
    navHints, concurrency: rs.concurrency ?? rs.envFlags?.CONCURRENCY ?? "?",
    promptNoSql, envFlags: rs.envFlags ?? {},
    trials: starts.length, answered, noAnswer, errInternal,
    wallSec, medLat, byTask,
  };
}

const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
const runs = files.map((f) => analyze(join(dir, f))).filter(Boolean) as RunInfo[];
const prod = runs.filter((r) => r.bench === "ecom1-prod" && r.trials >= 99);
prod.sort((a, b) => b.id.localeCompare(a.id));

console.log("\n=== COMPLETE prod runs (>=99 trials) ===");
console.log("id".padEnd(22) + "eff".padEnd(8) + "nav".padEnd(8) + "noSQLprompt".padEnd(13) + "conc".padEnd(6) + "ans".padEnd(5) + "noAns".padEnd(7) + "err".padEnd(5) + "wall".padEnd(7) + "medLat");
for (const r of prod) {
  console.log(
    r.id.padEnd(22) + r.effort.padEnd(8) + r.navHints.padEnd(8) +
    String(r.promptNoSql).padEnd(13) + String(r.concurrency).padEnd(6) +
    String(r.answered).padEnd(5) + String(r.noAnswer).padEnd(7) + String(r.errInternal).padEnd(5) +
    (r.wallSec.toFixed(0) + "s").padEnd(7) + r.medLat + "ms");
}

// aggregate SQL waste per run
console.log("\n=== SQL usage (dead-SQL waste signal) ===");
for (const r of prod) {
  let tot = 0, withSql = 0;
  for (const t of r.byTask.values()) { tot += t.sqlCalls; if (t.sqlCalls > 0) withSql++; }
  console.log(r.id.padEnd(22) + `sqlCalls=${tot}`.padEnd(16) + `tasksUsingSql=${withSql}/${r.byTask.size}`);
}

// no-answer task ids per run
console.log("\n=== no-answer / err task ids ===");
for (const r of prod) {
  const bad = [...r.byTask.values()].filter((t) => t.noAnswer).map((t) => `${t.taskId}${t.errInternal ? "(err)" : ""}`);
  console.log(r.id.padEnd(22) + (bad.length ? bad.join(",") : "(clean)"));
}

// avg steps per run (budget efficiency)
console.log("\n=== avg steps/task (lower = less waste) ===");
for (const r of prod) {
  const arr = [...r.byTask.values()].map((t) => t.steps);
  const avg = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  console.log(r.id.padEnd(22) + `avgSteps=${avg.toFixed(1)}`);
}

// dump fixed sample tasks across runs for inferential accuracy
const SAMPLE = ["t005","t010","t018","t023","t036","t043","t045","t049","t057","t063","t069","t079","t083","t089","t095","t098"];
console.log("\n=== SAMPLE outcomes (taskId -> per-run outcome|answerSnippet) ===");
for (const task of SAMPLE) {
  console.log(`\n--- ${task} ---`);
  for (const r of prod) {
    const t = r.byTask.get(task);
    if (!t) { console.log(`  ${r.id}: (no trial)`); continue; }
    const ans = (t.answer ?? "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  ${r.id} [${r.effort}/${r.promptNoSql ? "fs" : "sql"}] steps=${t.steps} ${t.outcome ?? "NONE"} refs=${t.refs.length} | ${ans}`);
  }
}
