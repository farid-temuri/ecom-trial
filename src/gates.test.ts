import { describe, expect, test } from "bun:test";
import type { Features } from "./config";
import type { GateContext } from "./gates";
import {
  assertVerifyIsFunction,
  validateStructuredFacts,
  deriveCanonicalRefs,
  assertRefsValid,
  assertCitingReasoning,
  assertOutcomeShape,
  runVerify,
  assertLiteralTokens,
  runSubmissionGates,
} from "./gates";
import type { Scratchpad } from "./types";

function feats(overrides: Partial<Features> = {}): Features {
  return {
    lazyMd: false,
    autoCite: false,
    strictRefs: false,
    citingReasoning: false,
    structuredFacts: false,
    refsWhyCanonical: false,
    debugRefProbe: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    features: feats(),
    readSet: new Set<string>(),
    openedPaths: new Set<string>(),
    ...overrides,
  };
}

describe("assertVerifyIsFunction", () => {
  test("passes for a function", () => {
    expect(() => assertVerifyIsFunction(() => true)).not.toThrow();
  });
  test("throws for a non-function", () => {
    expect(() => assertVerifyIsFunction(undefined)).toThrow(
      /requires a verify function/,
    );
  });
});

describe("validateStructuredFacts", () => {
  test("no-op when feature off", () => {
    const sp: Scratchpad = { facts: { x: { value: 1 } } };
    expect(() => validateStructuredFacts(sp, feats())).not.toThrow();
  });

  test("rejects non-object facts", () => {
    const sp: Scratchpad = { facts: [] };
    expect(() =>
      validateStructuredFacts(sp, feats({ structuredFacts: true })),
    ).toThrow(/scratchpad.facts must be an object/);
  });

  test("rejects a resolved slot with no source", () => {
    const sp: Scratchpad = {
      facts: { a: { value: 1, description: "the count", confidence: "verified" } },
    };
    expect(() =>
      validateStructuredFacts(sp, feats({ structuredFacts: true })),
    ).toThrow(/no workspace-path "source"/);
  });

  test("rejects a resolved slot with bad confidence", () => {
    const sp: Scratchpad = {
      facts: {
        a: { value: 1, description: "count", source: "/x.json", confidence: "pending" },
      },
    };
    expect(() =>
      validateStructuredFacts(sp, feats({ structuredFacts: true })),
    ).toThrow(/must be "verified" or "derived"/);
  });

  test("rejects a too-short description", () => {
    const sp: Scratchpad = { facts: { a: { value: null, description: "x" } } };
    expect(() =>
      validateStructuredFacts(sp, feats({ structuredFacts: true })),
    ).toThrow(/too-short "description"/);
  });

  test("legacy mode auto-merges resolved slot sources into refs", () => {
    const sp: Scratchpad = {
      refs: ["/already.json"],
      facts: {
        a: {
          value: 1,
          description: "the count",
          source: "/store.json",
          confidence: "verified",
        },
      },
    };
    validateStructuredFacts(sp, feats({ structuredFacts: true }));
    expect((sp.refs as string[]).sort()).toEqual(["/already.json", "/store.json"]);
  });

  test("canonical mode does NOT auto-merge sources into refs", () => {
    const sp: Scratchpad = {
      refs: ["/already.json"],
      facts: {
        a: {
          value: 1,
          description: "the count",
          source: "/store.json",
          confidence: "verified",
        },
      },
    };
    validateStructuredFacts(
      sp,
      feats({ structuredFacts: true, refsWhyCanonical: true }),
    );
    expect(sp.refs).toEqual(["/already.json"]);
  });

  test("tolerates pending slots with null value", () => {
    const sp: Scratchpad = {
      facts: { a: { value: null, description: "pending thing", confidence: "pending" } },
    };
    expect(() =>
      validateStructuredFacts(sp, feats({ structuredFacts: true })),
    ).not.toThrow();
  });
});

describe("deriveCanonicalRefs", () => {
  test("no-op when feature off", () => {
    const sp: Scratchpad = { refs_why: { bad: "x" } };
    expect(() => deriveCanonicalRefs(sp, feats())).not.toThrow();
  });

  test("derives refs from refs_why keys", () => {
    const sp: Scratchpad = {
      refs_why: { "/a.json": "inventory source row", "/b.md": "policy applied" },
    };
    deriveCanonicalRefs(sp, feats({ refsWhyCanonical: true }));
    expect((sp.refs as string[]).sort()).toEqual(["/a.json", "/b.md"]);
  });

  test("rejects non-path keys", () => {
    const sp: Scratchpad = { refs_why: { relative: "a valid reason here" } };
    expect(() =>
      deriveCanonicalRefs(sp, feats({ refsWhyCanonical: true })),
    ).toThrow(/Non-path keys/);
  });

  test("rejects reasons under 8 chars", () => {
    const sp: Scratchpad = { refs_why: { "/a.json": "short" } };
    expect(() =>
      deriveCanonicalRefs(sp, feats({ refsWhyCanonical: true })),
    ).toThrow(/Reasons missing or < 8 chars/);
  });

  test("rejects non-object refs_why", () => {
    const sp: Scratchpad = { refs_why: ["/a.json"] };
    expect(() =>
      deriveCanonicalRefs(sp, feats({ refsWhyCanonical: true })),
    ).toThrow(/must be an object/);
  });
});

describe("assertRefsValid", () => {
  test("passes when refs are within openedPaths (loose mode)", () => {
    const sp: Scratchpad = { refs: ["/a.json"] };
    const refs = assertRefsValid(sp, ctx({ openedPaths: new Set(["/a.json"]) }));
    expect(refs).toEqual(["/a.json"]);
  });

  test("strict mode requires refs in readSet, not just openedPaths", () => {
    const sp: Scratchpad = { refs: ["/a.json"] };
    expect(() =>
      assertRefsValid(
        sp,
        ctx({
          features: feats({ strictRefs: true }),
          openedPaths: new Set(["/a.json"]),
          readSet: new Set(),
        }),
      ),
    ).toThrow(/cite paths you never opened/);
  });

  test("strips URI fragments before the membership check", () => {
    const sp: Scratchpad = { refs: ["/a.json#row=2", "/b.json?q=x"] };
    const refs = assertRefsValid(
      sp,
      ctx({ openedPaths: new Set(["/a.json", "/b.json"]) }),
    );
    expect(refs).toEqual(["/a.json#row=2", "/b.json?q=x"]);
  });

  test("throws listing the offending refs", () => {
    const sp: Scratchpad = { refs: ["/missing.json"] };
    expect(() =>
      assertRefsValid(sp, ctx({ openedPaths: new Set(["/a.json"]) })),
    ).toThrow(/\/missing\.json/);
  });
});

describe("assertCitingReasoning", () => {
  test("no-op when feature off", () => {
    expect(() =>
      assertCitingReasoning({}, feats(), ["/a.json"]),
    ).not.toThrow();
  });

  test("no-op under canonical mode (handled by derive)", () => {
    expect(() =>
      assertCitingReasoning(
        {},
        feats({ citingReasoning: true, refsWhyCanonical: true }),
        ["/a.json"],
      ),
    ).not.toThrow();
  });

  test("rejects missing justification", () => {
    const sp: Scratchpad = { refs_why: {} };
    expect(() =>
      assertCitingReasoning(sp, feats({ citingReasoning: true }), ["/a.json"]),
    ).toThrow(/refs_why incomplete/);
  });

  test("rejects justification under 8 chars", () => {
    const sp: Scratchpad = { refs_why: { "/a.json": "short" } };
    expect(() =>
      assertCitingReasoning(sp, feats({ citingReasoning: true }), ["/a.json"]),
    ).toThrow(/too short/);
  });

  test("passes with adequate justifications", () => {
    const sp: Scratchpad = { refs_why: { "/a.json": "inventory source row" } };
    expect(() =>
      assertCitingReasoning(sp, feats({ citingReasoning: true }), ["/a.json"]),
    ).not.toThrow();
  });
});

describe("assertOutcomeShape", () => {
  test.each([
    "OUTCOME_OK",
    "OUTCOME_DENIED_SECURITY",
    "OUTCOME_NONE_CLARIFICATION",
    "OUTCOME_NONE_UNSUPPORTED",
    "OUTCOME_ERR_INTERNAL",
  ])("accepts %s", (name) => {
    expect(assertOutcomeShape({ outcome: name })).toBe(name as any);
  });

  test("rejects unknown outcome", () => {
    expect(() => assertOutcomeShape({ outcome: "OUTCOME_MAYBE" })).toThrow(
      /must be one of/,
    );
  });

  test("rejects missing outcome", () => {
    expect(() => assertOutcomeShape({})).toThrow(/must be one of/);
  });
});

describe("runVerify", () => {
  test("passes when verify returns true", async () => {
    await expect(runVerify({}, () => true)).resolves.toBeUndefined();
  });
  test("passes when verify returns {ok:true}", async () => {
    await expect(runVerify({}, () => ({ ok: true }))).resolves.toBeUndefined();
  });
  test("rejects when verify returns false", async () => {
    await expect(runVerify({}, () => false)).rejects.toThrow(
      /verify\(sp\) returned false/,
    );
  });
  test("rejects {ok:false} with its reason", async () => {
    await expect(
      runVerify({}, () => ({ ok: false, reason: "bad count" })),
    ).rejects.toThrow(/bad count/);
  });
  test("rejects undefined return", async () => {
    await expect(runVerify({}, (() => undefined) as any)).rejects.toThrow(
      /returned undefined/,
    );
  });
  test("rejects an unexpected shape", async () => {
    await expect(runVerify({}, (() => 42) as any)).rejects.toThrow(
      /unexpected shape/,
    );
  });
  test("captures a thrown verify", async () => {
    await expect(
      runVerify({}, () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow(/verify\(sp\) threw: kaboom/);
  });
  test("awaits async verify", async () => {
    await expect(
      runVerify({}, async () => ({ ok: true })),
    ).resolves.toBeUndefined();
  });
});

describe("assertLiteralTokens", () => {
  test("no-op when no tokens declared", () => {
    expect(() => assertLiteralTokens({ answer: "x" })).not.toThrow();
  });
  test("passes when all tokens present", () => {
    expect(() =>
      assertLiteralTokens({ literal_tokens: ["<YES>"], answer: "<YES> done" }),
    ).not.toThrow();
  });
  test("rejects a missing token", () => {
    expect(() =>
      assertLiteralTokens({ literal_tokens: ["<YES>", "<NO>"], answer: "<YES>" }),
    ).toThrow(/missing required literal token\(s\): "<NO>"/);
  });
});

describe("runSubmissionGates (integration of the pipeline)", () => {
  test("happy path returns outcome and refs", async () => {
    const sp: Scratchpad = {
      refs: ["/a.json"],
      outcome: "OUTCOME_OK",
      answer: "Total: 2",
    };
    const out = await runSubmissionGates(sp, () => ({ ok: true }), {
      features: feats(),
      readSet: new Set(["/a.json"]),
      openedPaths: new Set(["/a.json"]),
    });
    expect(out).toEqual({ outcome: "OUTCOME_OK", refs: ["/a.json"] });
  });

  test("canonical pipeline derives refs from refs_why", async () => {
    const sp: Scratchpad = {
      refs_why: { "/a.json": "inventory source row" },
      outcome: "OUTCOME_OK",
      answer: "Total: 1",
    };
    const out = await runSubmissionGates(sp, () => true, {
      features: feats({ refsWhyCanonical: true }),
      readSet: new Set(["/a.json"]),
      openedPaths: new Set(["/a.json"]),
    });
    expect(out.refs).toEqual(["/a.json"]);
  });

  test("stops at the first failing gate (verify before literal tokens)", async () => {
    const sp: Scratchpad = {
      refs: ["/a.json"],
      outcome: "OUTCOME_OK",
      literal_tokens: ["<YES>"],
      answer: "missing token",
    };
    // verify fails first, so the error is the verify message, not literal-token.
    await expect(
      runSubmissionGates(sp, () => ({ ok: false, reason: "nope" }), {
        features: feats(),
        readSet: new Set(["/a.json"]),
        openedPaths: new Set(["/a.json"]),
      }),
    ).rejects.toThrow(/rejected by verify/);
  });
});
