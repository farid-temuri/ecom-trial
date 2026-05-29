# Investigating run logs — flow that actually finds gold

This is the playbook for digging into a `runs/<runId>.jsonl` file when results regress, when a feature seems broken, or when you need to understand *why* a task failed beyond what `scoreDetail` tells you.

The goal of an investigation is **a specific, actionable finding** — not "the model was confused". A finding names a step, a ref, a prompt clause, or a code path, and it points at a concrete fix.

---

## The hierarchy of evidence

When something looks wrong, walk this ladder. Don't skip rungs — the higher rungs are cheap and rule out 80% of guesses.

### Rung 0 — Aggregate score + score deltas

One number, one paired-diff. Cheap, decisive.

```bash
# Aggregate
jq -r 'select(.type=="trial:score") | .score' runs/<runId>.jsonl \
  | awk '{s+=$1; n++} END{printf "%.4f over %d trials\n", s/n, n}'

# Diff vs prior run
jq -r 'select(.type=="trial:score") | "\(.taskId) \(.score)"' runs/<prev>.jsonl > /tmp/prev.txt
jq -r 'select(.type=="trial:score") | "\(.taskId) \(.score)"' runs/<new>.jsonl > /tmp/new.txt
paste /tmp/prev.txt /tmp/new.txt \
  | awk '{if ($2 != $4) printf "%s  %.2f → %.2f  %s\n", $1, $2, $4, ($4>$2?"WIN":"LOSS")}'
```

If wins and losses are roughly balanced and small (±2-3 tasks), it might just be model noise — don't over-investigate. If one side dominates, dig.

### Rung 1 — Cluster the failures by `scoreDetail` text

The grader's `scoreDetail` is the single most useful signal. Pattern-match it.

```bash
jq -r 'select(.type=="trial:score" and .score<1) | "\(.taskId): \(.scoreDetail | join(" || "))"' runs/<runId>.jsonl
```

Failures cluster into a small number of shapes:

| Shape | Grader says | Real cause |
|---|---|---|
| Invalid ref | `answer contains invalid reference 'X'` | Model cited a path the grader treats as not-allowed-for-this-question, OR a non-canonical alias path. |
| Missing required ref | `answer missing required reference 'X'` | Model didn't cite a path the grader's required-set demands. |
| Outcome mismatch | `expected OUTCOME_X, got OUTCOME_Y` | Model picked the wrong outcome enum. |
| Format mismatch | `Answer should be "..."` / `Answer should contain '<YES>'` | `scratchpad.answer` literal didn't match. |
| Partial credit | `recovered ~X% EUR from fraud amount` | Domain-specific (fraud) — strategy completeness. |
| `ERR_INTERNAL` | `expected X, got OUTCOME_ERR_INTERNAL` | Loop exited without `harness.answer` — usually a parse failure on turn 1 or an uncaught exception. |

**Counting cluster sizes tells you what to prioritize.** Don't optimize for the rare shape if a common one is dominating.

### Rung 2 — Step-by-step for one representative task per cluster

Pick the smallest-step trace in each cluster (fewer steps = simpler diagnosis). Extract the trial's full timeline.

```bash
jq -c 'select(.type=="step" and .taskId=="t26") \
  | {step, ok, code: (.input.code[0:300]), reasoning: (.reasoning // "" | .[0:300]), out: (.output[0:200]), refs: .scratchpadAfter.refs, refs_why: .scratchpadAfter.refs_why}' \
  runs/<runId>.jsonl
```

Look for:
- **Step where the wrong thing was written.** Was it on turn 1 (model misclassified the task) or after a judge retry (model panicked and dropped a ref)?
- **`reasoning` field disagreement with `code` field.** The model sometimes plans correctly but writes the wrong code, or vice versa. Either is a finding.
- **`scratchpadAfter.refs` changing across steps.** A ref that appears in step N but is gone by step N+2 means the model removed it — usually after a judge rejection.

### Rung 3 — Judge transcripts on the failing task

For tasks where the judge ran (most), this is the smoking gun:

```bash
jq -c 'select(.type=="judge" and .taskId=="t26") | {attempt, ok, reason: (.reason // "" | .[0:200])}' runs/<runId>.jsonl
```

If a task failed and the judge approved the submission anyway → the judge's rule set is missing something. If the judge rejected and the model "fixed" it the wrong way → the judge's *rejection message* is misleading. Both are prompt findings, not model findings.

### Rung 4 — The system prompt the model actually saw

The `system_prompt` bootstrap event captures the exact text. When a finding hinges on "the prompt should have told the model to do X" — verify whether it did or didn't.

```bash
jq -r 'select(.type=="bootstrap" and .tool=="system_prompt" and .taskId=="t26") | .output' runs/<runId>.jsonl
```

This is also where stale flag references and prompt drift become visible. The `<workspace-docs>` and `<scratchpad>` blocks change per turn; the `SYSTEM_PROMPT_BASE` and the FEAT-gated blocks don't.

### Rung 5 — Cross-task aggregation

Once you have a hypothesis, validate it across tasks. Examples:

```bash
# Tasks where the judge rejected refs_why as vague
jq -r 'select(.type=="judge" and (.reason // "" | test("vague|load-bearing|self-disqualifying"))) | .taskId' runs/<runId>.jsonl | sort | uniq -c | sort -rn

# Tasks with parse failures on turn 1
jq -r 'select(.type=="step" and .errorMessage and (.errorMessage | test("Unrecognized token|NextStep validation"))) | .taskId' runs/<runId>.jsonl | sort -u

# Refs the model cited but the grader rejected (cross-tab against scoreDetail)
jq -r 'select(.type=="trial:score" and (.scoreDetail | join(" ") | test("invalid reference"))) | "\(.taskId): \(.scoreDetail[0])"' runs/<runId>.jsonl
```

---

## The two heuristics that actually find gold

These are the moves that have produced the highest-impact findings in this codebase.

### 1. **Compare grader reasoning against judge reasoning on the same task.**

The grader and the LLM judge are independent oracles. When they disagree on the same submission, the prompt is teaching the model to optimize for the wrong one.

Example from run 141510: judge rejected `/docs/security.md` as "not load-bearing" on t46. Model removed it. Grader then failed t46 for missing `/docs/security.md`. Two oracles, opposite verdicts, no place in the prompt acknowledged this conflict. **That gap is the finding.**

### 2. **Read the model's own reasoning when it noticed a contradiction.**

Models verbalize internal conflict in the `reasoning` field. Search for it:

```bash
jq -r 'select(.type=="step" and .reasoning) | "\(.taskId) step \(.step): \(.reasoning)"' runs/<runId>.jsonl \
  | grep -iE "contradict|conflict|but the prompt|but the rule|but it says|i'm confused|self-incrimin"
```

When the model writes *"This is contradictory"* in its reasoning, that's not the model being confused — that's the model **flagging a real bug in your prompt** for you. Treat those hits as ground truth and trace them back to the conflicting clauses.

This is how we found the multi-candidate-vs-zero-inventory contradiction (Finding 2 of the audit) — the model itself wrote "the citation protocol says NEVER cite a SKU whose inventory is 0... This is contradictory" in its turn-4 reasoning on t13.

---

## What NOT to spend time on

- **Long traces of passing tasks.** They're noise. Only inspect a pass if you suspect a flag did nothing (i.e. it didn't fire and yet the task passed).
- **The model's `code` field in isolation.** Always pair with `reasoning` and `scratchpadAfter`. Code without intent is just text.
- **Latency / token counts.** Sometimes useful for budget tuning. Usually a distraction during a correctness investigation.
- **"Why didn't the judge catch this?"** when the judge wasn't enabled. Confirm with `run:start.envFlags` first.

---

## Output shape of a finding

A useful finding is one paragraph:

> **Symptom (which tasks):** t26, t27, t46, t50 (missing `/docs/checkout.md`).
> **Prompt today says:** `<verbatim quote of the relevant clause, with line number>`.
> **Model behavior:** `<verbatim quote from reasoning or scratchpad>`.
> **Gap:** `<one sentence — exactly what's wrong>`.
> **Proposed change:** `<the new text, not "make it clearer">`.

If you can't fill all five lines, the finding isn't ready — go back a rung and gather more.

---

## When to bring in a subagent

For a single task or a single cluster you can read directly, stay inline.

For 5+ failing tasks that cluster on the same shape — dispatch a focused subagent with:
- The exact file path
- The exact `jq` commands to extract step data
- The specific question to answer (not "look at the failures" but "did the model drop a ref it had cited in an earlier step? — return yes/no per task with the step number")
- A required output shape

That's how the audits in this session stayed tight: 4 parallel agents, each with a 3-8 task cluster, each producing the same-shaped report. The synthesis is cheap once each cluster has a clean diagnosis.
