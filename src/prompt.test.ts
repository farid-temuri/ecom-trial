import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { SYSTEM_PROMPT_BASE, buildSystemPrompt } from "./prompt";
import type { Features } from "./config";

// Snapshot lock for the system prompt. The prompt content is *behavior* for the
// model — these hashes were verified byte-for-byte against the working-tree
// agent.ts (and the assembled prompt logged in runs/*.jsonl). If you edit the
// prompt intentionally, update the expected hash here in the same commit so the
// change is explicit and reviewable. An accidental edit fails loudly.
const h = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

function f(o: Partial<Features>): Features {
  return {
    lazyMd: false,
    autoCite: false,
    strictRefs: false,
    citingReasoning: false,
    structuredFacts: false,
    refsWhyCanonical: false,
    debugRefProbe: false,
    navHints: false,
    ...o,
  };
}

const EMPTY = {
  agentsMd: "",
  workspaceTree: "",
  workspaceDocs: "",
  workspaceMdIndex: [],
  dynamicDocs: [],
  mdBudgetSkipped: [],
  scratchpad: {},
  hints: "",
  envHint: "",
  lazyMdBudgetBytes: 50_000,
};

describe("system prompt snapshot lock", () => {
  test("base prose is unchanged", () => {
    expect(SYSTEM_PROMPT_BASE.length).toBe(22_253);
    expect(h(SYSTEM_PROMPT_BASE)).toBe("f34ffca9338f4318");
  });

  test("assembled prompt — no features", () => {
    expect(h(buildSystemPrompt({ features: f({}), ...EMPTY }))).toBe("6632ffe40541fc08");
  });

  test("assembled prompt — structured facts", () => {
    expect(h(buildSystemPrompt({ features: f({ structuredFacts: true }), ...EMPTY }))).toBe(
      "fcedb2f01a8c15fc",
    );
  });

  test("assembled prompt — canonical citation", () => {
    expect(h(buildSystemPrompt({ features: f({ refsWhyCanonical: true }), ...EMPTY }))).toBe(
      "fa5d318da1935ec6",
    );
  });

  test("assembled prompt — citing reasoning", () => {
    expect(h(buildSystemPrompt({ features: f({ citingReasoning: true }), ...EMPTY }))).toBe(
      "42e7d575d947d68b",
    );
  });

  test("assembled prompt — nav hints", () => {
    expect(h(buildSystemPrompt({ features: f({ navHints: true }), ...EMPTY }))).toBe(
      "f025f8fb89612aed",
    );
  });
});

describe("buildSystemPrompt structure", () => {
  test("canonical wins over citing-reasoning when both set", () => {
    const both = buildSystemPrompt({
      features: f({ refsWhyCanonical: true, citingReasoning: true }),
      ...EMPTY,
    });
    expect(both).toContain("<citation-protocol-canonical>");
    expect(both).not.toContain("<refs-reasoning-required>\nFor EVERY entry");
  });

  test("nav-hints block is gated on the FEAT_NAV_HINTS flag", () => {
    const off = buildSystemPrompt({ features: f({}), ...EMPTY });
    const on = buildSystemPrompt({ features: f({ navHints: true }), ...EMPTY });
    expect(off).not.toContain("<navigation-hardening>");
    expect(on).toContain("<navigation-hardening>");
    // Flag-off output must be byte-identical to the locked no-features prompt.
    expect(off).toBe(buildSystemPrompt({ features: f({}), ...EMPTY }));
  });

  test("nav-hints block carries the load-bearing corrections", () => {
    const on = buildSystemPrompt({ features: f({ navHints: true }), ...EMPTY });
    // The decisive 2026-05-30 finding: this VM has no working SQL — go filesystem-first.
    expect(on).toContain("THIS ENVIRONMENT HAS NO WORKING SQL");
    expect(on).toContain("/proc/carts/<customer_id>/basket-XXXX.json");
    // Empty-result discipline (the dominant root cause).
    expect(on).toContain("is NEVER proof a record is absent");
    // Identity id format + outcome discipline + anti-refusal.
    expect(on).toContain("Customer ids use a HYPHEN");
    expect(on).toContain("employees may not purchase");
    expect(on).toContain("POSITIVELY read a record whose owner differs");
  });

  // Regression guards for the 2026-05-30 filesystem-first rewrite. These lock the
  // intent of the gate-loop, format, discount-doc, dispatch, and inventory fixes
  // surfaced by the 9-run / 100-task analysis so a future rewrite can't silently
  // undo them.
  test("nav-hints block carries the gate-loop + format corrections", () => {
    const on = buildSystemPrompt({ features: f({ navHints: true }), ...EMPTY });
    // P3 — single decision token, unsourced derived facts, #row= base cite.
    expect(on).toContain("declare ONLY the token you actually chose");
    expect(on).toContain("Facts slots with no source file stay unsourced");
    expect(on).toContain("cite the BASE path (the gate strips the fragment)");
    // P6 — discount caps come from the doc, never from memory.
    expect(on).toContain("never recall from memory");
    // Dispatch route is lane_ids + net-profit objective; incoming lives in record JSON.
    expect(on).toContain("ordered list of `lane_id` strings");
    expect(on).toContain("MAXIMIZE expected net profit");
    expect(on).toContain("`incoming` array `[{ quantity, arrival_in_days }]`");
  });

  test("scratchpad is serialized into the prompt tail", () => {
    const p = buildSystemPrompt({
      features: f({}),
      ...EMPTY,
      scratchpad: { refs: ["/x.json"] },
    });
    expect(p).toContain('<scratchpad>');
    expect(p).toContain('"/x.json"');
  });

  // Regression guards for the 2026-05-30 run-investigation fixes. These lock the
  // *intent* of three prompt edits so a future rewrite can't silently undo them.
  test("count tasks: cite only criterion-passing candidates (no over-citation)", () => {
    // The former wording told the model to cite EVERY enumerated candidate
    // "including ones below threshold" / "even excluded ones" — that directly
    // caused t15's invalid-reference 0. Both wordings must be gone.
    expect(SYSTEM_PROMPT_BASE).not.toContain("including ones below threshold");
    expect(SYSTEM_PROMPT_BASE).not.toContain("EVERY enumerated candidate (even excluded ones");
    expect(SYSTEM_PROMPT_BASE).toContain("DROP every candidate path whose row did not contribute");
  });

  test("SQL-discovered paths must be read before they are cited", () => {
    expect(SYSTEM_PROMPT_BASE).toContain("SQL gives you paths, not citations");
    expect(SYSTEM_PROMPT_BASE).toContain("a path you learned only from SQL output");
  });

  test("fixed-value formats use a self-tested regex, not literal_tokens", () => {
    expect(SYSTEM_PROMPT_BASE).toContain("prefer a self-tested regex over `literal_tokens`");
    expect(SYSTEM_PROMPT_BASE).toContain("FORMAT regex accepts the bare template");
  });

  test("optional sections are omitted when their inputs are empty", () => {
    const p = buildSystemPrompt({ features: f({}), ...EMPTY });
    // The base prose references `<workspace-tree>` in backticks, so assert on
    // the actual section *wrappers* the builder emits, not the bare tag.
    expect(p).not.toContain('<runtime-conventions src="/AGENTS.MD">');
    expect(p).not.toContain("<workspace-docs-extra>");
    expect(p).not.toContain("<workspace-md-budget-exceeded>");
  });
});
