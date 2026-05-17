# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone **TypeScript / Bun** agent that runs the BitGN **ECOM** benchmark (`bitgn/ecom1-dev`). It is a TS port of the Python `ecom-py` sample — same control-plane shape, same Schema-Guided Reasoning (SGR) loop, but uses OpenRouter for inference and ships a small live web UI.

The whole project is the repo root — there is no nested sample directory.

## Common commands

Run from the repo root:

- `bun install` — install deps (uses `.npmrc` to pull `@buf/...` from the Buf npm registry)
- `bun run start` — run the full benchmark (`bun run main.ts`)
- `bun run main.ts t01 t04` — run only the listed task ids
- `bun run typecheck` — `tsc --noEmit`
- `bun run spike` — small connectivity smoke test ([spike.ts](spike.ts))

There is no test suite, linter, or formatter. The agent is validated by running it against the BitGN harness.

## Required environment

Copy `.env.example` to `.env` and fill in:

- `OPENROUTER_API_KEY` — **required**; used by [agent.ts](agent.ts) to call `https://openrouter.ai/api/v1/chat/completions`
- `BITGN_API_KEY` — **required** for `bitgn/ecom1-dev` (the official benchmark is authenticated)
- `MODEL_ID` — defaults to `z-ai/glm-5.1` (any OpenRouter model id works)
- `BENCH_ID` / `BENCHMARK_ID` — overrides the benchmark (default `bitgn/ecom1-dev`)
- `BITGN_HOST` / `BENCHMARK_HOST` — overrides `https://api.bitgn.com`
- `MAX_TASKS` — cap on tasks executed in a run
- `HINT` — extra text appended to the system prompt (after `hints/system.md`)
- `WEB_PORT` — port for the live web UI (default `3000`, set `0` to disable)

## Architecture

Two distinct Connect-RPC clients, mirroring the Python samples:

1. **Harness control plane** ([main.ts](main.ts)) — `HarnessService` against `api.bitgn.com`. Shape: `status → getBenchmark → startRun → for each trial: startTrial → runAgent(...) → endTrial → submitRun`.
2. **Per-trial runtime** ([agent.ts](agent.ts)) — `EcomRuntime` against the `harnessUrl` returned by each `startTrial`. Each trial gets a fresh URL — do not reuse across trials.

`main.ts` is benchmark-agnostic plumbing; task-solving logic lives entirely in `agent.ts`.

### SGR loop (`agent.ts`)

- A `NextStep` JSON shape with a `function: { tool: ... }` discriminated union covering every runtime command (`tree`, `find`, `search`, `list`, `read`, `write`, `delete`, `stat`, `exec`) plus the terminal `report_completion`.
- The model is called via OpenRouter with `response_format: { type: "json_object" }`; replies are parsed and validated against `KNOWN_TOOLS`.
- Only the **first** `plan_remaining_steps_brief` step is executed; the rest is throwaway scratchpad.
- A `dispatch()` function maps each tool name to the matching protobuf request + RPC.
- Loop exits on `report_completion`. Hard cap is **30 steps**.
- Bootstrap commands (`tree /`, `read /AGENTS.MD`, etc.) are prepended before the task prompt — keep this ordering; it matches the production benchmark expectations.

**When adding a new tool you must update three places in `agent.ts`:** the `Req*` type, the `Req` union + `KNOWN_TOOLS` set, and the `dispatch()` branch. Forgetting any of these silently breaks the loop.

### Response formatting

`agent.ts` deliberately formats protobuf responses into shell-shaped output (`tree`, `ls`, `cat -n`, `sed -n '...p'`, `rg -n`, `/bin/sql <<SQL`) before feeding them back to the model. Long catalogue/SQL traces stay legible and the model gets a clearer mental model than raw JSON dumps. If you add a new ECOM tool, add a matching formatter rather than letting it fall through to a generic JSON dump.

### Event bus, logs, web UI

- [events.ts](events.ts) — tiny in-process pub/sub (`bus.emit`, `bus.on`).
- [logs.ts](logs.ts) — writes every event for a run to `runs/<runId>.jsonl`; also loads `hints/system.md` (hashed) into the system prompt.
- [web.ts](web.ts) — Bun HTTP server (default `:3000`) that streams the bus to a live UI for watching tasks/steps in real time.

The `runs/` directory is gitignored and is the canonical record of a run.

### Proto / SDK

There is no vendored proto. TypeScript types and clients come from the Buf npm registry pin in [package.json](package.json): `@buf/bitgn_api.bufbuild_es` (messages) and the Connect clients from `@connectrpc/connect` + `@connectrpc/connect-node`. The [.npmrc](.npmrc) scopes `@buf` to `https://buf.build/gen/npm/v1/`. Regenerate the published SDK from `harness_core` (not this repo) after schema changes.

## Conventions

- Keep `main.ts` benchmark-agnostic and `agent.ts` task-logic-only — do not push task logic into the control plane or harness setup into the agent.
- The bootstrap prefix and 30-step cap are load-bearing for the ECOM benchmark; do not change without a deliberate reason.
- The `Req` union, `KNOWN_TOOLS` set, and `dispatch()` switch must stay aligned — they are the agent's tool surface and a drift between them shows up as silent parse failures or unhandled tools.
