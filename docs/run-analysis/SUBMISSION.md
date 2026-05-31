# Competition submission decision — bitgn/ecom1-prod

Date: 2026-05-30. Author: analysis pass over `runs/*.jsonl` (no grader scores —
prod scores are LOCKED; accuracy is inferred from the agent's own retrieved data).

## TL;DR

| Category | Chosen run | Why (one line) |
|---|---|---|
| **Accuracy** | `20260530-123751-2f5290` | Only clean (≥99% answered) **filesystem-first** run; fs-first is the dominant documented accuracy fix. |
| **Open weights** | `20260530-123751-2f5290` | Same run. ⚠️ contingent on confirming `xiaomi/mimo-v2.5-pro` is on the approved open-weights list (could not verify — no web access). |
| **Speed** | `20260530-123751-2f5290` | Fastest *clean* run (342s wall) **and** lowest steps/task (4.8, concurrency-independent). |

One run wins all three. It is the rare run that is filesystem-first (correct for
this VM), ~complete (99% answered, only t092 missing), and fast.

---

## Method (what was actually done)

1. `run-summary.ts` → enumerated every prod run. Kept runs with 100 trials.
2. Wrote `scripts/pick-run.ts` to classify each complete prod run by **prompt era**
   (does the bootstrap system prompt contain "NO WORKING SQL"), `REASONING_EFFORT`,
   answered %, no-answer task ids, and **avg steps/task**; plus a fixed 16-task
   inferential sample (lookup/count/decide/refusal/dispatch/discount/checkout) dumped
   head-to-head across all candidates.
3. Judged accuracy by **outcome-class agreement** on the disputed tasks against the
   documented correct answers in `docs/run-analysis/PATTERNS.md`.

---

## Candidate field (100-trial prod runs)

| run | prompt era | effort | answered | no-answer ids | avg steps |
|---|---|---|---|---|---|
| 135141-ebdad4 | **fs-first** | medium | 96–97% | t004,t024,t044(,t014) | 4.9 |
| 134905-b75aa6 | **fs-first** | low | **76%** | 24 tasks | 4.1 |
| 131746-658d21 | **fs-first** | medium | 98% | t014,t024 | 5.1 |
| 125157-f8ee5b | **fs-first** | medium | 98% | t004,t014 | 5.2 |
| **123751-2f5290** | **fs-first** | medium | **99%** | t092 | **4.8** |
| 114149-8fee0d | sql-first | low | 100% | — | 6.6 |
| 114102-97e375 | sql-first | low | 100% | — | 6.1 |
| 114102-65eb5b | sql-first | low | 100% | — | 6.3 |
| 114102-5ce0a8 | sql-first | low | 100% | — | 6.4 |
| 114102-161561 | sql-first | low | 99% | t009 (err) | 6.3 |
| 112557-d6c1e7 | sql-first | low | 100% | — | 6.6 |
| 110611-0c35b3 | sql-first | low | 100% | — | 6.4 |

Dropped as not-clean: **b75aa6** (76% answered — the only low+fs "ideal config"
run, wrecked, almost certainly concurrency=50 timeout damage, not a logic problem)
and **ebdad4** (3–4 no-answers, <99%). Older glm-5.1 / grok-4.3 / claude runs are
0% answered — ignored. dev runs (mean 0.65–0.79) used only as a model-capability
prior, not prod accuracy.

**The structural split is the whole story:** every run whose prompt still says
SQL-first is effort=low and 100%-answered; every filesystem-first run is
effort=medium (except the broken b75aa6). So there is **no clean run that is both
filesystem-first AND effort=low** — the intended optimum was never captured.

---

## Evidence the filesystem-first era is more accurate

Grader scores are locked, so this is inferential — but three independent signals
all point the same way.

**1. Step efficiency (concurrency-independent, verified from logs).**
fs-first runs average **4.8–5.2 steps/task**; sql-first runs **6.1–6.6**. That
~1.5-step gap is the dead-SQL waste documented in PATTERNS.md P1 (the agent issues
empty SQL, re-checks schema, then falls back to the filesystem). Fewer wasted steps
also means fewer budget-death no-answers on slow task instances.

**2. Outcome-class correctness on disputed tasks (head-to-head sample).**
- **t063** (employee-actor purchase → must be `OUTCOME_NONE_UNSUPPORTED`, per P4):
  fs-first **5/5 correct** (NONE_UNSUPPORTED "nein"); sql-first **wrong in ~5/7**
  (97e375, 65eb5b, 5ce0a8, 161561, 0c35b3 all returned `OUTCOME_OK`). Clear era-B win.
- **t010** (checkout, guest/ownership refusal → DENIED_SECURITY): fs-first uniformly
  DENIED_SECURITY; sql-first diverges — 65eb5b/d6c1e7 went NONE_UNSUPPORTED, and
  **0c35b3 leaked the enum into the answer** (`answer = "OUTCOME_NONE_UNSUPPORTED"`,
  the P5 bug).
- **t083** (3DS recovery → OK): fs-first all OK; sql-first 0c35b3 false-refused
  (DENIED_SECURITY) — the P4 absence→refusal cluster.
- **t069** (checkout): sql-first 97e375 false-negatived ("basket not found", 2 steps);
  fs-first clean apart from b75aa6's no-answer.

**3. Reasoning quality is equal** — both eras nail the unambiguous tasks (t098
discount-refusal DENIED_SECURITY everywhere; t036 export path everywhere). The
model isn't the variable; the prompt era is.

The cost of era-B is coverage: the clean fs-first run (2f5290) gives up perfect
coverage for **one** no-answer (t092). That single guaranteed zero is far cheaper
than the ~5 wrong outcome-classes era-A eats on t063 alone.

---

## Per-category justification

### Accuracy → `20260530-123751-2f5290`
The only filesystem-first run that clears the ≥99%-answered bar. fs-first is the
single highest-leverage correctness fix in this VM (kills dead-SQL step-waste and
the absence→refusal / employee-purchase outcome errors), and 2f5290 demonstrates
the era-B correct outcome classes on every disputed sample task (t010 DENIED guest,
t063 NONE "nein", t083 OK, t098 DENIED). Coverage is near-perfect (99%, only t092).
**Tradeoff accepted:** effort=medium, although the dev-score prior says low ≳ medium
— I weight the fs-first prompt advantage above the effort effect, and no clean
low+fs run exists to take instead. One visible blemish: t095 returned "basket not
found" (2 steps) — a probable discount false-negative.

*Alternates if you distrust a single fs-first run:* `658d21` / `f8ee5b` (also
fs-first/medium, 98% answered, 2 no-answers each) — strictly worse coverage than
2f5290, no accuracy reason to prefer them.

### Open weights → `20260530-123751-2f5290`
Accuracy is the tiebreaker within the open-weights category too, so the Accuracy
pick carries over (all candidates use the same model, so the choice of run doesn't
change model eligibility). **⚠️ Corner I could not close:** I could not verify that
`xiaomi/mimo-v2.5-pro` is on the competition's approved open-weights list (no web
access this session). Confirm that before submitting here; if mimo is *not*
approved open-weights, there is no eligible run (every answered run uses it).

### Speed → `20260530-123751-2f5290`
Wall-clock is concurrency-dependent and the logs don't record concurrency
(`concurrency: None`), so I lean on the concurrency-independent metric: **steps/task**,
where 2f5290 is lowest of all clean runs (4.8) — fewer model round-trips is
structurally faster regardless of concurrency. It also happens to have the lowest
wall-clock among complete clean runs (342s; next is era-A 0c35b3 at 403s, which is
slower *and* sql-first). Median per-step latency (~13.7s) is in-band with the field.
**Tradeoff accepted:** the two genuinely fast runs (b75aa6 142s, ebdad4 422s) are
dropped for incompleteness; among runs that actually finished, 2f5290 is the fast one.

---

## Corners cut (explicit)

1. **No grader scores** — all accuracy is inferential (outcome-class + groundedness),
   per the locked-prod constraint. Cannot distinguish two runs that pick the same
   outcome class but differ on the exact literal answer.
2. **Open-weights eligibility of mimo-v2.5-pro is unverified** (no web). Blocking
   check before the open-weights submission.
3. **SQL-usage auto-detector misfired** — `pick-run.ts` counted 0 `/bin/sql` calls in
   every run (regex didn't match however the sandbox invokes it). I did **not** rely
   on it; the dead-SQL waste signal comes from avg-steps/task + the verified counts
   in PATTERNS.md (598 calls, ~98% empty).
4. **Sample = 16 tasks, one trial/run/task, per-trial randomized records.** Cross-run
   comparison is limited to outcome-class agreement, not exact-answer equality.
5. Concurrency not recorded in logs → wall-clock comparisons are soft; mitigated by
   using steps/task as the primary speed metric.

## If you want the true optimum instead of the best available
Re-run the **filesystem-first prompt + REASONING_EFFORT=low** config at a *safe*
concurrency (the only existing low+fs run, b75aa6, was run at concurrency=50 and
timed out to 76% answered — the config wasn't the problem, the concurrency was).
That combines era-B's accuracy/step-efficiency with the dev-prior's low>medium edge
and should beat 2f5290 on all three axes. Until that run exists and comes back
clean (100 trials, ≥99% answered), **2f5290 is the pick.**

---

## Outcome (added 2026-05-31) — what actually placed

The analysis above is preserved as written. **The run that actually landed top-20 on
the blind leaderboard was not `2f5290`.** It was `run-22RxPyYQ4dtnsaeKdXpRsJ6ce` =
local `20260530-114102-65eb5b` — the **sql-first era, `REASONING_EFFORT=low`** run
this doc had de-prioritized as "era A".

Why the inferential pick missed: with prod scores locked, accuracy here was judged by
outcome-class agreement on a 16-task sample, which favored the fs-first/medium era
(`2f5290`). The real grader rewarded the low-effort run — consistent with the
independent dev-prior ("low ≳ medium", `docs/flag-experiments.md`) that this doc
explicitly *down-weighted*. Lesson: when a locked-score inference contradicts a
measured dev prior, don't override the measured signal.

The published architecture write-up (`docs/insights-submission/`) and the
`.env.example` champion defaults are built around `65eb5b`, not `2f5290`.
