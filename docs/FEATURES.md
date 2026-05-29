# Feature flags

Experimental harness changes are env-flag-gated. All default **OFF** so the agent runs identical to the pre-change baseline. Flip them on one at a time in `.env` (or as env vars) to bisect impact on the BitGN score.

Values accepted as "on": `true`, `1`, `on`, `yes` (case-insensitive). Anything else = off.

At the start of each run, the harness logs (and now also records to `runs/<runId>.jsonl` under `run:start.envFlags`):

```
[features] LAZY_MD=… READ_BEFORE_MUTATE=… AUTO_CITE=… ALLOWED_OPS=… GATE_OUTCOME=… STRICT_REFS=… CITING_REASONING=… STRUCTURED_FACTS=… REASONING_EFFORT=… JUDGE_REASONING_EFFORT=…
```

so you can confirm what was active without re-reading `.env`.

---

## Flag reference

| Flag | Change | Default | Touches |
|---|---|---|---|
| `FEAT_LAZY_MD` | `.md` index + lazy preload | off | bootstrap, `tree/list/find/search/stat`, per-turn drain |
| `FEAT_READ_BEFORE_MUTATE` | Soft-block mutations on unread paths | off | `write`, `delete` |
| `FEAT_AUTO_CITE` | Auto-push read paths into `scratchpad.refs` | off | `read`, `write`, `delete`, bootstrap, lazy preload |
| `FEAT_ALLOWED_OPS` | Declare `scratchpad.allowed_ops` for mutations | off | `write`, `delete`, `answer` shape check, scratchpad init |
| `FEAT_GATE_OUTCOME` | `*_gate=NO/BLOCKED` forbids `OUTCOME_OK` | off | `answer` pre-flight |
| `FEAT_STRICT_REFS` | Tighten refs gate from `openedPaths` to `readSet` | off | `answer` refs check, `harness.opened()` |
| `CITING_REASONING` | Require `scratchpad.refs_why[path] = "≥8-char reason"` for every cited ref | off | system prompt, `answer` validation |
| `STRUCTURED_FACTS` | Typed slot store: `scratchpad.facts[name] = {value, description, source, confidence}`. Sources auto-promote to `refs`. | off | system prompt, scratchpad init, `answer` validation |

Plus two non-binary knobs:

| Variable | Default | Notes |
|---|---|---|
| `REASONING_EFFORT` | `medium` | OpenRouter `reasoning.effort` for agent calls. `low` / `medium` / `high` / `off`. Silently ignored by non-reasoning models. |
| `JUDGE_REASONING_EFFORT` | `low` | Same for the pre-submission judge. |

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

**What it does:** model must declare `scratchpad.allowed_ops` as a subset of `["write","delete"]` before calling `harness.write` or `harness.delete`. Default `[]` (read-only). Undeclared op → hard throw with fix-it. Model can re-declare any time during the trial.

`exec` is **NOT** gated — it's the read-only query path (`/bin/sql`, `/bin/whoami`, `/bin/date`). Gating exec broke every task's step 1 in run `9f2733` (0%). This is intentional and load-bearing.

The `answer` gate also validates `allowed_ops` shape at submit (if set, must be a string array of valid op names).

When the flag is on, `runAgent` initializes `scratchpad.allowed_ops = []`.

**Why:** generic replacement for domain-specific "did you actually X?" heuristics. Model self-classifies its task, harness enforces.

**Risks:** model may misclassify and burn turns on the gate. Doesn't catch "narrated checkout without action" because `exec` is free.

---

## FEAT_GATE_OUTCOME

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

## Suggested bisect plan

1. **All off** — confirm parity with the 67.6% baseline (run `f4bf2f`). If different, something else changed.
2. **`FEAT_GATE_OUTCOME=true`** — smallest blast radius. Look for fewer `OUTCOME_OK` + gate=NO contradictions in the trial logs.
3. **`FEAT_LAZY_MD=true`** (alone, GATE_OUTCOME still on or reverted). Check bucket-#2 tasks (t24/t30/t34/t41) — do `<workspace-docs-extra>` blocks appear when the model lists subfolders? Do those tasks score higher?
4. **`FEAT_ALLOWED_OPS=true`** — model now declares `allowed_ops`. Watch for first-step gate hits; if frequent, the prompt may need a stronger nudge.
5. **`FEAT_READ_BEFORE_MUTATE=true`** — only after ALLOWED_OPS, since mutations are rare without it. Soft-block fires should appear as `[runtime error] harness.write(...) soft-blocked` in step logs.
6. **`FEAT_AUTO_CITE=true`** — biggest behavior shift. Check refs lengths in `[answer submitted]` events; if blowing up, also enable `FEAT_STRICT_REFS` to tighten and force model to be deliberate about reads.
7. **`FEAT_STRICT_REFS=true`** — last for the original six, since it depends on the read-set discipline.
8. **`CITING_REASONING=true`** — once the refs gates settle, layer reasoning-per-cite on top.
9. **`STRUCTURED_FACTS=true`** — orthogonal to the refs flags; tests whether structured working memory changes the SQL-verification discipline. Pair with `REASONING_EFFORT=medium` (default) for the model to actually use the slots.

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

- [ ] Run boots: `[features] …=true` for the flipped flag shown in stderr
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Smoke test 1 task: `bun run main.ts t02`
- [ ] Full 7-task run: `bun run main.ts t02 t13 t22 t27 t34 t39 t41`
- [ ] Compare `tasksState.ts` per-task scores vs baseline
- [ ] Document the result in `docs/BISECT_LOG.md` (create if missing)
