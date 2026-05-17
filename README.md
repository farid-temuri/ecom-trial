# ecom-agent

A TypeScript / Bun agent that runs the [BitGN](https://bitgn.com) **ECOM** benchmark. It connects to the BitGN harness, gets a list of tasks, and for each task lets an LLM (via [OpenRouter](https://openrouter.ai)) drive a small toolset (`tree`, `find`, `search`, `list`, `read`, `write`, `delete`, `stat`, `exec`) inside a per-trial sandbox until the task is reported complete.

A live web UI streams every step as the run progresses, and each run is also saved to `runs/<runId>.jsonl`.

## Requirements

- [Bun](https://bun.sh) `>= 1.1`
- An **OpenRouter** API key — <https://openrouter.ai/keys>
- A **BitGN** API key for the official benchmark — <https://bitgn.com>

## Setup

```sh
git clone <this-repo> ecom-agent
cd ecom-agent
bun install
cp .env.example .env
```

Edit `.env`:

```sh
OPENROUTER_API_KEY=sk-or-...      # required
BITGN_API_KEY=...                 # required for bitgn/ecom1-dev
MODEL_ID=z-ai/glm-5.1             # any OpenRouter model id; this is the default
MAX_TASKS=                        # optional: cap how many tasks to run
HINT=                             # optional: extra text appended to the system prompt
```

## Run

Full benchmark:

```sh
bun run start
```

A subset of tasks (positional task ids):

```sh
bun run main.ts t01 t04
```

While a run is going, open the live web UI at <http://localhost:3000> (set `WEB_PORT=0` in `.env` to disable it).

When the run finishes you'll see a per-task score table and a final percentage, and the full event log will be saved to `runs/<runId>.jsonl`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required.** Used to call OpenRouter. |
| `BITGN_API_KEY` | — | **Required** for `bitgn/ecom1-dev`. |
| `MODEL_ID` | `z-ai/glm-5.1` | Any model id supported by OpenRouter. |
| `BENCH_ID` / `BENCHMARK_ID` | `bitgn/ecom1-dev` | Override the benchmark. |
| `BITGN_HOST` / `BENCHMARK_HOST` | `https://api.bitgn.com` | Override the harness endpoint. |
| `MAX_TASKS` | (no cap) | Stop after this many tasks. |
| `HINT` | — | Appended to the system prompt after `hints/system.md`. |
| `WEB_PORT` | `3000` | `0` to disable the web UI. |

## Project layout

- [main.ts](main.ts) — control plane: connects to the BitGN harness, starts a run, iterates trials, submits the run.
- [agent.ts](agent.ts) — per-trial reasoning loop: calls OpenRouter, parses the JSON tool call, dispatches against the ECOM runtime.
- [web.ts](web.ts) — Bun HTTP server with the live UI.
- [events.ts](events.ts) — in-process event bus that connects the agent, logger and web UI.
- [logs.ts](logs.ts) — writes `runs/<runId>.jsonl` and loads `hints/system.md`.
- [hints/system.md](hints/system.md) — extra system-prompt content loaded on every run.

## Troubleshooting

- **`OPENROUTER_API_KEY is required`** — set it in `.env` (or export it before running).
- **`unauthenticated` from `startRun`** — set `BITGN_API_KEY` in `.env`; the public `bitgn/ecom1-dev` benchmark requires it.
- **`@buf/...` install fails** — make sure the `.npmrc` in the repo root is present; it points the `@buf` scope at `https://buf.build/gen/npm/v1/`.
- **Web UI port in use** — set `WEB_PORT` to another port, or `0` to disable.

## License

See repository for license information.
