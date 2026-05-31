import { readFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(import.meta.dir, "..", "runs");
const RUNS = ["20260530-114149-8fee0d","20260530-114102-5ce0a8","20260530-112557-d6c1e7","20260530-110611-0c35b3"];

function codeOf(input: unknown): string {
  if (typeof input === "string") { try { return (JSON.parse(input) as any).code ?? input; } catch { return input; } }
  if (input && typeof input === "object") return (input as any).code ?? "";
  return "";
}

let sqlCalls = 0, sqlWithRows = 0;
const sqlSamples: string[] = [];
const readPrefix: Record<string, number> = {};
const successfulReads: Record<string, number> = {};

for (const r of RUNS) {
  const L = readFileSync(join(dir, r + ".jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  for (const e of L) {
    if (e.type !== "step") continue;
    const code = codeOf(e.input);
    const out = String(e.output ?? "");
    if (/\/bin\/sql/.test(code)) {
      sqlCalls++;
      // a real result row tends to carry a pipe/tab delimiter and substantive length
      const body = out.replace(/SQL results?\d*:/gi, "").replace(/\s/g, "");
      if (body.length > 30 && /[|\t]|record_path|product_sku|customer_id/.test(out)) {
        sqlWithRows++;
        if (sqlSamples.length < 4) sqlSamples.push(out.slice(0, 240).replace(/\n/g, " | "));
      }
    }
    for (const m of code.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)) {
      const p = m[1];
      if (p && (p.startsWith("/proc") || p.startsWith("/ops") || p.startsWith("/archive"))) {
        const pref = p.split("/").slice(0, 4).join("/");
        readPrefix[pref] = (readPrefix[pref] || 0) + 1;
      }
    }
    // successful reads: step ok and code calls harness.read — capture exact paths that returned content
    if (e.ok && /harness\.read/.test(code) && !/not.?found|No such|ENOENT|error/i.test(out)) {
      for (const m of code.matchAll(/read\(\s*\{?\s*path:\s*["'`]([^"'`]+)/g)) {
        const p = m[1];
        if (p && (p.startsWith("/proc") || p.startsWith("/ops"))) successfulReads[p] = (successfulReads[p] || 0) + 1;
      }
    }
  }
}

console.log("SQL calls:", sqlCalls, "| heuristic with-rows:", sqlWithRows);
console.log("SQL non-empty samples:");
for (const s of sqlSamples) console.log("  •", s);
console.log("\nRead path prefixes (top 4 segments), by frequency:");
for (const [k, v] of Object.entries(readPrefix).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${v}\t${k}`);
console.log("\nSample exact successful /proc read paths:");
for (const [k, v] of Object.entries(successfulReads).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${v}\t${k}`);
