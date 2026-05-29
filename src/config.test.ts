import { describe, expect, test } from "bun:test";
import { loadConfig, parseBool, normalizeEffort } from "./config";

describe("parseBool", () => {
  test.each(["true", "TRUE", "1", "on", "ON", "yes", "Yes"])(
    "treats %p as true",
    (v) => {
      expect(parseBool(v)).toBe(true);
    },
  );

  test.each(["false", "0", "off", "no", "", "  ", undefined, "garbage"])(
    "treats %p as false",
    (v) => {
      expect(parseBool(v)).toBe(false);
    },
  );

  test("tolerates surrounding whitespace", () => {
    expect(parseBool("  true ")).toBe(true);
  });
});

describe("normalizeEffort", () => {
  test.each(["low", "medium", "high"] as const)("passes through %p", (v) => {
    expect(normalizeEffort(v, "medium")).toBe(v);
  });

  test.each(["off", "none", "false", "0"])("maps %p to off", (v) => {
    expect(normalizeEffort(v, "medium")).toBe("off");
  });

  test("is case-insensitive and trims", () => {
    expect(normalizeEffort("  HIGH ", "low")).toBe("high");
  });

  test("falls back on unrecognized input", () => {
    expect(normalizeEffort("weird", "high")).toBe("high");
    expect(normalizeEffort(undefined, "low")).toBe("low");
  });
});

describe("loadConfig", () => {
  test("defaults: all features off, medium effort, openrouter defaults", () => {
    const c = loadConfig({});
    expect(c.features).toEqual({
      lazyMd: false,
      autoCite: false,
      strictRefs: false,
      citingReasoning: false,
      structuredFacts: false,
      refsWhyCanonical: false,
      debugRefProbe: false,
    });
    expect(c.reasoningEffort).toBe("medium");
    expect(c.openrouter.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(c.openrouter.timeoutMs).toBe(90_000);
    expect(c.openrouter.maxAttempts).toBe(3);
    expect(c.openrouter.apiKey).toBe("");
  });

  test("reads canonical FEAT_* flag names", () => {
    const c = loadConfig({
      FEAT_LAZY_MD: "true",
      FEAT_AUTO_CITE: "1",
      FEAT_STRICT_REFS: "on",
      FEAT_CITING_REASONING: "yes",
      FEAT_STRUCTURED_FACTS: "true",
      FEAT_REFS_WHY_CANONICAL: "true",
      FEAT_DEBUG_REF_PROBE: "true",
    });
    expect(c.features).toEqual({
      lazyMd: true,
      autoCite: true,
      strictRefs: true,
      citingReasoning: true,
      structuredFacts: true,
      refsWhyCanonical: true,
      debugRefProbe: true,
    });
  });

  test("honors back-compat aliases CITING_REASONING / STRUCTURED_FACTS", () => {
    const c = loadConfig({
      CITING_REASONING: "true",
      STRUCTURED_FACTS: "true",
    });
    expect(c.features.citingReasoning).toBe(true);
    expect(c.features.structuredFacts).toBe(true);
  });

  test("canonical name wins over alias when both set", () => {
    const c = loadConfig({
      FEAT_CITING_REASONING: "true",
      CITING_REASONING: "false",
    });
    expect(c.features.citingReasoning).toBe(true);
  });

  test("reads reasoning effort and openrouter overrides", () => {
    const c = loadConfig({
      REASONING_EFFORT: "high",
      OPENROUTER_API_KEY: "sk-test",
      OPENROUTER_TIMEOUT_MS: "12345",
    });
    expect(c.reasoningEffort).toBe("high");
    expect(c.openrouter.apiKey).toBe("sk-test");
    expect(c.openrouter.timeoutMs).toBe(12_345);
  });

  test("ignores a non-numeric OPENROUTER_TIMEOUT_MS and keeps the default", () => {
    const c = loadConfig({ OPENROUTER_TIMEOUT_MS: "not-a-number" });
    expect(c.openrouter.timeoutMs).toBe(90_000);
  });
});
