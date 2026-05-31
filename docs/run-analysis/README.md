# Run analysis — t001–t100 competition set (2026-05-30)

Deep dive across the **9 most-recent score-disabled runs** of the new 100-task
competition set. Goal: find behavioural patterns and produce prompt changes that
make the agent more accurate.

## Hard constraint: no ground truth

Scores are **locked until the competition ends**. No grader verdict exists for
`t001`–`t100`. All correctness calls here are **inferential** — judged from what
the agent itself gathered (its SQL/exec/read outputs, reasoning, and final
answer), not from an answer key. Treat verdicts as hypotheses ranked by how
strongly the agent's own evidence supports them.

## The 9 runs

| label | runId | tasks covered |
|-------|-------|---------------|
| r1 | 20260530-114149-8fee0d | 100 |
| r2 | 20260530-114102-5ce0a8 | 100 |
| r3 | 20260530-114102-97e375 | 100 |
| r4 | 20260530-114102-65eb5b | 100 |
| r5 | 20260530-114102-161561 | 100 |
| r6 | 20260530-112557-d6c1e7 | 100 |
| r7 | 20260530-110611-0c35b3 | 100 |
| r8 | 20260530-113908-0aded5 | 87 (partial) |
| r9 | 20260530-113756-1e8a80 | 70 (partial) |

Every task has ≥7 of the 9 runs.

## Tooling

- `bun run scripts/dump-task.ts t001 [t002 ...]` — full per-task trace across all
  9 runs: instruction, every step's reasoning+code+output, final answer/refs/facts/outcome.

## Chunks

Tasks are split 10×10. Each chunk file holds the per-task analysis for its range.

- [chunks/chunk-01.md](chunks/chunk-01.md) — t001–t010
- [chunks/chunk-02.md](chunks/chunk-02.md) — t011–t020
- [chunks/chunk-03.md](chunks/chunk-03.md) — t021–t030
- [chunks/chunk-04.md](chunks/chunk-04.md) — t031–t040
- [chunks/chunk-05.md](chunks/chunk-05.md) — t041–t050
- [chunks/chunk-06.md](chunks/chunk-06.md) — t051–t060
- [chunks/chunk-07.md](chunks/chunk-07.md) — t061–t070
- [chunks/chunk-08.md](chunks/chunk-08.md) — t071–t080
- [chunks/chunk-09.md](chunks/chunk-09.md) — t081–t090
- [chunks/chunk-10.md](chunks/chunk-10.md) — t091–t100

## Synthesis

- [PATTERNS.md](PATTERNS.md) — cross-cutting failure/steering patterns (written after chunks land)
- [PROMPT-PROPOSAL.md](PROMPT-PROPOSAL.md) — proposed prompt block + rationale
