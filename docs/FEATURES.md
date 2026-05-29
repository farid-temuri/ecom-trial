# Feature flags

Experimental harness changes are env-flag-gated. All default **OFF** so the agent runs identical to the pre-change baseline. Flip them on one at a time in `.env` (or as env vars) to bisect impact on the BitGN score.

**All flags are parsed in one place — [src/config.ts](../src/config.ts) (`loadConfig`/`loadFeatures`)** — and threaded through `runAgent` as a typed `Features` object. That file is the canonical list. Gate logic that consumes them lives in [src/gates.ts](../src/gates.ts).

Values accepted as "on": `true`, `1`, `on`, `yes` (case-insensitive). Anything else = off.

**Canonical names vs aliases.** The canonical env-var name for every flag is `FEAT_*`. For two flags the older un-prefixed names are still accepted as back-compat aliases (canonical wins if both are set):

| Canonical | Back-compat alias |
|---|---|
| `FEAT_CITING_REASONING` | `CITING_REASONING` |
| `FEAT_STRUCTURED_FACTS` | `STRUCTURED_FACTS` |

There is **no** longer a `[features] …` line printed to stderr at startup (it was a module-level side effect removed in the `src/` refactor). To see what was active for a run, read `run:start.envFlags` in `runs/<runId>.jsonl` — it records every flag value at startup.

---

## Flag reference

These are the flags that **exist in the current codebase** (`src/config.ts`):

| Flag | Change | Default | Touches |
|---|---|---|---|
| `FEAT_LAZY_MD` | `.md` index + lazy preload | off | bootstrap, `tree/list/find/search/stat`, per-turn drain |
| `FEAT_AUTO_CITE` | Auto-push read paths into `scratchpad.refs` | off | `read`, `write`, `delete`, bootstrap, lazy preload |
| `FEAT_STRICT_REFS` | Tighten refs gate from `openedPaths` to `readSet` | off | `answer` refs check, `harness.opened()` |
| `FEAT_CITING_REASONING` (alias `CITING_REASONING`) | Require `scratchpad.refs_why[path] = "≥8-char reason"` for every cited ref | off | system prompt, `answer` validation |
| `FEAT_STRUCTURED_FACTS` (alias `STRUCTURED_FACTS`) | Typed slot store: `scratchpad.facts[name] = {value, description, source, confidence}`. Sources auto-promote to `refs` (legacy mode only). | off | system prompt, scratchpad init, `answer` validation |
| `FEAT_REFS_WHY_CANONICAL` | `scratchpad.refs_why` becomes the **only** citation channel; `refs` is derived; `scratchpad.cite(path, reason)` is the API; auto-cite disabled | off | system prompt, `scratchpad.cite` injection, `answer` derive+validation |
| `FEAT_DEBUG_REF_PROBE` | Run the diagnostic ref-alias probe on submission (logs every on-disk path each cited `.json` resolves to) | off | `harness.answer` (diagnostic only — never blocks) |

> ⚠️ **Not implemented.** Earlier drafts of this doc described `FEAT_READ_BEFORE_MUTATE`, `FEAT_ALLOWED_OPS`, and `FEAT_GATE_OUTCOME`. **None of these exist in the current codebase** — they are not parsed in `src/config.ts` and setting them has no effect. Their design sections below are retained as historical design notes, clearly banner-flagged, in case they're revived. The flag-bisection orchestrator's defaults were corrected to stop referencing them.

Plus two non-binary knobs:

| Variable | Default | Notes |
|---|---|---|
| `REASONING_EFFORT` | `medium` | OpenRouter `reasoning.effort` for agent calls. `low` / `medium` / `high` / `off`. Silently ignored by non-reasoning models. |

To probe whether your model actually returns reasoning tokens:

```sh
bun run scripts/test-reasoning.ts xiaomi/mimo-v2.5-pro medium
```

It prints `usage.completion_tokens_details.reasoning_tokens` and the contents of `message.reasoning` so you can verify reasoning is live and worth paying for. When it is, every `step` event in `runs/*.jsonl` carries `reasoning`, `reasoningTokens`, `completionTokens`, `promptTokens`.

---

## FEAT_LAZY_MD

**What it does:**

1. On bootstrap, scans the whole workspace tree for `*.md` files, partitions into `/docs/**` (inlined as today) vs other (path-only list).
2. Emits a `<workspace-md-index>` block listing every non-`/docs` `.md` path.
3. Wraps `harness.tree/list/find/search/stat` to scan their structured outputs for `.md` paths. Any not-yet-preloaded path is queued into `pendingMdPaths`.
4. After each turn (post-script-execution), `drainPendingMd` reads queued paths up to **50KB total per turn**, appends their content as `<workspace-docs-extra path="…">` blocks in the next system prompt, and adds them to the read set + auto-cite (if `FEAT_AUTO_CITE` also on).
5. Over-budget skips emit a `<workspace-md-budget-exceeded>` block AND a `bus.emit("bootstrap", tool="md_budget_exceeded")` event so violations are visible in the web UI / logs.

**Why:** bucket-#2 failures (t24/t30/t34/t41) were 2-step denies that never consulted addenda/policy elsewhere in the tree. Auto-materializing addenda when the model lists their parent folder removes that failure mode without per-task hints.

**Risks:** token bloat per turn; over-citing if `FEAT_AUTO_CITE` also on; cap can hide files the model actually needs (loud notice mitigates).

---

## FEAT_READ_BEFORE_MUTATE

> ⚠️ **Not implemented in the current codebase** — historical design note only. No such flag is parsed in `src/config.ts`.

**What it does:** `harness.write` (overwriting an existing path) and `harness.delete` require the path to be in the read set first. If missing:

- For `write`: the harness tries `vm.read(path)`. If path exists, throws with current content embedded in the error message; the path joins read set + auto-cite. If path doesn't exist, the write proceeds (new file, no precondition).
- For `delete`: same as write-on-existing — always soft-blocks unless read.

The model receives the content inside the error string and can re-issue the mutation next turn (no extra read-step needed).

**Why:** prevents destructive surprises (overwriting an unknown file) and turns the harness into a collaborator — model gets the content it needed in the same error.

**Risks:** one extra turn per "wanted to mutate without reading" pattern. Champion auto-tracks similar precondition without the soft-block.

---

## FEAT_AUTO_CITE

**What it does:** every successful `harness.read`, every preloaded `/docs/**/*.md`, `/AGENTS.MD`, and every lazy-fetched `.md` auto-pushes its path into `scratchpad.refs` (dedupe). Manual `refs.push` still works (idempotent).

**Why:** under-citing was killing trials (t16 had `refs=[]` entirely). Auto-cite makes the citation list match "what I actually read". Combined with `FEAT_STRICT_REFS`, the gate semantics tighten to "cite=evidence, not existence".

**Risks:** over-citing if the model reads exploratory files. Mitigation: prompt nudge to use `tree/list/find/search` for discovery, reserve `read` for evidence. NOTE: a previous attempt at submit-time union of `openedPaths` into refs was rejected by the grader for over-citing — auto-cite-on-read is narrower (only paths actually `read`).

---

## FEAT_ALLOWED_OPS

> ⚠️ **Not implemented in the current codebase** — historical design note only. No such flag is parsed in `src/config.ts`.

**What it does:** model must declare `scratchpad.allowed_ops` as a subset of `["write","delete"]` before calling `harness.write` or `harness.delete`. Default `[]` (read-only). Undeclared op → hard throw with fix-it. Model can re-declare any time during the trial.

`exec` is **NOT** gated — it's the read-only query path (`/bin/sql`, `/bin/whoami`, `/bin/date`). Gating exec broke every task's step 1 in run `9f2733` (0%). This is intentional and load-bearing.

The `answer` gate also validates `allowed_ops` shape at submit (if set, must be a string array of valid op names).

When the flag is on, `runAgent` initializes `scratchpad.allowed_ops = []`.

**Why:** generic replacement for domain-specific "did you actually X?" heuristics. Model self-classifies its task, harness enforces.

**Risks:** model may misclassify and burn turns on the gate. Doesn't catch "narrated checkout without action" because `exec` is free.

---

## FEAT_GATE_OUTCOME

> ⚠️ **Not implemented in the current codebase** — historical design note only. No such flag is parsed in `src/config.ts`.

**What it does:** at `harness.answer` pre-flight (after refs+outcome checks, before verify), scans scratchpad for keys ending in `_gate`. If any value is exactly `"NO"` or `"BLOCKED"` AND `outcome === "OUTCOME_OK"`, throws with a fix-it suggesting to flip outcome or clear the gate.

**Why:** catches the contradiction where the model sets a gate to NO but still claims OK. Cheap (15 LOC), deterministic, zero false positives by the `_gate` suffix convention.

**Risks:** none material. Suffix convention is already in the prompt.

---

## FEAT_STRICT_REFS

**What it does:** tightens the `answer` refs validity check from "must be in `openedPaths`" (anything ever read/listed/statted/written/deleted) to "must be in `readSet`" (only paths whose content was loaded — read + preloaded). Discovery via `list`/`stat`/`tree`/`find`/`search` no longer qualifies a path for citation.

Also flips `harness.opened()` to return `readSet` instead of `openedPaths` so debug introspection matches.

**Why:** cite = "I used the content", not "I know it exists". A `list` of a folder doesn't justify citing every file in it.

**Risks:** if model habitually `list`s + cites, this will start throwing. Pair with `FEAT_AUTO_CITE` so the model doesn't need to manage refs at all.

---

## CITING_REASONING

**What it does:** when on, `scratchpad.refs_why` must be an object mapping every cited path to a justification string of ≥ 8 characters. `harness.answer` rejects the submission and lists missing / too-short entries; the agent retries.

A short `<refs-reasoning-required>` block is injected into the system prompt explaining the contract.

**Why:** forces the model to articulate, at submit time, *why* each file backs the answer. If it can't fill in a real reason, it should remove the cite rather than invent one. Targets the "ritual read = ritual cite" failure mode.

**Risks:** the model can write hollow reasons just to pass the check. The 8-char minimum is a smell test, not a guarantee.

---

## STRUCTURED_FACTS

**What it does:** preinitialises `scratchpad.facts = {}` and injects a `<structured-facts-required>` system-prompt block explaining a typed slot store:

```js
scratchpad.facts = {
  slot_name: {
    value: <resolved value, or null while pending>,
    description: "what this slot represents — write BEFORE the value is known",
    source: "<workspace path that proved this value>" | null,
    confidence: "pending" | "derived" | "verified"
  }
};
```

The model is asked to commit slots on turn 1 (with `value: null, confidence: "pending"`), then resolve them as tool calls succeed. `harness.answer` validates each slot: every populated slot needs a workspace-path `source` and `confidence ∈ {verified, derived}`. Empty slots (still `null`) are tolerated.

**Refs auto-promotion:** every non-null slot's `source` is merged into `scratchpad.refs` (deduped) BEFORE the refs-validity check runs. The model doesn't need to maintain `refs` manually — the slot sources ARE the citations.

**Why:** generic working-memory pressure. The model's natural failure mode is to transcribe values from prior tool output into code comments on a later turn (since `const` JS variables don't survive turns). Slots survive natively in scratchpad, so the model can store SKU mappings, IDs, computed values once and re-read them as structured data instead of OCR-ing its scrollback.

**Risks:** if the prompt section is the only enforcement, the model can ignore the slot entirely (we observed this on at least one run). Empty `facts: {}` currently passes validation trivially. A future hardening would refuse `OUTCOME_OK` submissions whose `answer` value isn't traceable to a verified slot.

---

## FEAT_REFS_WHY_CANONICAL

**What it does:** makes `scratchpad.refs_why` the single source of truth for citations. When on:

- A non-enumerable `scratchpad.cite(path, reason)` method is injected into the sandbox ([src/loop.ts](../src/loop.ts)). It is **atomic**: it throws immediately if `path` isn't an absolute path that was actually read this trial (in `readSet` or preloaded), or if `reason` is under 8 non-whitespace chars. This is the only documented way to cite.
- `scratchpad.refs` becomes a **derived, read-only mirror** — at `harness.answer` time it is recomputed as `Object.keys(scratchpad.refs_why)` (see `deriveCanonicalRefs` in [src/gates.ts](../src/gates.ts)). Assigning to `refs` directly is pointless; it gets overwritten.
- Auto-cite is **disabled regardless of `FEAT_AUTO_CITE`**, and `FEAT_STRUCTURED_FACTS` slot sources are **not** auto-merged — the model must `cite()` each one explicitly with its own reason.
- The `<citation-protocol-canonical>` system-prompt block replaces the looser `<refs-reasoning-required>` block.

**Why:** the legacy auto-cite/auto-merge paths produced boilerplate reasons the grader penalized as over-citing. Forcing an explicit, reasoned `cite()` per path makes every citation model-authored and load-bearing.

**Risks:** stricter — a forgotten `cite()` means a missing ref (grader 0). The system-prompt block leans heavily on "rewrite the reason, don't drop the file" to counter over-pruning.

---

## FEAT_DEBUG_REF_PROBE

**What it does:** purely diagnostic. When on, `harness.answer` runs a probe before the gates: for every `.json` path about to be cited, it calls `find(name: basename)` and emits a `bootstrap` event (`tool="ref_alias_probe"`) listing every on-disk path that basename resolves to. This surfaces brand-mirror vs category-mirror vs flat aliases in the run log so you can see where the grader's "valid reference" form actually lives.

**Why:** the BitGN catalog has alias paths; the grader compares refs by exact string equality. The probe makes alias mismatches visible from `runs/*.jsonl` instead of inferred from a single grader hint.

**Risks:** adds one `find` RPC per cited `.json` on **every** submission attempt (including retries), so it sits on the latency-critical submit path — hence it is **off by default** and gated behind this flag. It never blocks submission (failures are swallowed).

---

## Suggested bisect plan

Across the flags that **actually exist** today:

1. **All off** — confirm parity with the 67.6% baseline (run `f4bf2f`). If different, something else changed.
2. **`FEAT_LAZY_MD=true`** (alone). Check bucket-#2 tasks (t24/t30/t34/t41) — do `<workspace-docs-extra>` blocks appear when the model lists subfolders? Do those tasks score higher?
3. **`FEAT_AUTO_CITE=true`** — big behavior shift. Check refs lengths in `[answer submitted]` events; if blowing up, also enable `FEAT_STRICT_REFS` to tighten and force the model to be deliberate about reads.
4. **`FEAT_STRICT_REFS=true`** — depends on the read-set discipline, so layer it after auto-cite.
5. **`FEAT_CITING_REASONING=true`** — once the refs gates settle, layer reasoning-per-cite on top.
6. **`FEAT_STRUCTURED_FACTS=true`** — orthogonal to the refs flags; tests whether structured working memory changes the SQL-verification discipline. Pair with `REASONING_EFFORT=medium` (default) for the model to actually use the slots.
7. **`FEAT_REFS_WHY_CANONICAL=true`** — the strictest citation regime; supersedes the auto-cite/auto-merge paths. Test last, on its own.

Run the same 7 tasks each pass (`bun run main.ts t02 t13 t22 t27 t34 t39 t41`). Compare per-task scores in `tasksState.ts` after each run. t02 is the control — if it ever drops to 0, the latest flag is the regression.

For an automated multi-config sweep:

```sh
bun run scripts/run-experiment.ts baseline "" 2
bun run scripts/run-experiment.ts solo_GATE_OUTCOME "FEAT_GATE_OUTCOME=true" 2
# ...etc. Aggregated per-task means + run IDs land in docs/flag-experiments.md.
```

The orchestrator handles BitGN's ~1 run/min rate limit (75s inter-run sleep + auto-retry on rate-limit responses) and writes a markdown row per config.

---

## Validation checklist

After flipping a flag on:

- [ ] Flag recorded: confirm the flipped flag is `true` under `run:start.envFlags` in `runs/<runId>.jsonl`
- [ ] Tests pass: `bun test`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Smoke test 1 task: `bun run main.ts t02`
- [ ] Full 7-task run: `bun run main.ts t02 t13 t22 t27 t34 t39 t41`
- [ ] Compare `tasksState.ts` per-task scores vs baseline
- [ ] Document the result in `docs/BISECT_LOG.md` (create if missing)
