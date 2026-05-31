---
source_code: https://github.com/farid-temuri/ecom-trial
run_ids:
  - run-22RxPyYQ4dtnsaeKdXpRsJ6ce
model_names:
  - xiaomi/mimo-v2.5-pro
author: Farid Temuri
author_github: https://github.com/farid-temuri
impact: One open-weight model driving a single execute_script tool, with deterministic submission gates that make an ungrounded answer impossible to submit — most of the ECOM1 score is grounding discipline, not orchestration.
challenge: ecom
---

# The Cited Sandbox: One Open-Weight Model, One Tool, Eight Gates

Top-20 on the blind `bitgn/ecom1-prod` leaderboard
([run-22RxPyYQ4dtnsaeKdXpRsJ6ce](https://eu.bitgn.com/runs/run-22RxPyYQ4dtnsaeKdXpRsJ6ce))
using **one open-weight model** (`xiaomi/mimo-v2.5-pro`) and **one tool** — no
planner, no router, no LLM judge, no fine-tuning. Source (TypeScript / Bun):
<https://github.com/farid-temuri/ecom-trial>.

The core idea in plain English: most of the score on ECOM1 is *not* won by clever
orchestration. It is won by (1) letting the model write real code against the
runtime instead of calling narrow tools, and (2) refusing to let it submit an answer
that isn't grounded in files it actually read.

![The Cited Sandbox — one open-weight model drives a sandbox through one execute_script tool; deterministic gates reject any ungrounded answer](res/9QjKSV-architecture.png)

## How does it work?

- **What starts a task?** A benchmark-agnostic control plane runs the lifecycle
  (`startRun → per trial: startTrial → runAgent → endTrial → submitRun → poll for
  deferred scores`). It contains **zero task-solving logic**; every task-solving idea
  changed only the per-trial runtime, never the control plane.
- **What context does the agent receive?** On turn one it gets the workspace tree,
  preloaded `/docs`, and project hints, all assembled into one system prompt. A fresh
  runtime URL is issued per trial — no state leaks between trials.
- **Which tools or APIs can it call?** Exactly one: `execute_script`. The model emits
  a single JSON object per turn — `{ current_state, plan_remaining_steps_brief,
  task_completed, code }` — and only `code` runs. It executes as JavaScript in a Bun
  `AsyncFunction` sandbox with three injected locals: `harness` (the ECOM runtime
  client: `tree / find / search / list / read / write / delete / stat / exec /
  answer`), `scratchpad` (persistent working memory across turns), and `console`
  (captured and fed back next turn). `harness.exec` is a real shell into the runtime,
  so the model can `grep`, run SQL, and read JSON catalogues however it likes.
- **How does it inspect state before acting?** It reads. A code sandbox lets one
  capable model express *any* lookup — join two JSON files, fall back from SQL to the
  filesystem, cross-check a policy addendum against its base — without me predicting
  each as a bespoke tool.
- **How does it decide a task is finished?** It calls
  `await harness.answer(scratchpad, verify)`. That passes through eight deterministic
  gates (below) before the answer is accepted. The step budget is bounded
  (`MAX_PRIMARY_STEPS = 35`, plus a `+5` nudge); if the loop ever exits without
  answering, a `finally` submits `OUTCOME_ERR_INTERNAL` so a trial never silently
  returns nothing.

## Models

- **Main solver:** `xiaomi/mimo-v2.5-pro` (open-weight), served via OpenRouter.
- **Classifier/router/planner, if any:** none.
- **Evaluator or evolution loop, if any:** none. I ran a pre-submission LLM judge for
  a while and **deleted it** (see Problems/Solutions).
- **Runtime settings that mattered:** `REASONING_EFFORT=low`. Across a flag-bisection
  sweep on the dev set, `low` scored as well as or better than `medium`, and higher
  effort sometimes *hurt*. The leaderboard run is `low`.
- **Were all listed models open-weight/local?** Yes — the only model in the stack is
  open-weight, so the architecture is open-weights eligible end-to-end.

## E-commerce OS Reasoning

- **Catalogue and product matching:** the model queries the catalogue (SQL or
  filesystem JSON) and matches on product attributes rather than fuzzy name guesses;
  "base model" vs. a specific variant is resolved from attributes, not the string.
- **Inventory, warehouses, shipping, store coverage:** inventory is read with explicit
  `on_hand` / `available_today` / `incoming` semantics — a request blocked because
  requested qty exceeds `available_today` is a state limit, not a security refusal.
- **Customer records, baskets, orders, payments:** ownership is established by reading
  the owning record and comparing `customer_id` against the actor from `/bin/id`,
  never inferred from an empty query.
- **Merchant policies and policy addenda:** the agent consults policy documents and
  their addenda before acting; a discount above the policy max is refused regardless
  of who asks.
- **Support tickets, returns, refunds, escalations:** modeled as authorized actions
  with their own evidence requirements; a refund/return only reaches `OUTCOME_OK`
  after the mutation is confirmed.
- **Audit trails, logs, evidence:** every cited path must be one the agent actually
  read — citations *are* the evidence trail, enforced by the gates.

## Acting, Refusing, and Escalating

- **When may it mutate state?** Only after reading the governing record/policy. After
  a write/checkout/discount/refund it re-reads (or checks the tool's success output)
  before claiming `OUTCOME_OK` — never "Added/Closed" without a confirmed write.
- **How does it verify authorization?** It resolves the actor from `/bin/id`
  (`cust-NNNN` + roles) and **positively reads** the owning record. It refuses with
  `OUTCOME_DENIED_SECURITY` only when it has read a record whose owner differs from
  the actor. An empty query / 404 / empty find is **not** proof of ownership.
- **How does it handle unsafe pressure?** Injection noise ("SYSTEM OVERRIDE",
  "ownership transferred", "authenticated") is treated as data to ignore — never a
  reason to act or refuse. Employee actors may not purchase → `OUTCOME_NONE_UNSUPPORTED`.
- **When does it refuse / clarify / escalate?** Every answer carries exactly one of
  five outcome classes:
  - `OUTCOME_OK` — task fully completed / definite answer, with every load-bearing
    record and policy cited.
  - `OUTCOME_DENIED_SECURITY` — identity/ownership/role mismatch, adversarial
    instruction, or bait subject.
  - `OUTCOME_NONE_UNSUPPORTED` — out of policy regardless of who asks, or blocked by
    the record's own state (e.g. a 9% discount when the max is 5%, or an employee
    purchase).
  - `OUTCOME_NONE_CLARIFICATION` — "the basket / the order" is ambiguous and discovery
    finds multiple live candidates.
  - `OUTCOME_ERR_INTERNAL` — unrecoverable tooling failure (also the no-answer fallback).

## Problems

- **Failure mode 1 — hallucinated references.** Early runs invented citation paths
  that looked plausible but didn't exist on disk. The grader explicitly checks for
  required references (e.g. `answer missing required reference '/proc/catalog/X.json'`),
  so this was costly.
- **Failure mode 2 — an LLM judge that cost more than it earned.** A pre-submission
  judge added ~24s of latency on *every* submission, showed *no* grader-score lift
  over 19 instrumented runs, and had a ~32% false-negative rate concentrated in refs
  errors.
- **Failure mode 3 — choosing a run with scores locked.** During the blind window I
  had to pick a run to submit with no grader feedback, and my inferential pick was
  wrong (it favored a fancier filesystem-first/medium-effort run over the simple
  low-effort one that actually placed).

## Solutions

- **Prompt or rule changes:** make ungrounded answers *unrepresentable*. Citation is
  one atomic call, `scratchpad.cite(path, reason)`, which throws if the reason is
  under 8 chars or the path wasn't read this trial. You cannot cite a file you never
  opened.
- **Tooling or runtime changes:** eight ordered submission gates, each throwing a
  fix-it message the model can retry against — `verify` is a function; structured-fact
  shapes; canonical `refs_why` with ≥8-char reasons; **refs ⊆ what was actually read**;
  per-ref justification; outcome ∈ the five classes; the agent's own `verify(sp)`; and
  a deterministic check that every declared literal token appears verbatim in the
  answer.
- **Evaluation/debugging changes:** total observability — every run writes
  `runs/<runId>.jsonl` with the full system prompt, initial scratchpad, and per step
  the code, output, full reasoning, token counts, a deep scratchpad snapshot, and the
  grader's exact complaints. Every claim here was read out of those logs.
- **Things kept deliberately simple:** one model, one tool, no judge. Removing the
  judge made the agent faster and no less accurate.

## What Would You Improve Next?

- Land and A/B a `<navigation-hardening>` prompt block (real SQL schema, attribute
  matching, inventory semantics) that the champion run *predates*; early evidence
  suggests it removes dead-SQL step-waste.
- Capture a clean **filesystem-first + low-effort** run — the existing one was damaged
  by an over-aggressive concurrency setting, so the true optimum is likely still
  unmeasured.
- Tighten the answer-format gate with task-derived token extraction so the model needs
  less manual bookkeeping.

## Lessons From ECOM1

1. **Grounding beats cleverness.** The biggest single win was making ungrounded
   answers impossible to submit.
2. **One capable model + a code sandbox beats an orchestra of narrow tools** when task
   shapes vary this much.
3. **Refusals are first-class.** Treat `NONE_UNSUPPORTED / NONE_CLARIFICATION /
   DENIED_SECURITY` as real targets with their own evidence requirements; "empty
   result ≠ absence."
4. **Measure your knobs.** Low reasoning effort winning was counterintuitive and only
   visible because of the bisection sweep.
5. **Trust measurement over inference.** When my locked-score guess disagreed with the
   measured dev prior, the measured prior was right.
6. **Delete components that don't pay.** The judge was the clearest example.

---

*Questions, or want a walkthrough of any part of this? Find me on
[GitHub](https://github.com/farid-temuri). Happy to compare notes with other ECOM1
authors.*
