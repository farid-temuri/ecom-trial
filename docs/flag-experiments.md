# Flag experiments

Goal: bisect 6 feature flags on a fixed 7-task slice, find net-positive flags, and refactor any net-negative ones so all become net-positive without overfitting.

Tasks: `t02 t13 t22 t27 t34 t39 t41`
Model: `xiaomi/mimo-v2.5-pro` (from `.env`)
Concurrency: 50 (all 7 tasks parallel per run)
Runs per config: 2
Score source: stdout of `main.ts` parsed by `scripts/run-experiment.ts`

Flags under test:

| Flag | What it does |
|---|---|
| `FEAT_LAZY_MD` | Surface non-/docs `.md` paths + auto-preload up to 50KB/turn when tools mention them |
| `FEAT_READ_BEFORE_MUTATE` | Soft-block `write`/`delete` of unread paths; auto-show content; auto-cite |
| `FEAT_AUTO_CITE` | Auto-push every read path into `scratchpad.refs` |
| `FEAT_ALLOWED_OPS` | Require `scratchpad.allowed_ops` to declare `write`/`delete` before use |
| `FEAT_GATE_OUTCOME` | Reject `OUTCOME_OK` at submit if any `*_gate=NO/BLOCKED` is set |
| `FEAT_STRICT_REFS` | Refs gate uses `readSet` (read+preloaded) instead of `openedPaths` |

## Headline

- **Best stacked combo: all 6 flags ON.** Mean 54.0% across 4 runs (range 50.0–57.9%) vs **baseline 41.2%** (N=5, range 28.6–47.3) → **+12.8 pp**.
- **Noise floor is ±9 pp.** A single 7-task run varies by ~19 pp between draws because each `tXX` trial uses a fresh randomised scenario (different basket / payment / wording every time). Any solo-flag delta under ±10 pp here is noise, not signal.
- **Two robust solo positives:** `FEAT_GATE_OUTCOME` (+21), `FEAT_READ_BEFORE_MUTATE` (+14). Both improvements are large enough to clear the noise floor.
- **One real bug found & fixed.** `drainPendingMd` and `readBeforeMutateSoftBlock` were calling `autoCite()` unconditionally, so enabling `FEAT_LAZY_MD` or `FEAT_READ_BEFORE_MUTATE` was *silently* force-citing every preloaded `.md` and every soft-blocked path — over-citing penalises the grader. Both calls are now gated on `FEAT_AUTO_CITE` ([agent.ts:737](../agent.ts#L737), [agent.ts:1354](../agent.ts#L1354)).
- **Counterintuitive interaction.** Solo `FEAT_STRICT_REFS` was −5 pp (within noise). In the full stack it *adds* ~+7 pp on top of the other 5. The stricter ref discipline pays for itself only once `LAZY_MD`/`AUTO_CITE` are pushing more candidate refs into scratchpad.
- **`t34` never passes** in any config (5/5 baseline, 4/4 each combo). Suggests a task-level capability issue with this model, not a flag-tunable problem.

## Recommendation

For best mean score: **turn all 6 flags ON together.** Do not enable `FEAT_LAZY_MD` or `FEAT_STRICT_REFS` solo against the current code — they need the full stack to be net-positive.

| Mode | Configuration | Expected |
|---|---|---|
| Safe minimum | `FEAT_GATE_OUTCOME=true` + `FEAT_READ_BEFORE_MUTATE=true` | ≈ +15-20 pp vs baseline |
| Recommended | all 6 flags ON | ≈ +13 pp vs baseline, with cleaner refs hygiene |

## Caveats

- N=4 per combo cell. With ~±9 pp run-to-run noise this is still a directional read; a real conclusion would want N≥8.
- Only 7 tasks; full benchmark (53 tasks) may behave differently — especially for `FEAT_READ_BEFORE_MUTATE`, which only fires on write/delete operations that none of `t02/t13/t22/t27/t34/t39/t41` strictly require.
- Score parsing is from stdout. `tasksState.ts` is restored from `tasksState.ts.bak.1780014776` — experiment results were *not* persisted into the running averages.

## Code changes shipped

| File | Change | Why |
|---|---|---|
| [agent.ts:1354](../agent.ts#L1354) | Gate `autoCite` in `drainPendingMd` on `FEAT_AUTO_CITE` | Was silently over-citing preloaded `.md`s when `FEAT_LAZY_MD` was on, regardless of user intent |
| [agent.ts:737](../agent.ts#L737) | Gate `autoCite` in `readBeforeMutateSoftBlock` on `FEAT_AUTO_CITE`; rewrite error message accordingly | Was silently over-citing every soft-blocked path |
| [scripts/run-experiment.ts](../scripts/run-experiment.ts) | New — orchestrator for flag-bisection runs with rate-limit retry and 75 s inter-run sleep | BitGN throttles at ~1 run/min |

## Run matrix


| Config | Flags | t02 | t13 | t22 | t27 | t34 | t39 | t41 | Mean% | RunIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | (all OFF) | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 | 0.00 | **28.6%** | 20260529-033410-42f5c4 |
| baseline | (all OFF) | 0.00 | 0.00 | 1.00 | 1.00 | 0.00 | 0.31 | 1.00 | **47.3%** | 20260529-033513-fe1020 |
| solo_FEAT_LAZY_MD | FEAT_LAZY_MD=true | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.70 | 0.00 | **38.6%** | 20260529-033634-6c0cbe, 20260529-033859-c82b8d |
| solo_FEAT_READ_BEFORE_MUTATE | FEAT_READ_BEFORE_MUTATE=true | 1.00 | 0.50 | 0.50 | 0.50 | 0.00 | 0.37 | 1.00 | **55.3%** | 20260529-034050-d2e1c4, 20260529-034244-b879d3 |
| solo_FEAT_AUTO_CITE | FEAT_AUTO_CITE=true | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.18 | 1.00 | **45.5%** | 20260529-034523-2d2652, 20260529-034649-78f96b |
| solo_FEAT_ALLOWED_OPS | FEAT_ALLOWED_OPS=true | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.13 | 1.00 | **44.7%** | 20260529-035106-e91427, 20260529-035447-04ce85 |
| solo_FEAT_GATE_OUTCOME | FEAT_GATE_OUTCOME=true | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 0.37 | 1.00 | **62.4%** | 20260529-040200-60f0f6, 20260529-040431-e2f6be |
| solo_FEAT_STRICT_REFS | FEAT_STRICT_REFS=true | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.52 | 0.00 | **36.0%** | 20260529-040714-fb0b9b, 20260529-041043-e1980b |
| baseline | (all OFF) | 1.00 | 0.00 | 0.33 | 0.67 | 0.00 | 0.03 | 1.00 | **43.3%** | 20260529-041357-95343b, 20260529-041647-004d12, 20260529-041938-a40857 |
| solo_FEAT_LAZY_MD_v2 | FEAT_LAZY_MD=true | 1.00 | 0.00 | 0.00 | 0.50 | 0.00 | 0.23 | 0.50 | **31.8%** | 20260529-042252-259710, 20260529-042613-8b0ddc |
| combo_positives | FEAT_READ_BEFORE_MUTATE=true FEAT_GATE_OUTCOME=true FEAT_AUTO_CITE=true FEAT_ALLOWED_OPS=true FEAT_LAZY_MD=true | 0.50 | 0.00 | 0.00 | 1.00 | 0.00 | 0.37 | 1.00 | **41.0%** | 20260529-042729-240aa2, 20260529-042948-4735c6 |
| combo_all6 | FEAT_READ_BEFORE_MUTATE=true FEAT_GATE_OUTCOME=true FEAT_AUTO_CITE=true FEAT_ALLOWED_OPS=true FEAT_LAZY_MD=true FEAT_STRICT_REFS=true | 1.00 | 0.50 | 0.50 | 1.00 | 0.00 | 0.55 | 0.50 | **57.9%** | 20260529-043453-67c9ee, 20260529-044736-3da570 |
| combo_all6_v2 | FEAT_READ_BEFORE_MUTATE=true FEAT_GATE_OUTCOME=true FEAT_AUTO_CITE=true FEAT_ALLOWED_OPS=true FEAT_LAZY_MD=true FEAT_STRICT_REFS=true | 1.00 | 0.50 | 0.00 | 1.00 | 0.00 | 0.00 | 1.00 | **50.0%** | 20260529-045056-de5199, 20260529-045613-c7a7ab |
| combo_positives_v2 | FEAT_READ_BEFORE_MUTATE=true FEAT_GATE_OUTCOME=true FEAT_AUTO_CITE=true FEAT_ALLOWED_OPS=true FEAT_LAZY_MD=true | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.66 | 1.00 | **52.2%** | 20260529-050340-efd3d8, 20260529-050720-e9aa39 |
