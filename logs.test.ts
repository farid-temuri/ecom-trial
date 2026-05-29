import { describe, expect, test } from "bun:test";
import { makeRunId, loadHints } from "./logs";

// Characterization tests for the side-effect-free corners of logs.ts.
// listRuns/clusterFailures/readRun touch the real runs/ directory and are
// integration-flavored, so they're out of scope here.

describe("makeRunId", () => {
  test("formats as YYYYMMDD-HHMMSS-<6 hex> for an injected date", () => {
    const id = makeRunId(new Date(2026, 4, 29, 9, 7, 3)); // May=4, local time
    expect(id).toMatch(/^20260529-090703-[0-9a-f]{6}$/);
  });

  test("zero-pads month, day, and time components", () => {
    const id = makeRunId(new Date(2026, 0, 1, 0, 0, 0)); // Jan 1, midnight
    expect(id.startsWith("20260101-000000-")).toBe(true);
  });

  test("random suffix differs across calls for the same instant", () => {
    const now = new Date(2026, 4, 29, 12, 0, 0);
    const a = makeRunId(now);
    const b = makeRunId(now);
    expect(a.slice(0, 15)).toBe(b.slice(0, 15)); // same date-time prefix
    expect(a).not.toBe(b); // suffix random
  });
});

describe("loadHints", () => {
  test("returns text plus a truncated sha256 hash tag", () => {
    const { text, hash } = loadHints();
    expect(typeof text).toBe("string");
    expect(hash).toMatch(/^sha256:[0-9a-f]{16}$/);
  });
});
