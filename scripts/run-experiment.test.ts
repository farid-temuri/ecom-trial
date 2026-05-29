import { describe, expect, test } from "bun:test";
import { parseFlags, aggregate } from "./run-experiment";

describe("parseFlags", () => {
  test("empty string yields an empty object", () => {
    expect(parseFlags("")).toEqual({});
    expect(parseFlags("   ")).toEqual({});
  });
  test("parses comma-separated KEY=VAL pairs and trims", () => {
    expect(parseFlags("FEAT_LAZY_MD=true, FEAT_AUTO_CITE=1")).toEqual({
      FEAT_LAZY_MD: "true",
      FEAT_AUTO_CITE: "1",
    });
  });
  test("ignores malformed pairs with no value", () => {
    expect(parseFlags("A=1,BROKEN,B=2")).toEqual({ A: "1", B: "2" });
  });
});

describe("aggregate", () => {
  const TASKS = ["t02", "t13", "t22", "t27", "t34", "t39", "t41"];
  const full = (score: number) =>
    Object.fromEntries(TASKS.map((t) => [t, score]));

  test("averages each task across runs", () => {
    const results = [
      { scores: full(1) },
      { scores: full(0) },
    ] as any;
    const { perTaskAvg, meanPct } = aggregate(results);
    for (const t of TASKS) expect(perTaskAvg[t]).toBe(0.5);
    expect(meanPct).toBeCloseTo(50, 5);
  });

  test("missing task scores become NaN per-task and count as 0 in the mean", () => {
    const results = [{ scores: { t02: 1 } }] as any;
    const { perTaskAvg, meanPct } = aggregate(results);
    expect(perTaskAvg.t02).toBe(1);
    expect(Number.isNaN(perTaskAvg.t13!)).toBe(true);
    // only t02 contributes 1; the other 6 tasks are 0 → 1/7*100
    expect(meanPct).toBeCloseTo((1 / 7) * 100, 5);
  });
});
