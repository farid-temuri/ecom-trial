# ecom-agent

A TypeScript / Bun agent that runs the [BitGN](https://bitgn.com) **ECOM** benchmark. It connects to the BitGN harness, runs each trial through an LLM (via [OpenRouter](https://openrouter.ai)) that drives a per-trial JavaScript sandbox, then submits the run and fetches scores.

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
# fill in OPENROUTER_API_KEY and BITGN_API_KEY
```

## Run

Full benchmark (runs every task where `tasksState.ts:enabled !== false`):

```sh
bun run start
```

A subset of tasks (positional task ids override the enabled filter):

```sh
bun run main.ts t13 t38
```

Live web UI: <http://localhost:3000> while a run is going (set `WEB_PORT=0` to disable).

When the run finishes you'll see per-task scores and a final percentage. Full event log is saved to `runs/<runId>.jsonl`.

### Signal handling

Hit `Ctrl-C` once and the run is force-submitted (in-flight trials forfeit, completed ones keep their scores). Hit it twice for a hard exit. The runId is printed so you can recover scores later:

```sh
bun run finalizeRun.ts <runId>   # read-only; pulls scores via getRun and updates tasksState.ts
```

`finalizeRun.ts` is also the right tool to inspect a still-running benchmark — it never submits, only reads.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required.** Used to call OpenRouter. |
| `BITGN_API_KEY` | — | **Required** for `bitgn/ecom1-dev`. |
| `MODEL_ID` | `z-ai/glm-5.1` | Any model id supported by OpenRouter. |
| `BENCH_ID` / `BENCHMARK_ID` | `bitgn/ecom1-dev` | Override the benchmark. |
| `BITGN_HOST` / `BENCHMARK_HOST` | `https://api.bitgn.com` | Override the harness endpoint. |
| `MAX_TASKS` | (no cap) | Stop after this many *enabled* tasks have run. Skipped tasks still get cleanly closed. |
| `CONCURRENCY` | `1` | Parallel trial slots. 3–5 is a good range; high values invite OpenRouter throttling. |
| `HINT` | — | Appended to the system prompt after `hints/system.md`. |
| `OPENROUTER_TIMEOUT_MS` | `90000` | Per-request timeout. Retried on 408/425/429/5xx with exponential backoff. |
| `SCORE_POLL_TIMEOUT_MS` | `300000` | Max time to poll `getRun` for deferred scores after submission. |
| `JUDGE_ENABLED` | `true` | Pre-submission LLM judge gate. Set `false` to skip. |
| `JUDGE_MODEL` | `MODEL_ID` | Model used for the judge. |
| `WEB_PORT` | `3000` | `0` to disable the web UI. |

## tasksState.ts

Per-task control file. Flip `enabled: false` to skip a task on the next run without losing its history. New tasks (e.g. when BitGN adds `t54`) default to `enabled: true` on first sight.

```ts
{
  t13: { enabled: true,  lastScore: 0,   lastRunAt: "...", runs: 3, sumScore: 0.5 },
  t34: { enabled: false, lastScore: 1,   lastRunAt: "...", runs: 1, sumScore: 1 },
}
```

`sumScore / runs` gives the true average across all runs (preserves partial credit from fraud tasks etc.). The writer updates this file in place after every scored trial.

## Project layout

- [main.ts](main.ts) — control plane: BitGN harness, run lifecycle, concurrency, score polling, signal handlers.
- [agent.ts](agent.ts) — per-trial reasoning loop: calls OpenRouter, executes the model's JS in a Bun sandbox against the ECOM runtime.
- [tasksState.ts](tasksState.ts) — per-task `enabled` flags and history.
- [tasksStateIO.ts](tasksStateIO.ts) — atomic load/update/persist for `tasksState.ts`.
- [finalizeRun.ts](finalizeRun.ts) — standalone script to fetch scores for a given runId (read-only).
- [web.ts](web.ts) — Bun HTTP server with the live UI.
- [events.ts](events.ts) — in-process event bus.
- [logs.ts](logs.ts) — writes `runs/<runId>.jsonl` and loads `hints/system.md`.
- [hints/system.md](hints/system.md) — extra system-prompt content loaded on every run.

## Troubleshooting

- **`OPENROUTER_API_KEY is required`** — set it in `.env`.
- **`OpenRouter 404: No endpoints available matching your guardrail restrictions`** — model not available on the pinned provider (see `provider` block in [agent.ts](agent.ts)). Either switch the provider, switch the model, or remove the pin.
- **`unauthenticated` from `startRun`** — set `BITGN_API_KEY`; `bitgn/ecom1-dev` requires it.
- **`run has unfinished trials`** — automatic backstop: the submitter retries with `force: true` and forfeits the orphans. Should not bubble to the user.
- **Score `not available` at trial end** — expected. Scoring is deferred; `batchFetchScores` polls `getRun` after submission.
- **`@buf/...` install fails** — make sure the `.npmrc` is present; it points the `@buf` scope at `https://buf.build/gen/npm/v1/`.

## License

See repository for license information.
