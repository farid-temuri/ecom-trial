// Central, injectable configuration for the agent runtime.
//
// Everything the agent loop needs to know about feature flags, reasoning
// effort, and the OpenRouter endpoint is derived here from an environment
// map. `loadConfig` takes the environment as a parameter (defaulting to
// `process.env`) so tests can construct any flag combination without mutating
// global state or juggling module import order.

export type ReasoningEffort = "low" | "medium" | "high" | "off";

export type Features = {
  /** Lazily preload *.md files surfaced by tool calls (FEAT_LAZY_MD). */
  lazyMd: boolean;
  /** Auto-push every read/written path into scratchpad.refs (FEAT_AUTO_CITE). */
  autoCite: boolean;
  /** Refs must be ⊆ readSet rather than openedPaths (FEAT_STRICT_REFS). */
  strictRefs: boolean;
  /** Require a refs_why justification per ref (FEAT_CITING_REASONING). */
  citingReasoning: boolean;
  /** Typed slot store at scratchpad.facts (FEAT_STRUCTURED_FACTS). */
  structuredFacts: boolean;
  /** refs_why is the source of truth; refs derived; autoCite disabled. */
  refsWhyCanonical: boolean;
  /** Run the diagnostic ref-alias probe on submission (FEAT_DEBUG_REF_PROBE). */
  debugRefProbe: boolean;
  /**
   * Append the navigation-hardening prompt block (FEAT_NAV_HINTS) — real SQL
   * schema, product-attribute matching, checkout outcome discipline, cite-what-
   * you-derived, and answer/cite consistency. Distilled from the 2026-05-30
   * run-failure analysis; A/B-gated so its grader impact can be measured.
   */
  navHints: boolean;
};

export type OpenRouterConfig = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
};

export type Config = {
  features: Features;
  reasoningEffort: ReasoningEffort;
  openrouter: OpenRouterConfig;
};

export type Env = Record<string, string | undefined>;

const TRUTHY = new Set(["true", "1", "on", "yes"]);

export function parseBool(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? "").trim().toLowerCase());
}

export function normalizeEffort(
  raw: string | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  if (v === "off" || v === "none" || v === "false" || v === "0") return "off";
  return fallback;
}

// Read the first env var that is actually set, in priority order. Lets a
// canonical FEAT_* name take precedence while a legacy alias still works.
function firstSet(env: Env, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined) return v;
  }
  return undefined;
}

function numberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const OPENROUTER_DEFAULT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
// 75s sits just above real model latency (p95 ≈ 48s for mimo) so a legitimately
// slow response still lands, while a stalled request is cut quickly. Combined
// with maxAttempts=2 and MAX_RECOVERY_REFUNDS (loop.ts), this bounds the worst
// case for a single hung task to a few minutes instead of ~18 (the t092 hang).
const OPENROUTER_DEFAULT_TIMEOUT_MS = 75_000;
const OPENROUTER_DEFAULT_MAX_ATTEMPTS = 2;

export function loadFeatures(env: Env): Features {
  return {
    lazyMd: parseBool(env.FEAT_LAZY_MD),
    autoCite: parseBool(env.FEAT_AUTO_CITE),
    strictRefs: parseBool(env.FEAT_STRICT_REFS),
    citingReasoning: parseBool(
      firstSet(env, "FEAT_CITING_REASONING", "CITING_REASONING"),
    ),
    structuredFacts: parseBool(
      firstSet(env, "FEAT_STRUCTURED_FACTS", "STRUCTURED_FACTS"),
    ),
    refsWhyCanonical: parseBool(env.FEAT_REFS_WHY_CANONICAL),
    debugRefProbe: parseBool(env.FEAT_DEBUG_REF_PROBE),
    navHints: parseBool(env.FEAT_NAV_HINTS),
  };
}

export function loadConfig(env: Env = process.env): Config {
  return {
    features: loadFeatures(env),
    reasoningEffort: normalizeEffort(env.REASONING_EFFORT, "medium"),
    openrouter: {
      url: env.OPENROUTER_URL ?? OPENROUTER_DEFAULT_URL,
      apiKey: env.OPENROUTER_API_KEY ?? "",
      timeoutMs: numberOr(
        env.OPENROUTER_TIMEOUT_MS,
        OPENROUTER_DEFAULT_TIMEOUT_MS,
      ),
      maxAttempts: numberOr(
        env.OPENROUTER_MAX_ATTEMPTS,
        OPENROUTER_DEFAULT_MAX_ATTEMPTS,
      ),
    },
  };
}
