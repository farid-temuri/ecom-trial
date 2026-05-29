import { describe, expect, test } from "bun:test";
import { errMsg } from "./util";

describe("errMsg", () => {
  test("uses Error.message for Error instances", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
  });

  test("preserves subclass messages", () => {
    class HttpError extends Error {}
    expect(errMsg(new HttpError("503 upstream"))).toBe("503 upstream");
  });

  test("stringifies non-Error values", () => {
    expect(errMsg("plain string")).toBe("plain string");
    expect(errMsg(42)).toBe("42");
    expect(errMsg(null)).toBe("null");
    expect(errMsg(undefined)).toBe("undefined");
  });
});
