import { describe, expect, test } from "bun:test";
import {
  openrouterBackoffMs,
  isRetryableErr,
  extractResult,
  callOpenRouter,
  RetryableHttpError,
} from "./openrouter";
import type { OpenRouterConfig } from "./config";
import type { ChatMessage, LlmCallResult } from "./types";

const cfg: OpenRouterConfig = {
  url: "http://test",
  apiKey: "k",
  timeoutMs: 1000,
  maxAttempts: 3,
};
const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("openrouterBackoffMs", () => {
  test("exponential base with zero jitter", () => {
    const z = () => 0;
    expect(openrouterBackoffMs(1, z)).toBe(500);
    expect(openrouterBackoffMs(2, z)).toBe(1500);
    expect(openrouterBackoffMs(3, z)).toBe(4500);
  });
  test("adds bounded jitter", () => {
    expect(openrouterBackoffMs(1, () => 0.999)).toBe(500 + 299);
  });
});

describe("isRetryableErr", () => {
  test("RetryableHttpError is retryable", () => {
    expect(isRetryableErr(new RetryableHttpError(503, "x"))).toBe(true);
  });
  test("timeout message is retryable", () => {
    expect(isRetryableErr(new Error("OpenRouter timed out after 90000ms"))).toBe(
      true,
    );
  });
  test("TypeError (network) is retryable", () => {
    expect(isRetryableErr(new TypeError("fetch failed"))).toBe(true);
  });
  test("plain errors are not retryable", () => {
    expect(isRetryableErr(new Error("400 bad request"))).toBe(false);
    expect(isRetryableErr("nope")).toBe(false);
  });
});

describe("extractResult", () => {
  test("extracts content, reasoning, and token counts", () => {
    const r = extractResult({
      choices: [{ message: { content: "answer", reasoning: "because" } }],
      usage: {
        completion_tokens: 10,
        prompt_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    expect(r).toEqual({
      content: "answer",
      reasoning: "because",
      reasoningTokens: 5,
      completionTokens: 10,
      promptTokens: 20,
    });
  });

  test("omits empty reasoning", () => {
    const r = extractResult({ choices: [{ message: { content: "x", reasoning: "" } }] });
    expect(r.reasoning).toBeUndefined();
  });

  test("retryable on embedded 5xx error code", () => {
    expect(() => extractResult({ error: { message: "ISE", code: 500 } })).toThrow(
      RetryableHttpError,
    );
  });

  test("hard error on non-retryable embedded error", () => {
    expect(() => extractResult({ error: { message: "bad", code: 400 } })).toThrow(
      /error envelope/,
    );
  });

  test("retryable when content is missing", () => {
    expect(() => extractResult({ choices: [{ message: {} }] })).toThrow(
      RetryableHttpError,
    );
  });
});

describe("callOpenRouter retry loop", () => {
  test("retries retryable failures then succeeds", async () => {
    let calls = 0;
    const ok: LlmCallResult = { content: "ok" };
    const r = await callOpenRouter("m", msgs, "off", cfg, {
      sleepFn: async () => {},
      once: async () => {
        calls++;
        if (calls < 3) throw new RetryableHttpError(503, "x");
        return ok;
      },
    });
    expect(calls).toBe(3);
    expect(r).toBe(ok);
  });

  test("throws immediately on a non-retryable error", async () => {
    let calls = 0;
    await expect(
      callOpenRouter("m", msgs, "off", cfg, {
        sleepFn: async () => {},
        once: async () => {
          calls++;
          throw new Error("400 bad");
        },
      }),
    ).rejects.toThrow("400 bad");
    expect(calls).toBe(1);
  });

  test("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      callOpenRouter("m", msgs, "off", cfg, {
        sleepFn: async () => {},
        once: async () => {
          calls++;
          throw new RetryableHttpError(429, "rl");
        },
      }),
    ).rejects.toThrow(RetryableHttpError);
    expect(calls).toBe(3);
  });
});
