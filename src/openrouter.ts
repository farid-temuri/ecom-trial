import type { OpenRouterConfig, ReasoningEffort } from "./config";
import type { ChatMessage, LlmCallResult } from "./types";
import { errMsg, sleep } from "./util";

// A scripted-or-real next-call function. The agent loop depends on this seam
// so tests can drive it without touching the network.
export type LlmClient = (
  model: string,
  messages: ChatMessage[],
  effort: ReasoningEffort,
) => Promise<LlmCallResult>;

// Narrow view of the OpenRouter chat-completions response — only the fields we
// actually read. Replaces the former `data: any`.
type OpenRouterMessage = { content?: unknown; reasoning?: unknown };
type OpenRouterChoice = { message?: OpenRouterMessage };
type OpenRouterUsage = {
  completion_tokens?: number;
  prompt_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};
type OpenRouterResponse = {
  error?: { message?: string; code?: number };
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
};

export const OPENROUTER_RETRY_STATUSES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export class RetryableHttpError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`OpenRouter ${status}: ${body}`);
    this.name = "RetryableHttpError";
  }
}

export function openrouterBackoffMs(
  attempt: number,
  rand: () => number = Math.random,
): number {
  // 500ms, 1500ms, 4500ms (+ up to 300ms jitter)
  return 500 * 3 ** (attempt - 1) + Math.floor(rand() * 300);
}

export function isRetryableErr(err: unknown): boolean {
  if (err instanceof RetryableHttpError) return true;
  if (err instanceof Error) {
    if (err.message.includes("timed out after")) return true;
    // Network-level failures (fetch throws) — message varies by runtime
    if (err.name === "TypeError" || err.message.includes("fetch failed")) {
      return true;
    }
  }
  return false;
}

// Pure interpretation of a parsed 200-OK response body. Throws a
// RetryableHttpError for transient embedded failures, a plain Error for hard
// error envelopes, and otherwise extracts the result.
export function extractResult(data: OpenRouterResponse): LlmCallResult {
  // OpenRouter sometimes returns HTTP 200 with an embedded error envelope:
  //   { "error": { "message": "Internal Server Error", "code": 500 } }
  // Treat embedded 408/425/429/5xx as retryable.
  const embeddedCode = data.error?.code;
  if (
    typeof embeddedCode === "number" &&
    OPENROUTER_RETRY_STATUSES.has(embeddedCode)
  ) {
    throw new RetryableHttpError(embeddedCode, JSON.stringify(data.error));
  }
  if (data.error) {
    throw new Error(`OpenRouter error envelope: ${JSON.stringify(data.error)}`);
  }
  const msg = data.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content !== "string") {
    // No content + no error envelope is anomalous — likely an upstream blip;
    // give it a retry rather than ending the trial.
    throw new RetryableHttpError(
      0,
      `OpenRouter returned no content: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }
  const reasoning =
    typeof msg?.reasoning === "string" && msg.reasoning.length > 0
      ? msg.reasoning
      : undefined;
  const usage = data.usage ?? {};
  return {
    content,
    reasoning,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    completionTokens: usage.completion_tokens,
    promptTokens: usage.prompt_tokens,
  };
}

async function callOpenRouterOnce(
  model: string,
  messages: ChatMessage[],
  effort: ReasoningEffort,
  config: OpenRouterConfig,
): Promise<LlmCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res: Response;
  const body: Record<string, unknown> = {
    model,
    messages,
    response_format: { type: "json_object" },
  };
  if (effort !== "off") {
    body.reasoning = { effort };
  }
  try {
    res = await fetch(config.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`OpenRouter timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    if (OPENROUTER_RETRY_STATUSES.has(res.status)) {
      throw new RetryableHttpError(res.status, text);
    }
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }
  return extractResult((await res.json()) as OpenRouterResponse);
}

export type RetryDeps = {
  once?: (
    model: string,
    messages: ChatMessage[],
    effort: ReasoningEffort,
  ) => Promise<LlmCallResult>;
  sleepFn?: (ms: number) => Promise<void>;
  rand?: () => number;
  log?: (msg: string) => void;
};

export async function callOpenRouter(
  model: string,
  messages: ChatMessage[],
  effort: ReasoningEffort,
  config: OpenRouterConfig,
  deps: RetryDeps = {},
): Promise<LlmCallResult> {
  const once =
    deps.once ?? ((m, msgs, e) => callOpenRouterOnce(m, msgs, e, config));
  const sleepFn = deps.sleepFn ?? sleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await once(model, messages, effort);
    } catch (err) {
      lastErr = err;
      if (attempt >= config.maxAttempts || !isRetryableErr(err)) {
        throw err;
      }
      const delay = openrouterBackoffMs(attempt, deps.rand);
      deps.log?.(
        `OpenRouter attempt ${attempt}/${config.maxAttempts} failed (${errMsg(
          err,
        ).slice(0, 200)}); retrying in ${delay}ms`,
      );
      await sleepFn(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Build a config-bound client for the agent loop.
export function makeOpenRouterClient(
  config: OpenRouterConfig,
  defaultEffort: ReasoningEffort,
  log?: (msg: string) => void,
): LlmClient {
  return (model, messages, effort = defaultEffort) =>
    callOpenRouter(model, messages, effort, config, { log });
}
