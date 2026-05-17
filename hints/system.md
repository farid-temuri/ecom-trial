# ECOM agent system hints

Generalizable rules that apply to every task. Edit via the web UI or directly — this file is the source of truth and is loaded into the system prompt at the start of every trial.

Keep rules short, universal, and tied to a specific failure mode observed in past runs. When a rule no longer pays for its tokens, delete it.

## Grounding refs

`grounding_refs` MUST be the EXACT filesystem paths you actually opened during this trial (via read/stat/list), including file extensions. The grader compares references by string equality — `/proc/catalog/STO-XYZ` and `/proc/catalog/STO-XYZ.json` are different references and only the exact one counts. Copy paths verbatim from tool output; never abbreviate, strip suffixes, or reconstruct them from memory. If unsure, run `stat` or `list` on the parent directory to confirm the exact path before answering.
