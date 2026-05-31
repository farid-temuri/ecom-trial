# Cross-cutting patterns — t001–t100, 9 runs (2026-05-30)

Synthesis of all 10 chunk analyses + direct verification against raw run data
(`scripts/verify-layout.ts`). No grader scores exist (competition locked); all
correctness is inferential, but the structural findings below are verified from
the agent's own tool outputs, not inferred.

Rough verdict tally across 100 task-families: **~44 LIKELY-CORRECT, ~40 MIXED,
~6 LIKELY-WRONG, ~10 UNCERTAIN.** The agent's *reasoning* is strong (refusals,
identity grounding, date math, status-gating, injection resistance are near
perfect). Almost all lost points come from a handful of **environment-mismatch**
and **self-inflicted mechanical** failures below, not from bad judgment.

---

## P1 — SQL IS DEAD IN THIS VM, AND THE PROMPT TELLS THE AGENT TO USE IT ⚠️ #1

**Verified:** 598 `/bin/sql` calls across 4 full runs, **~10 returned any rows
(~98% empty)** — and the few non-empty hits are file-fallback output, not SQL.
Every chunk independently reported it.

The current `<navigation-hardening>` block asserts `shopping_baskets`,
`store_inventory`, `product_variants` etc. exist and instructs SQL-first
discovery + "empty ≠ proof of absence, so re-query harder." Consequence:

- Every task burns **2–6 steps** issuing SQL that returns empty, re-checking
  `sqlite_schema`, re-querying, then falling back to the filesystem anyway.
- On the slow task instances this **starves the step budget → F8 no-answer**.
- Worse, when the agent *trusts* an empty SQL result as absence, it produces
  **false refusals** (F5): false `OUTCOME_DENIED_SECURITY` / false "not found"
  (t018, t049, t069, t070, t083).

This block was tuned on the **old t01–t20 VM where SQL worked**. It is now net
negative. **This is the single highest-leverage fix.**

### Verified real filesystem layout (from successful reads)
- **Baskets/carts:** `/proc/carts/<customer_id>/basket-XXXX.json` — nested per
  customer. Ownership = the basket lives under the actor's own `cust-NNNN` dir.
- **Stores:** `/proc/locations/<City>/store-<city>-<area>.json` (e.g.
  `/proc/locations/Graz/store-graz-puntigam.json`); also resolvable at
  `/proc/stores/store-...json` (alias — prefer the `/proc/locations/<City>/` form,
  read to confirm canonical path before citing).
- **Catalog:** `/proc/catalog/<Brand>/<SKU>.json` — brand folders with spaces
  (`/proc/catalog/Bosch Professional/PT-DRL-BOS-GSR55-BODY.json`).
- **Payments:** `/proc/payment-ledger/<cust>/...`, also `/proc/payments/...`.
- **Returns:** `/proc/return-workflows/<cust>/...`, also `/proc/returns/...`.
- **Staff:** `/proc/staff/...`. **Dispatch:** `/ops/dispatch/wave-XXXX/{dispatch.md,packages.tsv,lanes.tsv}`.
- **ID formats:** `cust-NNNN`, `basket-NNNN`, `pay-NNNN`, `order-NNNN`,
  `return-NNNN`, `store-<city>-<area>`. **Customer id uses a HYPHEN.**

---

## P2 — Two partial runs (0aded5, 1e8a80) are degraded infra, not logic

Chunks 5/7/8/9 found run `0aded5` returns an empty 0–3-step non-answer on
*nearly every* task, and `1e8a80` systematically no-answers ~7/10. These are the
two partial runs (87 and 70 tasks). They inflate the "no answers" picture: a
large share of zeros are **two bad runs**, not the agent's reasoning. *Action for
the operator, not a prompt change* — but P1's step savings also reduce budget
deaths in the healthy runs.

---

## P3 — Two universal self-inflicted gate-loops (F9) burn budget on ~70% of tasks

1. **Both decision tokens declared in `literal_tokens`.** The agent puts BOTH
   `<YES>`+`<NO>` (or `<APPROVE>`+`<DENY>`, `TRUE`+`FALSE`, `ja`+`nein`) into
   `literal_tokens`; the gate then requires BOTH to appear in `answer` →
   impossible → retries until budget death. Seen in t023, t030, t043, t045,
   t050, t057, t060, t080, and more.
2. **`facts` source-gate fires on un-sourceable slots.** The structured-facts
   gate rejects any slot with a `value` but no `source` path. But **derived
   values have no source file**: counts, sums, booleans, user-supplied
   thresholds, and the `/bin/id` identity/roles. The agent loops trying to
   "source" them. Near-universal across count/decision tasks.
3. **`path#row=<ID>` fragment citation trap.** Tasks mandating a
   `path#row=X` citation collide with `scratchpad.cite()`'s "must have been read
   this trial" precheck — the fragment is not a readable file. 3–6 steps wasted
   per run (t015, t055, t075) before the agent bypasses via `refs_why`.

---

## P4 — Outcome-class confusion (F5)

- **Absence → refusal.** Empty SQL / flat-path 404 taken as proof, yielding false
  `OUTCOME_DENIED_SECURITY` or false "not found" (t018, t049, t069, t070, t083).
  Root cause shared with P1. Rule already in prompt but loses to the SQL habit.
- **"Correct no-op" mislabeled.** When a record's own state blocks the action now
  (active 3DS challenge, future `retry_after`, `attempts == max`, already-paid),
  the right call is `OUTCOME_NONE_UNSUPPORTED` naming the blocker — the agent
  sometimes returns `OUTCOME_OK` (t023, t085, t086, t087).
- **Employee-actor purchase.** When `/bin/id` shows an employee and the task is a
  buy/checkout, purchasing is not supported → `OUTCOME_NONE_UNSUPPORTED`
  (employees.md + checkout.md), regardless of stock (t043: ~5/9 runs wrong; t063).
- **Identity regex bug.** Agent tests `cust_` but the real format is `cust-NNNN` /
  `roles: customer`, producing a false `DENIED_SECURITY` (t049).

---

## P5 — Format / answer-shape precision (F7, F10)

- Inventing `literal_tokens` the instruction never required (t038).
- Tag-wrapping numbers (`<COUNT:0>`, `[QTY:2]`) when bare `%d` was required (t045).
- **Outcome enum leaked into the answer:** `answer = "OUTCOME_NONE_UNSUPPORTED"`
  (t010). The outcome name is NEVER the answer.
- Narrative / qualifiers in `answer` instead of the frozen literal.
- **Phantom success:** `OUTCOME_OK "Added 1x…"` with no actual `harness.write`
  (t079, 4/7 runs). Act tasks must confirm the mutation (write + re-read) before OK.

---

## P6 — Discount-cap fabrication (F1/F11) — t095/t096/t097

The agent never reads-and-quotes `/docs/discounts.md`; it recalls the
reason→cap table and subtotal tiers from memory. Proof: the **same basket at the
same subtotal gets different caps across runs** (basket-0002@31980 → 10% and 12%;
basket-0013@11990 → 4% and 5%). Must read the doc and copy the exact table into a
doc-sourced fact slot before deciding any cap or calling `/bin/discount`.

---

## P7 — Cite precision (F3/F4)

- **Undercite on refusal:** drops the subject record / governing doc when refusing
  (t098, t099) — though the prompt says to always keep both.
- **Overcite on counts:** cites every record read instead of only the records that
  met the criterion (t089 cited all 7 employees when 1 matched; t036 cited 6–9
  when one ref was asked).

---

## Priority order for prompt changes
1. **P1** — rip out SQL-first guidance; make the agent filesystem-first with the
   verified layout. (Biggest single lever; fixes step-waste, many F8, and the
   absence→refusal F5 cluster.)
2. **P3** — kill the two gate-loops (single decision token; derived/identity facts
   need no source; cite base path for `#row=` fragments). Consider a small gate
   code change for #2 in addition to the prompt.
3. **P4** — outcome-class rules (no refusal-from-absence; correct-no-op →
   NONE_UNSUPPORTED; employee purchase; `cust-` hyphen identity match).
4. **P5/P6/P7** — format discipline, discount-doc read, cite precision.
