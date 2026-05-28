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

Submission gates: when the model calls `await harness.answer(scratchpad, verify)`, the harness runs (in order) refs validity → outcome shape → agent's `verify(sp)` → optional LLM judge. Each failure throws with a fix-it message so the model can retry. The hard step cap is **30 + 3 nudge** (configurable as constants in `agent.ts`).

If the loop exits without calling `harness.answer` (budget exhausted OR uncaught exception), a `try/finally` in `runAgent` submits `OUTCOME_ERR_INTERNAL` directly via `vm.answer` so the trial never returns no-answer.

### Score deferral

BitGN's grader runs asynchronously. `endTrial` usually returns `scoreAvailable: false`. The control plane:

1. Awaits every trial's `endTrial` in parallel (CONCURRENCY-bounded)
2. Calls `submitRun({ force: false })` — retries with `force: true` if BitGN reports unfinished trials (backstop)
3. `batchFetchScores` polls `getRun` with exponential backoff (3s → 15s, capped at `SCORE_POLL_TIMEOUT_MS` default 5min)
4. Updates `tasksState.ts` once with all landed scores

Standalone equivalent: `bun run finalizeRun.ts <runId>` does steps 3–4 only, read-only, against any past or in-flight run.

### Skipped trials

When `tasksState[id].enabled === false` (or `MAX_TASKS` cap is reached), the trial is still `startTrial`'d and `endTrial`'d — but the agent never runs. **This is load-bearing:** leaving trials open causes `submitRun` to reject the entire run. `tasksState` is not updated for skipped trials (preserves `lastScore`). BitGN will record the skipped trial as 0 on its side; we don't surface that locally.

### Signal handling

`SIGINT`/`SIGTERM` triggers a one-shot handler that calls `submitRun({ force: true })` and exits. The runId is logged so scores can be recovered with `finalizeRun.ts`. Second signal is a hard exit.

### Event bus, logs, web UI

- [events.ts](events.ts) — tiny in-process pub/sub (`bus.emit`, `bus.on`).
- [logs.ts](logs.ts) — writes every event to `runs/<runId>.jsonl`; loads `hints/system.md` (hashed) into the system prompt.
- [web.ts](web.ts) — Bun HTTP server (default `:3000`) streaming the bus to a live UI.

The `runs/` directory is gitignored and is the canonical record of a run.

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
