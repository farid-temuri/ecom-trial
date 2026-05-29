import { describe, expect, test } from "bun:test";
import { stripJsonFences, parseNextStep } from "./parse";

describe("stripJsonFences", () => {
  test("returns trimmed content when there is no fence", () => {
    expect(stripJsonFences('  {"a":1}  ')).toBe('{"a":1}');
  });

  test("strips a ```json fence", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("strips a bare ``` fence", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("is case-insensitive on the language tag", () => {
    expect(stripJsonFences('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("leaves embedded backticks that aren't a wrapping fence alone", () => {
    expect(stripJsonFences('{"a":"```"}')).toBe('{"a":"```"}');
  });
});

describe("parseNextStep", () => {
  const valid = {
    current_state: "ok",
    plan_remaining_steps_brief: ["look"],
    task_completed: false,
    code: "scratchpad.x = 1;",
  };

  test("parses a valid next-step object", () => {
    expect(parseNextStep(JSON.stringify(valid))).toEqual(valid);
  });

  test("parses through a fence", () => {
    expect(parseNextStep("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(
      valid,
    );
  });

  test("rejects missing code", () => {
    const { code, ...noCode } = valid;
    expect(() => parseNextStep(JSON.stringify(noCode))).toThrow(
      /Invalid NextStep shape/,
    );
  });

  test("rejects non-string code", () => {
    expect(() =>
      parseNextStep(JSON.stringify({ ...valid, code: 123 })),
    ).toThrow(/Invalid NextStep shape/);
  });

  test("rejects empty plan array", () => {
    expect(() =>
      parseNextStep(JSON.stringify({ ...valid, plan_remaining_steps_brief: [] })),
    ).toThrow(/Invalid NextStep shape/);
  });

  test("rejects a non-array plan", () => {
    expect(() =>
      parseNextStep(
        JSON.stringify({ ...valid, plan_remaining_steps_brief: "look" }),
      ),
    ).toThrow(/Invalid NextStep shape/);
  });

  test("propagates JSON syntax errors", () => {
    expect(() => parseNextStep("{not json")).toThrow();
  });
});
