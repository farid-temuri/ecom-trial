import { describe, expect, test } from "bun:test";
import {
  isTruncated,
  markTruncated,
  truncateForLog,
  collectMdPaths,
  collectMdFromList,
  queueNewMdPaths,
  treeToPlain,
  jsonish,
  formatTreeEntry,
  LOG_OUTPUT_CAP_BYTES,
} from "./format";

// A minimal tree entry stub. The proto type carries extra Message metadata we
// don't touch in these pure functions, so a structural cast is faithful.
const entry = (name: string, children: any[] = []): any => ({ name, children });

describe("isTruncated", () => {
  test("true when the truncated flag is set", () => {
    expect(isTruncated({ truncated: true })).toBe(true);
  });
  test("true when stderr carries the truncation warning (any case)", () => {
    expect(isTruncated({ stderr: "WARNING: Result Truncated at 100" })).toBe(
      true,
    );
  });
  test("false for clean output", () => {
    expect(isTruncated({ truncated: false, stderr: "" })).toBe(false);
    expect(isTruncated({})).toBe(false);
  });
});

describe("markTruncated", () => {
  test("appends a marker when truncated", () => {
    expect(markTruncated({ truncated: true }, "body", "use range")).toBe(
      "body\n[TRUNCATED: use range]",
    );
  });
  test("returns the body unchanged when not truncated", () => {
    expect(markTruncated({}, "body", "hint")).toBe("body");
  });
  test("emits a lone marker when body is empty but truncated", () => {
    expect(markTruncated({ truncated: true }, "", "hint")).toBe(
      "[TRUNCATED: hint]",
    );
  });
});

describe("truncateForLog", () => {
  test("returns short strings verbatim with their byte length", () => {
    expect(truncateForLog("héllo")).toEqual({ text: "héllo", bytes: 6 });
  });
  test("caps oversized strings and reports the original size", () => {
    const big = "a".repeat(LOG_OUTPUT_CAP_BYTES + 100);
    const { text, bytes } = truncateForLog(big);
    expect(bytes).toBe(LOG_OUTPUT_CAP_BYTES + 100);
    expect(text).toContain(`[TRUNCATED: original ${bytes} bytes]`);
    expect(text.startsWith("a".repeat(LOG_OUTPUT_CAP_BYTES))).toBe(true);
  });
});

describe("collectMdPaths", () => {
  test("walks the tree and normalizes slashes", () => {
    const root = entry("docs", [
      entry("a.md"),
      entry("sub", [entry("b.md"), entry("c.json")]),
    ]);
    expect(collectMdPaths(root, "/docs")).toEqual([
      "/docs/a.md",
      "/docs/sub/b.md",
    ]);
  });
  test("returns empty for undefined root", () => {
    expect(collectMdPaths(undefined, "/docs")).toEqual([]);
  });
});

describe("collectMdFromList", () => {
  test("keeps only .md names and joins onto the base path", () => {
    expect(
      collectMdFromList("/docs/", ["a.md", "b.json", "c.md"]),
    ).toEqual(["/docs/a.md", "/docs/c.md"]);
  });
});

describe("queueNewMdPaths", () => {
  test("adds unseen .md paths, skips preloaded and non-md", () => {
    const preloaded = new Set(["/docs/seen.md"]);
    const pending = new Set<string>();
    queueNewMdPaths(
      ["/docs/new.md", "/docs/seen.md", "/x.json"],
      preloaded,
      pending,
    );
    expect([...pending]).toEqual(["/docs/new.md"]);
  });
});

describe("treeToPlain", () => {
  test("maps to a plain nested {name, children} shape", () => {
    expect(treeToPlain(entry("r", [entry("a"), entry("b", [entry("c")])]))).toEqual(
      { name: "r", children: [{ name: "a", children: [] }, { name: "b", children: [{ name: "c", children: [] }] }] },
    );
  });
  test("returns an empty node for undefined", () => {
    expect(treeToPlain(undefined)).toEqual({ name: "", children: [] });
  });
});

describe("jsonish", () => {
  test("passes strings through", () => {
    expect(jsonish("hi")).toBe("hi");
  });
  test("renders null and undefined as words", () => {
    expect(jsonish(null)).toBe("null");
    expect(jsonish(undefined)).toBe("undefined");
  });
  test("stringifies bigint safely", () => {
    expect(jsonish({ n: 10n })).toContain('"n": "10"');
  });
  test("base64-encodes Uint8Array", () => {
    expect(jsonish(new Uint8Array([104, 105]))).toBe('"aGk="');
  });
  test("falls back to String() on circular structures", () => {
    const c: any = {};
    c.self = c;
    expect(jsonish(c)).toBe("[object Object]");
  });
});

describe("formatTreeEntry", () => {
  test("renders ascii branches", () => {
    const lines = formatTreeEntry(entry("root", [entry("a"), entry("b")]));
    expect(lines).toEqual(["`-- root", "    |-- a", "    `-- b"]);
  });
});
