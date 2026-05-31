# Subagent briefing — t001–t100 run analysis

You are one of 10 analysts. Each owns 10 tasks. Read this whole file, then analyze
your assigned task range and write your chunk file. **Read-only analysis** — do
NOT modify any source file, the agent, the prompt, or the run logs. Your only
write is your one chunk markdown file.

## What the agent is

A TS/Bun agent solving the BitGN ECOM benchmark. Each task: the model gets an
instruction + a preloaded workspace (a simulated ecommerce OS with a SQL db,
`/proc/catalog/*.json` product records, `/proc/stores/*.json` inventory,
`/docs/*.md` policies, `/bin/*` tools). Each turn it emits one JSON object whose
`code` runs in a sandbox with `harness` (workspace client), `scratchpad`
(persistent state), `console`. It gathers evidence, then calls
`harness.answer(scratchpad, verify)` with `scratchpad.answer`, `scratchpad.refs`
(citations — paths it read), `scratchpad.outcome`, `scratchpad.facts`.

The agent works through 6 phases: 0 harvest context, 1 classify, 2 ground
identity/subject, 3 enumerate candidates, 4 act, 5 cite, 6 submit. Submission
gates enforce: refs are paths actually read, every ref has a ≥8-char reason in
`refs_why`, a valid `OUTCOME_*`, the agent's own `verify(sp)`, and literal-token
presence. A wrong subject, fabricated/extra path, missed policy, or silent guess
scores 0 — partial credit is rare.

## The data you analyze

`bun run scripts/dump-task.ts <taskId>` dumps that task across all 9 runs:
instruction, every step's reasoning + executed code + output, and the final
answer/refs/facts/outcome per run. Run it for each of your tasks. Output is
large (~50–90KB/task) — redirect to a file and Read it if needed:
`bun run scripts/dump-task.ts t0XX > /tmp/t0XX.txt` then Read `/tmp/t0XX.txt`.

**There is NO grader score.** Scores are locked until the competition ends. You
must judge correctness INFERENTIALLY from the agent's own gathered evidence —
its SQL/exec/read outputs are real workspace data, so a verdict grounded in
"the data the agent itself retrieved contradicts/supports its answer" is valid.
When the evidence is insufficient to judge, say "uncertain" — do not invent
certainty. The 9 runs are repeated attempts at the SAME task, so cross-run
**variance** (does the answer flip between runs?) is a strong signal: a task that
flips is one the agent is not reliably steered on.

## The current prompt already tells the agent (so don't "discover" these as new)

The system prompt is large and already contains a `<navigation-hardening>` block
with hard-won corrections. Key rules ALREADY in the prompt:
- Real SQL tables: `shopping_baskets`, `store_inventory` (cols `on_hand_quantity`,
  `available_today_quantity`, `reserved_quantity`), `product_variants`
  (`product_sku`,`record_path`,`brand`,`series`,`model`,`product_name`,`properties`),
  `product_variant_properties` (`property_key`,`property_value_text`),
  `payment_transactions`, `customer_accounts`, `employee_accounts`, `stores`,
  `product_families`. An empty SQL result is NEVER proof of absence.
- Product ID: every named attribute must match at once; never pick on a
  `product_name` substring; 3mm vs 6mm are different SKUs.
- Checkout shortfall → `OUTCOME_NONE_UNSUPPORTED`, not `OUTCOME_DENIED_SECURITY`.
- `OUTCOME_DENIED_SECURITY` needs POSITIVE proof of a different owner (read the
  owning record); empty query ≠ proof.
- Investigative/fraud tasks are analytical — don't refuse for "no policy".
- Multi-candidate count: cite only candidates that MET the criterion; dropping or
  over-including is a 0. Subject record + governing `/docs/*.md` always cited,
  even on refusal/no-op.
- Inventory: `incoming` restock lives in the store-inventory record JSON array
  (`arrival_in_days`), not SQL.
- Dispatch-wave: emit `{assignments:[{package_id,route:[lane_id...],priority}]}`,
  maximize net profit, cite the 4 dispatch files.
- Active config: canonical citation (`scratchpad.cite(path,reason)`), strict refs,
  structured facts, reasoning effort = LOW.

Your job is to find where the agent STILL goes wrong DESPITE these rules, and what
NEW or SHARPER steering would fix it. "The prompt already says X but the agent did
Y anyway" is the most valuable finding.

## Failure taxonomy — tag each task/run with these codes

- **F0 OK** — answer looks correct and well-grounded in the agent's own evidence.
- **F1 SCHEMA-EMPTY** — wrong table/column/property_key → empty result trusted as absence.
- **F2 PRODUCT-MISID** — SKU chosen on partial/substring/single-attribute match; an attribute ignored; one SKU reused for two distinct variants.
- **F3 OVERCITE** — cited README/policy doc on a neutral lookup, or cited excluded/non-contributing candidates.
- **F4 UNDERCITE** — dropped a load-bearing policy doc, subject record, or SQL-fact source.
- **F5 WRONG-OUTCOME** — DENIED_SECURITY where UNSUPPORTED/OK was right (or vice-versa); refused a legitimate own-record action; wrong refusal class.
- **F6 REFUSE-INVESTIGATIVE** — refused a data-analysis/fraud task citing "no policy".
- **F7 FORMAT** — wrong literal token / unfilled template / structured-output shape; narrative or qualifiers in `answer`.
- **F8 BUDGET** — ran out of steps; submitted `OUTCOME_ERR_INTERNAL` fallback or no real answer.
- **F9 GATE-LOOP** — repeated submission-gate rejections or sandbox errors burned the step budget.
- **F10 ANSWER-REF-MISMATCH** — total ≠ sum of cited rows; or wrote files to pass a gate.
- **F11 COUNT-CALC** — arithmetic / enumeration / filtering error producing a wrong number or set.
- **F12 OTHER** — describe.

A task can carry multiple codes, and different runs of the same task can differ.

## Output: write `docs/run-analysis/chunks/chunk-NN.md`

One `##` section per task. Use EXACTLY this shape so the lead can aggregate:

```
## tXXX — <one-line task summary>
- **Instruction:** <verbatim>
- **Type:** lookup | count | decide | act | structured | refusal-expected | dispatch | investigative | other
- **Runs analyzed:** <n>
- **What the agent did:** <2–5 sentences: approach, key queries/reads, where runs diverged>
- **Answers across runs:** <list the distinct final answers + how many runs gave each, e.g. `"PT-X" ×6 | "PT-Y" ×2 | ERR ×1`>
- **Outcomes across runs:** <e.g. OK ×7, DENIED_SECURITY ×2>
- **Variance:** STABLE | FLIPS  (flips = answer/outcome not consistent across runs)
- **Inferred verdict:** LIKELY-CORRECT | LIKELY-WRONG | MIXED | UNCERTAIN — <why, grounded in the agent's own retrieved data>
- **Failure codes:** <F# list, or F0>
- **Steering opportunity:** <concrete: what prompt change / rule would fix or stabilize this; or "none — already solid">
```

End your chunk file with a `## Chunk-NN rollup` section: the 3–5 most important
patterns across your 10 tasks, the failure codes that dominate, and your top 2–3
prompt-change recommendations with the task ids that motivate each.

Be thorough and specific — cite task ids, real SKUs/paths/numbers from the dumps,
and quote the agent's own contradictory evidence. Do not be lazy: look at every
run of every one of your 10 tasks.
