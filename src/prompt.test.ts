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
    expect(SYSTEM_PROMPT_BASE.length).toBe(20_014);
    expect(h(SYSTEM_PROMPT_BASE)).toBe("0c5c24909f95e31b");
  });

  test("assembled prompt — no features", () => {
    expect(h(buildSystemPrompt({ features: f({}), ...EMPTY }))).toBe("5e385869d1ec62aa");
  });

  test("assembled prompt — structured facts", () => {
    expect(h(buildSystemPrompt({ features: f({ structuredFacts: true }), ...EMPTY }))).toBe(
      "9e4ee310ce3cfe39",
    );
  });

  test("assembled prompt — canonical citation", () => {
    expect(h(buildSystemPrompt({ features: f({ refsWhyCanonical: true }), ...EMPTY }))).toBe(
      "b1e6305275fe95a5",
    );
  });

  test("assembled prompt — citing reasoning", () => {
    expect(h(buildSystemPrompt({ features: f({ citingReasoning: true }), ...EMPTY }))).toBe(
      "629444be1a37495f",
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

  test("scratchpad is serialized into the prompt tail", () => {
    const p = buildSystemPrompt({
      features: f({}),
      ...EMPTY,
      scratchpad: { refs: ["/x.json"] },
    });
    expect(p).toContain('<scratchpad>');
    expect(p).toContain('"/x.json"');
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
