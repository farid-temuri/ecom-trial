# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone **TypeScript / Bun** agent that runs the BitGN **ECOM** benchmark (`bitgn/ecom1-dev`). It uses OpenRouter for inference and ships a small live web UI.

The whole project is the repo root — there is no nested sample directory.

## Common commands

Run from the repo root:

- `bun install` — install deps (uses `.npmrc` to pull `@buf/...` from the Buf npm registry)
- `bun run start` — run the full benchmark (`bun run main.ts`)
- `bun run main.ts t13 t38` — run only the listed task ids (argv overrides `enabled`)
- `bun run typecheck` — `tsc --noEmit`
- `bun run spike` — small connectivity smoke test ([spike.ts](spike.ts))
- `bun run finalizeRun.ts <runId>` — read-only score fetch for a given run; updates `tasksState.ts`
- `bun run scripts/web.ts` — boot the web UI standalone (no trials) to browse past runs in `runs/`
- `bun run scripts/test-reasoning.ts <model> <effort>` — probe OpenRouter to confirm a model actually returns reasoning tokens
- `bun run scripts/run-experiment.ts <name> "<FLAG=val,...>" <N>` — flag-bisection orchestrator: runs the 7-task slice N times per config, aggregates per-task means into `docs/flag-experiments.md`, retries on BitGN rate-limit

There is no test suite, linter, or formatter. The agent is validated by running it against the BitGN harness.

## Required environment

Copy `.env.example` to `.env`. Required: `OPENROUTER_API_KEY`, `BITGN_API_KEY`. Everything else has a sensible default. See `.env.example` and the README env table.

## Architecture

Two Connect-RPC clients, mirroring the upstream Python sample:

1. **Harness control plane** ([main.ts](main.ts)) — `HarnessService` against `api.bitgn.com`. Shape per run: `status → getBenchmark → startRun → [for each trial: startTrial → runAgent → endTrial] → submitRun → batchFetchScores (poll getRun) → persist tasksState`.
2. **Per-trial runtime** ([agent.ts](agent.ts)) — `EcomRuntime` against the `harnessUrl` returned by each `startTrial`. Each trial gets a fresh URL — do not reuse across trials.

Keep `main.ts` benchmark-agnostic plumbing; task-solving logic lives entirely in `agent.ts`.

### Agent loop (`agent.ts`)

The model emits a single JSON object per turn:

```ts
{ current_state, plan_remaining_steps_brief, task_completed, code }
```

Only `code` is executed — it's JavaScript run in a Bun `AsyncFunction` sandbox with three injected locals:

- `harness` — async client exposing `tree/find/search/list/read/write/delete/stat/exec/answer/opened` against the ECOM runtime
- `scratchpad` — persistent JS object (mutate in place; binding is `const`)
- `console` — `.log/.error/.warn` captured and returned to the model next turn

Submission gates: when the model calls `await harness.answer(scratchpad, verify)`, the harness runs (in order):

1. `verify` is a function
2. **`STRUCTURED_FACTS` (if on):** validate `scratchpad.facts` slot shape. Under legacy refs mode, also auto-merge every non-null slot's `source` into `scratchpad.refs`; under `FEAT_REFS_WHY_CANONICAL` mode the auto-merge is disabled — model must explicitly call `scratchpad.cite(slot.source, reason)`.
3. **`FEAT_REFS_WHY_CANONICAL` (if on):** validate `scratchpad.refs_why` keys are absolute paths with ≥ 8-char reasons; derive `scratchpad.refs` from `Object.keys(refs_why)`.
4. Refs validity — every ref must be in `openedPaths` (or `readSet` under `FEAT_STRICT_REFS`). URI fragments (`path#row=X`, `path?q=…`) are stripped before this check.
5. `CITING_REASONING` (if on, non-canonical mode) — every ref needs a ≥ 8-char justification in `scratchpad.refs_why`.
6. Outcome shape (one of the five `OUTCOME_*` names).
7. Agent's `verify(sp)`.
8. Optional LLM judge (rules 1-4 always; rule 6 "load-bearing citations" under canonical mode, with governing-policy-doc + enumerated-candidate exemptions).

Each failure throws with a fix-it message so the model can retry. The hard step cap is **30 + 3 nudge** (configurable as constants in `agent.ts`). `SyntaxError` in the sandbox is refunded from the step budget (capped at 3 refunds/task). `requestNextStep` parse/OpenRouter failures emit a visible `step` event, refund the budget, and reprompt the model — capped at `MAX_RECOVERY_REFUNDS = 3`.

**Reasoning:** agent calls go out with OpenRouter `reasoning: { effort }` (default `medium`; `JUDGE_REASONING_EFFORT` defaults to `low`). When the model returns `message.reasoning`, it's captured per-step alongside token counts and persisted to `runs/<runId>.jsonl`. OpenRouter silently ignores `reasoning` on non-supporting models, so leaving it on is safe.

If the loop exits without calling `harness.answer` (budget exhausted OR uncaught exception), a `try/finally` in `runAgent` submits `OUTCOME_ERR_INTERNAL` directly via `vm.answer` so the trial never returns no-answer.

### Score deferral

BitGN's grader runs asynchronously. `endTrial` usually returns `scoreAvailable: false`. The control plane:

1. Awaits every trial's `endTrial` in parallel (CONCURRENCY-bounded)
2. Calls `submitRun({ force: false })` — retries with `force: true` if BitGN reports unfinished trials (backstop)
3. `batchFetchScores` polls `getRun` with exponential backoff (3s → 15s, capped at `SCORE_POLL_TIMEOUT_MS` default 5min)
4. For each scored trial, fetches `getTrial(trialId)` to pull `scoreDetail` (the grader's per-trial reasons like `answer missing required reference '/proc/catalog/X.json'`)
5. Updates `tasksState.ts` and emits a `trial:score` event per task so detail lands in `runs/<runId>.jsonl`

Standalone equivalent: `bun run finalizeRun.ts <runId>` does steps 3–5 only, read-only, against any past or in-flight run.

### Skipped trials

When `tasksState[id].enabled === false` (or `MAX_TASKS` cap is reached), the trial is still `startTrial`'d and `endTrial`'d — but the agent never runs. **This is load-bearing:** leaving trials open causes `submitRun` to reject the entire run. `tasksState` is not updated for skipped trials (preserves `lastScore`). BitGN will record the skipped trial as 0 on its side; we don't surface that locally.

### Signal handling

`SIGINT`/`SIGTERM` triggers a one-shot handler that calls `submitRun({ force: true })` and exits. The runId is logged so scores can be recovered with `finalizeRun.ts`. Second signal is a hard exit.

### Event bus, logs, web UI

- [events.ts](events.ts) — tiny in-process pub/sub (`bus.emit`, `bus.on`, `bus.replay`); typed `TrialEvent` union.
- [logs.ts](logs.ts) — writes every event to `runs/<runId>.jsonl`; loads `hints/system.md` (hashed) into the system prompt.
- [web.ts](web.ts) — Bun HTTP server (default `:3000`). **Refresh-only** UI — `/api/current` returns `bus.replay()` on demand; no SSE, no polling. Clicking ↻ Refresh pulls a fresh snapshot. The Runs tab lists past runs from `runs/*.jsonl` and replays any of them into the same view.

The `runs/` directory is gitignored and is the canonical record of a run.

#### What lives in `runs/<runId>.jsonl`

Every event is one JSONL line. Notable fields beyond the obvious ones:

- `run:start.envFlags` — every `FEAT_*`, `CITING_REASONING`, `STRUCTURED_FACTS`, `REASONING_EFFORT`, `JUDGE_REASONING_EFFORT`, `JUDGE_ENABLED`, `JUDGE_MODEL` value at run start. **Don't infer what was on from agent behaviour — read this.**
- `bootstrap` with `tool="system_prompt"` — the full system prompt (incl. workspace tree, preloaded `/docs`, hints, env-hint, scratchpad serialization) the model saw on turn 1.
- `bootstrap` with `tool="initial_scratchpad"` — the prepopulated scratchpad (`{refs: [], ...}` plus `facts: {}` or `refs_why: {}` depending on flags).
- `step` — per-turn: `code`, `output`, `reasoning` (full text from `message.reasoning`), `reasoningTokens`, `completionTokens`, `promptTokens`, `scratchpadAfter` (deep snapshot after the script ran).
- `trial:score` — `score` + `scoreDetail` (the grader's reasons).

These are the canonical answer to "what did the model see, what did it think, what did it write, what did the grader complain about?" — no guessing, no inference from intent.

### tasksState

- [tasksState.ts](tasksState.ts) — typed `Record<string, TaskState>` with `{ enabled, lastScore, lastRunAt, runs, sumScore }`.
- [tasksStateIO.ts](tasksStateIO.ts) — `loadState` (deep copy on import), `updateTaskState`, `persistState` (atomic tmp→rename, serialized through a promise chain to avoid concurrent-trial races).
- New tasks default to `enabled: true` when first seen.
- `sumScore / runs` is the honest average across runs (preserves partial credit). `lastScore` is the most recent observation.

### Proto / SDK

No vendored proto. TypeScript types and clients come from the Buf npm registry pin in [package.json](package.json): `@buf/bitgn_api.bufbuild_es` (messages) and the Connect clients from `@connectrpc/connect` + `@connectrpc/connect-node`. The [.npmrc](.npmrc) scopes `@buf` to `https://buf.build/gen/npm/v1/`. Regenerate the published SDK from `harness_core` (not this repo) after schema changes.

## Conventions

- Keep `main.ts` benchmark-agnostic and `agent.ts` task-logic-only — do not push task logic into the control plane or harness setup into the agent.
- The 30-step cap, no-answer fallback, and skipped-trial closure are load-bearing for the ECOM benchmark — do not change without a deliberate reason.
- Never call `submitRun({ force: true })` while trials are still legitimately running. `force: true` kills in-flight trials and grades them 0. It is the right call only on Ctrl-C, on the backstop retry after `force: false` is refused, or on a confirmed-stuck trial.
- `tasksState.ts` is the source of truth for which tasks to run. Manual edits to `enabled` are safe between runs and won't be clobbered by the writer.
