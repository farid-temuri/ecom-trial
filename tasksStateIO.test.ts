import { describe, expect, test } from "bun:test";
import {
  defaultTaskState,
  updateTaskState,
  selectTasks,
  computeSummary,
} from "./tasksStateIO";
import type { TaskState } from "./tasksState";

// Characterization tests — lock the current behavior of tasksStateIO's pure
// functions before the refactor moves anything. NOTE: persistState/loadState
// are deliberately NOT exercised here — persistState writes the real
// tasksState.ts on disk; loadState reads the committed module.

describe("defaultTaskState", () => {
  test("a fresh task is enabled with no score history", () => {
    expect(defaultTaskState()).toEqual({
      enabled: true,
      lastScore: null,
      lastRunAt: null,
      runs: 0,
      sumScore: 0,
    });
  });
});

describe("updateTaskState", () => {
  test("first observation seeds runs=1 and accumulates score", () => {
    const state: Record<string, TaskState> = {};
    updateTaskState(state, "t01", 1, "2026-05-29T00:00:00.000Z");
    expect(state.t01).toEqual({
      enabled: true,
      lastScore: 1,
      lastRunAt: "2026-05-29T00:00:00.000Z",
      runs: 1,
      sumScore: 1,
    });
  });

  test("subsequent observations accumulate and keep enabled flag", () => {
    const state: Record<string, TaskState> = {
      t01: {
        enabled: false,
        lastScore: 1,
        lastRunAt: "old",
        runs: 1,
        sumScore: 1,
      },
    };
    updateTaskState(state, "t01", 0, "new");
    expect(state.t01).toEqual({
      enabled: false, // preserved
      lastScore: 0, // most recent
      lastRunAt: "new",
      runs: 2,
      sumScore: 1, // 1 + 0
    });
  });

  test("partial-credit scores accumulate exactly", () => {
    const state: Record<string, TaskState> = {};
    updateTaskState(state, "t01", 0.5, "a");
    updateTaskState(state, "t01", 0.25, "b");
    expect(state.t01!.runs).toBe(2);
    expect(state.t01!.sumScore).toBe(0.75);
  });
});

describe("selectTasks", () => {
  const state: Record<string, TaskState> = {
    t01: { enabled: true, lastScore: null, lastRunAt: null, runs: 0, sumScore: 0 },
    t02: { enabled: false, lastScore: null, lastRunAt: null, runs: 0, sumScore: 0 },
  };

  test("argv filter overrides the enabled flag entirely", () => {
    const { runIds, skippedDisabled } = selectTasks(
      ["t01", "t02", "t03"],
      new Set(["t02"]),
      state,
    );
    expect([...runIds]).toEqual(["t02"]);
    expect(skippedDisabled).toEqual([]);
  });

  test("without argv, disabled tasks are skipped and unknown tasks run", () => {
    const { runIds, skippedDisabled } = selectTasks(
      ["t01", "t02", "t99"],
      new Set(),
      state,
    );
    expect([...runIds].sort()).toEqual(["t01", "t99"]);
    expect(skippedDisabled).toEqual(["t02"]);
  });
});

describe("computeSummary", () => {
  const state: Record<string, TaskState> = {
    t10: { enabled: false, lastScore: 0.5, lastRunAt: "x", runs: 1, sumScore: 0.5 },
    t11: { enabled: false, lastScore: null, lastRunAt: null, runs: 0, sumScore: 0 },
  };

  test("executed average ignores skipped tasks", () => {
    const s = computeSummary([["t01", 1], ["t02", 0]], state, []);
    expect(s.executedCount).toBe(2);
    expect(s.executedPct).toBe(50);
  });

  test("total average folds in skipped tasks that have a lastScore", () => {
    const s = computeSummary([["t01", 1]], state, ["t10", "t11"]);
    // executed: t01=1; skipped-with-history: t10=0.5; t11 has null → excluded.
    expect(s.totalCount).toBe(2);
    expect(s.totalPct).toBeCloseTo(75, 5);
  });

  test("empty run yields zeros, not NaN", () => {
    const s = computeSummary([], {}, []);
    expect(s).toEqual({
      executedCount: 0,
      executedPct: 0,
      totalCount: 0,
      totalPct: 0,
    });
  });
});
