import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(import.meta.dir, "..", "runs");

type Row = {
  id: string; model: string; bench: string; trials: number; steps: number;
  answered: number; noAns: number; scored: number; meanScore: number | null;
  wallSec: number; avgLatMs: number; medLatMs: number; tokens: number;
};

function summarize(path: string): Row | null {
  const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
  const L = readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  const rs = L.find((e) => e.type === "run:start");
  const starts = L.filter((e) => e.type === "trial:start");
  if (!starts.length) return null;
  const steps = L.filter((e) => e.type === "step");
  // per-task last outcome / answer
  const lastByTask = new Map<string, any>();
  for (const s of steps) lastByTask.set(s.taskId, s.scratchpadAfter ?? {});
  let answered = 0, noAns = 0;
  for (const st of starts) {
    const sp = lastByTask.get(st.taskId);
    const ok = sp && sp.outcome && sp.outcome !== "OUTCOME_ERR_INTERNAL" &&
      typeof sp.answer === "string" && sp.answer.trim().length > 0;
    if (ok) answered++; else noAns++;
  }
  const scoreEvents = L.filter((e) => e.type === "trial:score" && typeof e.score === "number");
  const meanScore = scoreEvents.length
    ? scoreEvents.reduce((a, b) => a + b.score, 0) / scoreEvents.length : null;
  const ts = L.map((e) => e.ts).filter((t) => typeof t === "number");
  const wallSec = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 1000 : 0;
  const lats = steps.map((s) => s.latencyMs).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const avgLatMs = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
  const medLatMs = lats.length ? (lats[Math.floor(lats.length / 2)] ?? 0) : 0;
  const tokens = steps.reduce((a, s) => a + (s.completionTokens || 0) + (s.promptTokens || 0), 0);
  return {
    id, model: rs?.modelId ?? "?", bench: (rs?.benchmarkId ?? "?").replace("bitgn/", ""),
    trials: starts.length, steps: steps.length, answered, noAns,
    scored: scoreEvents.length, meanScore, wallSec, avgLatMs, medLatMs, tokens,
  };
}

const rows = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .map((f) => join(dir, f))
  .map((p) => ({ p, m: Bun.file(p).lastModified }))
  .sort((a, b) => b.m - a.m)
  .map((x) => summarize(x.p)).filter(Boolean) as Row[];

// Only runs with a real attempt (>=20 trials) to cut noise.
const real = rows.filter((r) => r.trials >= 20);
const fmt = (n: number, d = 0) => n.toFixed(d);
console.log(`\n${real.length} runs with >=20 trials (newest first):\n`);
const H = "runId".padEnd(22) + "model".padEnd(26) + "bench".padEnd(11) +
  "trl ans  no  scr mean   wall  med-lat  ans%";
console.log(H); console.log("-".repeat(H.length));
for (const r of real) {
  const ansPct = r.trials ? (r.answered / r.trials) * 100 : 0;
  console.log(
    r.id.padEnd(22) + r.model.slice(0, 25).padEnd(26) + r.bench.padEnd(11) +
    `${fmt(r.trials).padStart(3)} ${fmt(r.answered).padStart(3)} ${fmt(r.noAns).padStart(3)} ` +
    `${fmt(r.scored).padStart(3)} ${(r.meanScore == null ? "-" : fmt(r.meanScore, 2)).padStart(4)} ` +
    `${fmt(r.wallSec).padStart(5)}s ${fmt(r.medLatMs).padStart(6)}ms ${fmt(ansPct).padStart(3)}%`,
  );
}
// model roster
const byModel = new Map<string, number>();
for (const r of real) byModel.set(r.model, (byModel.get(r.model) || 0) + 1);
console.log(`\nModels seen: ${[...byModel.entries()].map(([m, n]) => `${m} (${n})`).join(", ")}`);
