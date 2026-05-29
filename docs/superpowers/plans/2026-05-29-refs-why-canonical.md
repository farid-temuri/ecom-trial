# refs_why Canonical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scratchpad.refs_why` the single source of truth for citations. Eliminate over-cite failures (t13 class) by making every citation a deliberate, justified act — and let the LLM judge enforce the BitGN "don't cite unavailable products" rule using the model's own stated reasons.

**Architecture:** Add `FEAT_REFS_WHY_CANONICAL` flag. When on: (1) auto-cite paths are NOT pushed into `refs`; (2) `scratchpad.refs` becomes a derived readonly mirror of `Object.keys(scratchpad.refs_why)`; (3) the model cites via a new `scratchpad.cite(path, reason)` helper, which is atomic — no path without a reason; (4) the LLM judge sees `refs_why` verbatim and applies an "every cited product/store must appear in the answer" check.

**Tech Stack:** Bun, TypeScript, OpenRouter (judge LLM). No test suite — validation is `bun run typecheck` + single-task runs against BitGN harness (`bun run main.ts t13`).

**Validation note:** This codebase has no test framework. Each task validates with `bun run typecheck` and inspection of the run log. The final task is a live single-task run against t13 to confirm the failure mode is fixed.

---

## File Structure

- **Modify** `agent.ts` — add flag, `cite()` injection into sandbox, gate autoCite, rewrite refs validation, judge prompt rewrite, hint section under flag, submission shape
- **Modify** `.env.example` — document and set new flag default
- **Modify** `.env` — flip new flag on for live runs
- **Modify** `CLAUDE.md` — short note on the new flag + how citation works under it
- **No new files.** Plan stays contained inside the existing module so existing run/log/UI tooling keeps working.

---

## Task 1: Add `FEAT_REFS_WHY_CANONICAL` flag

**Files:**
- Modify: `agent.ts:835-842` (flag block)
- Modify: `.env.example:32-42` (flag docs + default)
- Modify: `.env` (flip to true)

- [ ] **Step 1: Add the flag declaration**

In `agent.ts`, the existing flag block sits around line 835. Add a new line in the same group:

```ts
const FEAT_REFS_WHY_CANONICAL = flagOn("FEAT_REFS_WHY_CANONICAL"); // refs_why is source of truth; refs derived; autoCite disabled
```

Then extend the `[features]` log line (around 842) to include `REFS_WHY_CANONICAL=${FEAT_REFS_WHY_CANONICAL}` so `run:start.envFlags` records it.

- [ ] **Step 2: Document in `.env.example`**

Add a section above existing flags:

```bash
# FEAT_REFS_WHY_CANONICAL: scratchpad.refs_why becomes the single citation channel.
#   - scratchpad.cite(path, reason) is the only documented way to add a ref.
#   - scratchpad.refs is a readonly mirror of Object.keys(scratchpad.refs_why).
#   - Auto-cite is disabled (overrides FEAT_AUTO_CITE).
#   - Judge prompt receives refs_why verbatim and rejects cited products that
#     don't appear in scratchpad.answer (BitGN "don't cite unavailable" rule).
FEAT_REFS_WHY_CANONICAL=false
```

- [ ] **Step 3: Enable in live `.env`**

```bash
FEAT_REFS_WHY_CANONICAL=true
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add agent.ts .env.example .env
git commit -m "feat: add FEAT_REFS_WHY_CANONICAL flag"
```

---

## Task 2: Gate autoCite on the new flag

**Files:**
- Modify: `agent.ts:862-865` (autoCite function — no change to signature)
- Modify: `agent.ts:904, 1071, 1083, 1092, 1442, 1476, 1606` (all autoCite call sites)

- [ ] **Step 1: Centralize the gate inside `autoCite`**

Change `autoCite` from line 862:

```ts
function autoCite(sp: Scratchpad, path: string): void {
  if (FEAT_REFS_WHY_CANONICAL) return; // refs_why owns citations; never auto-push
  const refs = ensureRefsArray(sp);
  if (!refs.includes(path)) refs.push(path);
}
```

This makes the gate impossible to forget at a call site. All existing `if (FEAT_AUTO_CITE) autoCite(...)` calls keep their outer gate (FEAT_AUTO_CITE may still be off in legacy configs), and the canonical flag overrides them from inside.

- [ ] **Step 2: Update the soft-block citeNote at line 906**

```ts
const citeNote = FEAT_REFS_WHY_CANONICAL
  ? "The path is now in your read set. Cite it via scratchpad.cite(path, reason) ONLY if its content backs your final answer."
  : FEAT_AUTO_CITE
    ? "The path is now in your read set and auto-cited in scratchpad.refs."
    : "The path is now in your read set (cite it manually in scratchpad.refs if the answer relies on it).";
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add agent.ts
git commit -m "feat: short-circuit autoCite under refs_why canonical"
```

---

## Task 3: Inject `scratchpad.cite()` helper into the sandbox

**Files:**
- Modify: `agent.ts` (search for where `scratchpad` is prepared before each step / where AsyncFunction is built)

- [ ] **Step 1: Locate scratchpad prep**

Run:
```bash
grep -n "new AsyncFunction\|scratchpad: Scratchpad\|initialScratchpad" agent.ts | head -20
```

Identify the function that initializes `scratchpad` for the trial (around the bootstrap/initial scratchpad emit). The helper needs to be a non-enumerable method on the scratchpad object so it survives JSON serialization for logging (without polluting `scratchpadAfter` snapshots).

- [ ] **Step 2: Add helper installation**

In the trial init function, after the initial scratchpad object is created and before any step runs, add:

```ts
function installCiteHelper(sp: Scratchpad, readSet: Set<string>, preloadedPaths: Set<string>): void {
  if (!FEAT_REFS_WHY_CANONICAL) return;
  Object.defineProperty(sp, "cite", {
    value: (path: unknown, reason: unknown): void => {
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error(
          `scratchpad.cite: path must be an absolute workspace path string. Got: ${JSON.stringify(path)}`,
        );
      }
      if (typeof reason !== "string" || reason.trim().length < 8) {
        throw new Error(
          `scratchpad.cite(${path}): reason must be a string of >= 8 non-whitespace chars explaining why this file backs the answer. ` +
          `If you cannot articulate a load-bearing reason, do NOT cite this path.`,
        );
      }
      if (!readSet.has(path) && !preloadedPaths.has(path)) {
        throw new Error(
          `scratchpad.cite(${path}): path was not read this trial and is not preloaded. ` +
          `Read it via harness.read first, or remove the citation.`,
        );
      }
      const why = (sp.refs_why ??= {}) as Record<string, string>;
      why[path] = reason.trim();
    },
    enumerable: false, // keep out of scratchpadAfter snapshots
    writable: false,
    configurable: false,
  });
}
```

Call `installCiteHelper(scratchpad, readSet, preloadedMdPaths)` at the same place the initial scratchpad is emitted. The exact insertion line depends on Step 1 — Task 3 producer should locate and patch this in the same commit.

- [ ] **Step 3: Update the sandbox locals list mention in the system prompt**

In the prompt section that lists injected locals (around line 89), add a line:

```
- `scratchpad.cite(path, reason)` — atomic citation. Adds (path → reason) to scratchpad.refs_why. Throws if reason < 8 chars or path was not read this trial. Use this; do not write to scratchpad.refs directly.
```

Gate this hint addition with the flag — see Task 6 for the broader hint rewrite.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add agent.ts
git commit -m "feat: inject atomic scratchpad.cite() helper under refs_why canonical"
```

---

## Task 4: Derive `refs` from `refs_why` at submit, drop `refs` as a write target

**Files:**
- Modify: `agent.ts:1170-1227` (refs validation block inside `answer` flow)
- Modify: `agent.ts:1162-1166` (STRUCTURED_FACTS auto-merge — needs to write to `refs_why`, not `refs`)
- Modify: `agent.ts:435-447` (judge payload — keep as-is; refs_why will be derived from sp directly)

- [ ] **Step 1: Locate and read the answer-flow block**

```bash
grep -n "harness.answer rejected\|refsList\|refs_why\|STRUCTURED_FACTS" agent.ts | head -40
```

- [ ] **Step 2: Derive refs from refs_why under the flag**

At the top of the answer-validation block (around line 1170), add:

```ts
if (FEAT_REFS_WHY_CANONICAL) {
  const why = (scratchpad.refs_why && typeof scratchpad.refs_why === "object")
    ? (scratchpad.refs_why as Record<string, unknown>)
    : {};
  const derived: string[] = [];
  for (const [path, reason] of Object.entries(why)) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(
        `harness.answer rejected — scratchpad.refs_why has a non-path key: ${JSON.stringify(path)}. Keys must be absolute workspace paths.`,
      );
    }
    if (typeof reason !== "string" || reason.trim().length < 8) {
      throw new Error(
        `harness.answer rejected — scratchpad.refs_why[${path}] reason is missing or < 8 chars. ` +
        `Either provide a real load-bearing justification or remove the cite.`,
      );
    }
    derived.push(path);
  }
  // Overwrite scratchpad.refs with the derived list. Model writes to refs_why; refs is a mirror.
  scratchpad.refs = derived;
}
```

This block runs BEFORE the existing refs-shape and refs_why coverage checks, so those checks operate on the derived list and remain correct.

- [ ] **Step 3: Redirect STRUCTURED_FACTS auto-merge into refs_why**

The existing block at 1162-1166 merges fact `source` fields into `refs`. Under the canonical flag, redirect into `refs_why` with a generated reason:

```ts
if (FEAT_STRUCTURED_FACTS) {
  // existing facts shape validation stays the same ...
  for (const [factName, slot] of /* existing iteration */) {
    if (slot && slot.value !== null && typeof slot.source === "string" && slot.source.startsWith("/")) {
      if (FEAT_REFS_WHY_CANONICAL) {
        const why = (scratchpad.refs_why ??= {}) as Record<string, string>;
        if (!why[slot.source]) {
          why[slot.source] = `source for fact "${factName}"`;
        }
      } else {
        // legacy auto-merge into refs (existing behavior)
      }
    }
  }
}
```

Keep both branches so the flag can flip off safely.

- [ ] **Step 4: Soften CITING_REASONING under the canonical flag**

The existing CITING_REASONING check (1188-1223) becomes redundant when canonical is on — the derive step already enforces reason length. Add an early-return:

```ts
if (FEAT_CITING_REASONING && !FEAT_REFS_WHY_CANONICAL) {
  // existing CITING_REASONING block
}
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add agent.ts
git commit -m "feat: derive refs from refs_why at submit under canonical flag"
```

---

## Task 5: Judge sees `refs_why` and applies the unavailable-product rule

**Files:**
- Modify: `agent.ts:405-424` (JUDGE_SYSTEM_PROMPT)
- Modify: `agent.ts:428-505` (runJudge — include refs_why in payload)

- [ ] **Step 1: Extend judge payload with refs_why**

In `runJudge` (around 435), replace the `proposed_scratchpad` construction:

```ts
const refsWhyRaw = (scratchpad.refs_why && typeof scratchpad.refs_why === "object")
  ? scratchpad.refs_why as Record<string, unknown>
  : {};
const refsWhy: Record<string, string> = {};
for (const [k, v] of Object.entries(refsWhyRaw)) {
  if (typeof v === "string") refsWhy[k] = v;
}

const payload = {
  task: taskInstruction,
  proposed_scratchpad: {
    answer: scratchpad.answer ?? null,
    outcome: scratchpad.outcome ?? null,
    refs: refsList,
    refs_why: refsWhy,
    string_keys: stringKeys,
  },
};
```

- [ ] **Step 2: Add the rule check to JUDGE_SYSTEM_PROMPT**

Insert a new rule (number 5) before the final fail/pass instruction:

```
5. **Load-bearing citations** — every entry in `refs_why` must back the answer.
   - Identifier rule: if the cited file's path encodes a product SKU or store ID (e.g. `/proc/catalog/FST-3SJKL8BF.json`, `/proc/stores/store_x.json`), that identifier MUST appear in `scratchpad.answer` OR the reason in `refs_why` must explicitly explain why a non-mentioned file is required (e.g. "store JSON read to enumerate SKUs in scope" is acceptable; "candidate considered" is NOT).
   - Reason rule: reject if any `refs_why` reason contains disqualifying language indicating the file did NOT back the answer — phrases like "0 available", "below threshold", "candidate", "considered but rejected", "out of stock", "not applicable".
   - BitGN policy: "answer should reference products that are available, but should not reference unavailable products". If a SKU is cited but its `refs_why` reason indicates unavailability, REJECT.
```

Renumber the existing fail/pass output rule accordingly.

- [ ] **Step 3: Gate the rule injection on the flag**

The JUDGE_SYSTEM_PROMPT is a top-level `const`. To keep the legacy prompt intact when the flag is off, build the prompt as a function:

```ts
function buildJudgeSystemPrompt(): string {
  const baseRules = `... rules 1-4 ...`;
  const canonicalRule = FEAT_REFS_WHY_CANONICAL
    ? `\n5. **Load-bearing citations** — ... (full text from Step 2)`
    : "";
  return `You are a strict pre-submission auditor ...\n\n${baseRules}${canonicalRule}\n\nIf all rules pass: return ...`;
}
```

Then in `runJudge`, replace the const reference with `buildJudgeSystemPrompt()`.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add agent.ts
git commit -m "feat: judge sees refs_why and enforces load-bearing citation rule"
```

---

## Task 6: Rewrite the model-facing hint under the canonical flag

**Files:**
- Modify: `agent.ts:89-160` (sandbox-locals + refs explanation in system prompt)
- Modify: `agent.ts:226-285` (worked example block)

- [ ] **Step 1: Build a canonical-mode hint block**

The system prompt is currently a large template literal. The cleanest patch is to inject a canonical-mode block as a string and substitute it in. Find the block describing `scratchpad.refs` (lines 100-160) and produce a parallel block guarded by the flag.

Add a helper near the prompt construction:

```ts
function refsSectionForPrompt(): string {
  if (!FEAT_REFS_WHY_CANONICAL) {
    return /* existing prose, unchanged */;
  }
  return `
- accumulate citations via \`scratchpad.cite(path, reason)\` — the ONLY documented way to cite.
  - \`path\` must be a workspace path you actually read via harness.read/list/stat/write/delete, or a preloaded \`<workspace-docs>\` path.
  - \`reason\` is a one-line string (>= 8 chars) explaining why THIS file's content backs your final answer.
  - Counterfactual test before every \`cite\`: "If this file had different contents, would my answer change?" If no, do NOT cite.
  - \`scratchpad.refs\` is a readonly mirror of \`Object.keys(scratchpad.refs_why)\` — do not write to it directly.

\`scratchpad.answer\` stays clean: literal demanded format only ("Total: 2", "<YES> FST-XXXX", "5 products"). Justifications live in \`refs_why\`, NOT in \`answer\`.

**BitGN citation rules (the grader enforces these):**
- When answering availability questions, cite ONLY products that ARE available. NEVER cite a SKU whose inventory is 0 or below threshold, even if you read its catalog file while filtering candidates.
- When applying a policy from \`/docs\`, cite the policy file with a reason like "applied policy: <one-line summary>".
- When the answer comes from a SQL query against a single store, the store JSON is the load-bearing source; the per-SKU catalog files used only to build the candidate set are NOT load-bearing.
`;
}
```

Wire this into the prompt template where the current refs section lives.

- [ ] **Step 2: Replace the worked example under the flag**

Add a parallel canonical-mode example:

```ts
function refsExampleForPrompt(): string {
  if (!FEAT_REFS_WHY_CANONICAL) return /* existing example */;
  return `
// Worked example — availability count via SQL
const STORE = "/proc/stores/store_bratislava_stare_mesto.json";
const candidates = ["FST-1HE3ZSQ6", "FST-2JPIIG2S", "FST-3SJKL8BF"];

const rows = await harness.exec({
  path: "/bin/sql",
  args: ["SELECT product_sku, available_today_quantity FROM store_inventory WHERE store_id='store_bratislava_stare_mesto' AND product_sku IN ('FST-1HE3ZSQ6','FST-2JPIIG2S','FST-3SJKL8BF')"],
});
// parse rows, pick SKUs whose quantity >= threshold ...
const available = ["FST-1HE3ZSQ6", "FST-2JPIIG2S"]; // qty >= threshold
const total = available.length;

scratchpad.answer = \`Total: \${total}\`;
scratchpad.outcome = "OUTCOME_OK";

// Cite ONLY the store JSON (the inventory source for THIS answer) and the
// catalog files for the AVAILABLE SKUs (the ones in the answer). Do NOT
// cite candidates that were filtered out — they did not back the answer.
scratchpad.cite(STORE, "store inventory enumerated for SKU availability");
scratchpad.cite("/proc/catalog/FST-1HE3ZSQ6.json", "available Heco fastener counted in answer");
scratchpad.cite("/proc/catalog/FST-2JPIIG2S.json", "available Heco fastener counted in answer");
// FST-3SJKL8BF intentionally NOT cited — 0 available, not in answer.

const verify = (sp) => {
  if (!/^Total: \\d+$/.test(sp.answer)) return { ok: false, reason: "answer must be 'Total: <n>'" };
  if (!sp.refs.includes(STORE)) return { ok: false, reason: "store must be cited" };
  return { ok: true };
};

await harness.answer(scratchpad, verify);
`;
}
```

- [ ] **Step 3: Update sandbox locals list and submit instructions**

In the prompt section listing what's injected (around line 89), append (only when flag on):

```
- \`scratchpad.cite(path, reason)\` — atomic citation; throws if reason < 8 chars or path not read.
```

Replace the "To submit the final answer" sentence (line 105) under the flag with:

```
To submit: set \`scratchpad.answer\` (literal format only), \`scratchpad.outcome\`, call \`scratchpad.cite(path, reason)\` for each file that backs the answer, define a \`verify(sp)\` function that encodes the task's literal demands, then call \`await harness.answer(scratchpad, verify)\`.
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add agent.ts
git commit -m "feat: refs_why canonical hint and worked example"
```

---

## Task 7: Live validation on t13

**Files:**
- Read: `runs/<new-run-id>.jsonl` (output)
- Modify: `CLAUDE.md` (note the new flag in the env table + agent-loop section)

- [ ] **Step 1: Confirm flag state**

```bash
grep FEAT_REFS_WHY_CANONICAL .env
```
Expected: `FEAT_REFS_WHY_CANONICAL=true`

- [ ] **Step 2: Single-task run**

```bash
bun run main.ts t13
```

Watch the console for the new flag in `[features]` line. Note the runId.

- [ ] **Step 3: Inspect the run log**

```bash
ls -t runs/*.jsonl | head -1
# then for that file:
jq -c 'select(.type=="step") | {n: .stepNumber, cite: (.scratchpadAfter.refs_why // {}), refs: (.scratchpadAfter.refs // [])}' runs/<runId>.jsonl
jq -c 'select(.type=="trial:score")' runs/<runId>.jsonl
```

Expected:
- `refs_why` is populated only with paths the model deliberately cited
- `refs` mirrors `Object.keys(refs_why)` exactly
- No 0-stock or wrong-category SKU appears in either
- Score > 0 on t13

- [ ] **Step 4: If score still 0, capture the grader reason**

```bash
jq -c 'select(.type=="trial:score") | .scoreDetail' runs/<runId>.jsonl
```
Bring the output back for analysis before iterating further.

- [ ] **Step 5: Document the flag in CLAUDE.md**

Under the "Required environment" section or the "Agent loop" section, add one line:

```
- `FEAT_REFS_WHY_CANONICAL=true` — citations flow through `scratchpad.cite(path, reason)` only; `scratchpad.refs` is a derived readonly mirror; judge enforces "cited products must appear in answer."
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note FEAT_REFS_WHY_CANONICAL behavior"
```

---

## Open questions / decisions made

- **Worked example uses the t13 task shape on purpose** — concrete is better than abstract. The model sees the exact failure pattern fixed in the example.
- **`STO-2R84BSHQ` (Festool Tool Box) in last run was a search-quality failure, not a citation failure.** This plan does not address it. If t13 still loses points after this fix, that bug should be filed separately.
- **Backward compatibility:** with flag off, behavior is byte-identical to today. Auto-cite, refs_why optional, judge prompt unchanged. Safe to merge and roll out gradually.
- **`scratchpad.refs` post-derive is mutable** — JS object semantics. We rely on the model not mutating it (the hint says "readonly mirror"). A frozen-array enforcement is an optional follow-up; not worth the complexity now.
