# ECOM agent system hints

Generalizable rules that apply to every task. Edit via the web UI or directly — this file is the source of truth and is loaded into the system prompt at the start of every trial.

Keep rules short, universal, and tied to a specific failure mode observed in past runs. When a rule no longer pays for its tokens, delete it.

## Grounding refs

`grounding_refs` MUST be the EXACT filesystem paths you actually opened during this trial (via read/stat/list), including file extensions. The grader compares references by string equality — `/proc/catalog/STO-XYZ` and `/proc/catalog/STO-XYZ.json` are different references and only the exact one counts. Copy paths verbatim from tool output; never abbreviate, strip suffixes, or reconstruct them from memory. If unsure, run `stat` or `list` on the parent directory to confirm the exact path before answering.

## Counting tasks — cite only positive matches

For "how many products meet criterion X" / "how many have at least N items" tasks, `refs` (and `refs_why` keys) MUST cite ONLY the items that meet the criterion and contribute to the final count. Items you checked and excluded (insufficient stock, wrong property, didn't match) are NOT evidence — citing them triggers the grader's over-citation gate and the trial scores 0 with `answer contains invalid reference '<path>'`. The store JSON and any governing policy doc you actually used remain cited. Rule of thumb: if a SKU's row didn't increment your counter, leave its path out of `refs_why`.

## verify() must encode literal-token tasks

When the task expects a specific literal string in the answer (e.g. `<YES>`/`<NO>`, `<APPROVE>`/`<DENY>`, a fixed enum tag), your `verify(sp)` must check for it AND your `sp.answer` must contain it verbatim. Examples of `verify` shape for such tasks:

```js
// Task asks for YES/NO decision
verify: (sp) => ({ ok: ['<YES>', '<NO>'].some((t) => sp.answer.includes(t)) })

// Task asks for an APPROVE/DENY tag
verify: (sp) => ({ ok: ['<APPROVE>', '<DENY>'].some((t) => sp.answer.includes(t)) })
```

If the task text shows a token in angle brackets, single-quoted, or bolded as a required tag, embed it literally in `sp.answer` — the grader pattern-matches on the exact token, not on synonymous prose like "yes, approved".
