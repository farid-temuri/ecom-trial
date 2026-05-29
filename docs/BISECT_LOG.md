# Bisect log

Track each experimental run here. One row per run. Compare scores per-task to spot regressions.

## Format

```
## <runId>  —  <YYYY-MM-DD HH:MM>
flags: LAZY_MD=… READ_BEFORE_MUTATE=… AUTO_CITE=… ALLOWED_OPS=… GATE_OUTCOME=… STRICT_REFS=…
tasks: t02 t13 t22 t27 t34 t39 t41
scores: t02=… t13=… … (or finalPct=…)
notes: …
```

---

## Reference runs (pre-flag)

### f4bf2f — 2026-05-29 01:58 (baseline before any change)
flags: all off (no flags yet)
finalPct: 67.6
notes: baseline. failure buckets — inventory misread (t13–t16), addenda-blind 2-step deny (t24/t30/t34/t41), narrated completion (t22/t27/t41), fraud false-neg (t38–t40).

### 9f2733 — 2026-05-29 03:01 (all changes on, exec gated)
flags: equivalent to all FEAT_*=true, plus exec in MUTATION_OPS
finalPct: 0
notes: exec gate misfired on every step-1 `/bin/sql` call. cascade pushed steps 2 → 9, prose answers, grader rejected. fixed by removing exec from MUTATION_OPS.

### 1f68a4 — 2026-05-29 03:13 (all changes on, exec fixed)
flags: equivalent to all FEAT_*=true (exec free)
finalPct: 0
notes: even with exec free, still 0%. Triggered the move to flag-gated rollout.

---

## Bisect runs

<!-- add new entries below as you run each flag combination -->
