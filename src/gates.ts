// Submission gates — the deterministic checks that run inside harness.answer,
// in order, before the answer reaches the BitGN grader. Extracted from the
// former monolithic answer() closure into pure, individually-testable
// functions. Each gate throws an Error carrying a fix-it message (preserved
// verbatim) so the model can correct and retry; some gates mutate
// scratchpad.refs as part of their contract (auto-merge / canonical derive).

import type { Features } from "./config";
import {
  OUTCOME_NAMES,
  type OutcomeName,
  type Scratchpad,
  type VerifyFn,
} from "./types";

export type GateContext = {
  features: Features;
  readSet: Set<string>;
  openedPaths: Set<string>;
};

/** Coerce scratchpad.refs into a string[] (filtering non-strings). */
function refsAsStrings(sp: Scratchpad): string[] {
  return Array.isArray(sp.refs)
    ? (sp.refs as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
}

// Gate 1 — verify must be a function.
export function assertVerifyIsFunction(verify: unknown): void {
  if (typeof verify !== "function") {
    throw new Error(
      `harness.answer requires a verify function as the second argument.\nExample:\n  const verify = (sp) => {\n    if (!sp.answer.includes("<YES>")) return { ok: false, reason: "missing <YES>" };\n    return { ok: true };\n  };\n  await harness.answer(scratchpad, verify);\n\nverify(sp) runs deterministically at submission. Encode the constraints you discovered while reading the task.`,
    );
  }
}

// Gate 1b — STRUCTURED_FACTS slot validation. In legacy (non-canonical) mode,
// non-null slot sources are auto-merged into scratchpad.refs.
export function validateStructuredFacts(
  sp: Scratchpad,
  features: Features,
): void {
  if (!features.structuredFacts || sp.facts === undefined) return;
  const facts = sp.facts;
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    throw new Error(
      `harness.answer rejected — scratchpad.facts must be an object (slot name → {value, description, source, confidence}); got ${JSON.stringify(facts)}.`,
    );
  }
  const problems: string[] = [];
  const autoRefs: Array<{ path: string; factName: string }> = [];
  for (const [name, raw] of Object.entries(facts as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${name}: slot must be an object`);
      continue;
    }
    const slot = raw as {
      value?: unknown;
      description?: unknown;
      source?: unknown;
      confidence?: unknown;
    };
    if (
      typeof slot.description !== "string" ||
      slot.description.trim().length < 4
    ) {
      problems.push(
        `${name}: missing or too-short "description" (write what the slot represents)`,
      );
    }
    const hasValue = slot.value !== null && slot.value !== undefined;
    if (hasValue) {
      if (typeof slot.source !== "string" || !slot.source.startsWith("/")) {
        problems.push(
          `${name}: has a non-null value but no workspace-path "source" — every resolved slot must name the file that proved it`,
        );
      } else {
        autoRefs.push({ path: slot.source, factName: name });
      }
      if (slot.confidence !== "verified" && slot.confidence !== "derived") {
        problems.push(
          `${name}: has a value but confidence is "${String(slot.confidence)}" — must be "verified" or "derived"`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `harness.answer rejected — scratchpad.facts validation failed:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nFix the slots, then re-call harness.answer. Slots with value=null and confidence="pending" are tolerated (they signal unresolved questions).`,
    );
  }
  if (!features.refsWhyCanonical) {
    // Legacy mode: merge slot sources directly into refs (deduped).
    const refsList = Array.isArray(sp.refs) ? (sp.refs as unknown[]) : [];
    const merged = new Set<string>();
    for (const r of refsList) if (typeof r === "string") merged.add(r);
    for (const { path } of autoRefs) merged.add(path);
    sp.refs = [...merged];
  }
}

// Gate 1c — CANONICAL: derive scratchpad.refs from scratchpad.refs_why keys.
export function deriveCanonicalRefs(sp: Scratchpad, features: Features): void {
  if (!features.refsWhyCanonical) return;
  const why = sp.refs_why;
  if (
    why !== undefined &&
    (typeof why !== "object" || why === null || Array.isArray(why))
  ) {
    throw new Error(
      `harness.answer rejected — scratchpad.refs_why must be an object mapping each cited path to a one-line justification. Got: ${JSON.stringify(why)}.\n\nUse scratchpad.cite(path, reason) to add citations.`,
    );
  }
  const whyObj = (why ?? {}) as Record<string, unknown>;
  const derived: string[] = [];
  const badKeys: string[] = [];
  const badReasons: string[] = [];
  for (const [path, reason] of Object.entries(whyObj)) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      badKeys.push(JSON.stringify(path));
      continue;
    }
    if (typeof reason !== "string" || reason.trim().length < 8) {
      badReasons.push(path);
      continue;
    }
    derived.push(path);
  }
  if (badKeys.length > 0 || badReasons.length > 0) {
    const parts: string[] = [];
    if (badKeys.length > 0) {
      parts.push(
        `Non-path keys in refs_why (keys must be absolute workspace paths):\n` +
          badKeys.map((k) => `  - ${k}`).join("\n"),
      );
    }
    if (badReasons.length > 0) {
      parts.push(
        `Reasons missing or < 8 chars:\n` +
          badReasons.map((p) => `  - ${p}`).join("\n"),
      );
    }
    throw new Error(
      `harness.answer rejected — scratchpad.refs_why has invalid entries.\n\n` +
        parts.join("\n\n") +
        `\n\nFix by either calling scratchpad.cite(path, reason) with a real load-bearing reason, or removing the entry from scratchpad.refs_why.`,
    );
  }
  sp.refs = derived;
}

// Gate 2 — refs validity. Returns the validated refs (string[]). URI fragments
// (#row=X, ?q=...) are stripped before the membership check.
export function assertRefsValid(sp: Scratchpad, ctx: GateContext): string[] {
  const refs = refsAsStrings(sp);
  const allowedSet = ctx.features.strictRefs ? ctx.readSet : ctx.openedPaths;
  const allowedList = [...allowedSet].sort();
  const stripFragment = (r: string): string => r.replace(/[#?].*$/, "");
  const badRefs = refs.filter((r) => !allowedSet.has(stripFragment(r)));
  if (badRefs.length > 0) {
    throw new Error(
      `harness.answer rejected — grounding_refs cite paths you never opened in this trial:\n` +
        badRefs.map((r) => `  - ${r}`).join("\n") +
        `\n\nEach ref is your claim that the answer is grounded in that file. You must actually open it (harness.read/stat/list) and confirm it backs your answer BEFORE submitting. Skipping this means the grader will mark the trial 0 — these deterministic checks are weaker than the grader's, so passing this gate with hollow refs guarantees a wrong score, it doesn't earn you one.\n\n` +
        `Do NOT swap in unrelated opened paths (bootstrap docs, /AGENTS.MD, etc.) to silence this error. If the path you cited doesn't exist or isn't where the evidence actually lives, find the real source via harness.tree/find/list and cite that.\n\n` +
        `Paths opened so far (${allowedList.length}):\n` +
        allowedList.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return refs;
}

// Gate 2a — refs_why coverage (CITING_REASONING, non-canonical only).
export function assertCitingReasoning(
  sp: Scratchpad,
  features: Features,
  refs: string[],
): void {
  if (
    !features.citingReasoning ||
    features.refsWhyCanonical ||
    refs.length === 0
  ) {
    return;
  }
  const why = sp.refs_why;
  if (typeof why !== "object" || why === null || Array.isArray(why)) {
    throw new Error(
      `harness.answer rejected — CITING_REASONING is enabled, so scratchpad.refs_why must be an object mapping each cited path to a one-line justification.\n\n` +
        `Required shape:\n` +
        `  scratchpad.refs_why = {\n` +
        refs.map((r) => `    "${r}": "<why this file backs the answer>",`).join("\n") +
        `\n  };\n\n` +
        `Got: ${JSON.stringify(why) ?? "undefined"}`,
    );
  }
  const whyObj = why as Record<string, unknown>;
  const missing: string[] = [];
  const tooShort: string[] = [];
  for (const r of refs) {
    const v = whyObj[r];
    if (typeof v !== "string" || v.trim().length === 0) {
      missing.push(r);
    } else if (v.trim().length < 8) {
      tooShort.push(r);
    }
  }
  if (missing.length > 0 || tooShort.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `refs without a justification entry:\n` +
          missing.map((r) => `  - ${r}`).join("\n"),
      );
    }
    if (tooShort.length > 0) {
      parts.push(
        `justifications too short (< 8 chars — explain WHY this file backs the answer):\n` +
          tooShort.map((r) => `  - ${r}`).join("\n"),
      );
    }
    throw new Error(
      `harness.answer rejected — refs_why incomplete.\n\n` +
        parts.join("\n\n") +
        `\n\nIf a ref has no real justification, REMOVE it from scratchpad.refs. Do not invent reasons to keep over-cited paths.`,
    );
  }
}

// Gate 3 — outcome shape. Returns the validated OutcomeName.
export function assertOutcomeShape(sp: Scratchpad): OutcomeName {
  const outcomeName = sp.outcome;
  if (
    typeof outcomeName !== "string" ||
    !OUTCOME_NAMES.includes(outcomeName as OutcomeName)
  ) {
    throw new Error(
      `harness.answer rejected — scratchpad.outcome must be one of ${OUTCOME_NAMES.join(", ")}; got ${JSON.stringify(outcomeName)}`,
    );
  }
  return outcomeName as OutcomeName;
}

// Gate 4 — run the agent's own verify(sp), normalize the verdict, throw on fail.
export async function runVerify(
  sp: Scratchpad,
  verify: VerifyFn,
): Promise<void> {
  let verdict: { ok: boolean; reason?: string };
  try {
    const raw = await Promise.resolve(verify(sp));
    if (raw === undefined) {
      verdict = {
        ok: false,
        reason: "verify(sp) returned undefined — return true / {ok:true} explicitly",
      };
    } else if (typeof raw === "boolean") {
      verdict = { ok: raw, reason: raw ? undefined : "verify(sp) returned false" };
    } else if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { ok?: unknown }).ok === "boolean"
    ) {
      verdict = {
        ok: (raw as { ok: boolean }).ok,
        reason:
          typeof (raw as { reason?: unknown }).reason === "string"
            ? (raw as { reason: string }).reason
            : undefined,
      };
    } else {
      verdict = {
        ok: false,
        reason: `verify(sp) returned unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    verdict = { ok: false, reason: `verify(sp) threw: ${msg}` };
  }
  if (!verdict.ok) {
    const src = verify.toString().slice(0, 600);
    throw new Error(
      `harness.answer rejected by verify(sp): ${verdict.reason ?? "no reason"}\n\nYour verify body (first 600 chars):\n${src}\n\nFix scratchpad to satisfy verify, then retry harness.answer(scratchpad, verify).`,
    );
  }
}

// Gate 5 — literal-token presence in the answer (formerly validateAnswer).
export function assertLiteralTokens(sp: Scratchpad): void {
  const tokens = Array.isArray(sp.literal_tokens)
    ? (sp.literal_tokens as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : [];
  if (tokens.length === 0) return;
  const answer = typeof sp.answer === "string" ? sp.answer : "";
  const missing = tokens.filter((t) => !answer.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `harness.answer rejected — scratchpad.answer is missing required literal token(s): ${missing
        .map((t) => JSON.stringify(t))
        .join(", ")}.\n\n` +
        `You declared these in scratchpad.literal_tokens as required tags. Put each one verbatim in scratchpad.answer (the grader checks for their presence), then re-call \`await harness.answer(scratchpad, verify)\`.`,
    );
  }
}

export type GateOutput = { outcome: OutcomeName; refs: string[] };

// Run the full gate pipeline in order. Returns { outcome, refs } for the
// caller to forward to vm.answer. Throws (with a fix-it message) on the first
// failing gate.
export async function runSubmissionGates(
  sp: Scratchpad,
  verify: VerifyFn,
  ctx: GateContext,
): Promise<GateOutput> {
  assertVerifyIsFunction(verify);
  validateStructuredFacts(sp, ctx.features);
  deriveCanonicalRefs(sp, ctx.features);
  const refs = assertRefsValid(sp, ctx);
  assertCitingReasoning(sp, ctx.features, refs);
  const outcome = assertOutcomeShape(sp);
  await runVerify(sp, verify);
  assertLiteralTokens(sp);
  return { outcome, refs };
}
