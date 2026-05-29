// Shared types for the agent runtime. Kept dependency-free (only the buf SDK
// proto types) so every other module can import from here without cycles.
import {
  Outcome,
  type FindResponse,
  type StatResponse,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";

export type Scratchpad = Record<string, unknown>;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// The single JSON object the model emits each turn.
export type NextStep = {
  current_state: string;
  plan_remaining_steps_brief: string[];
  task_completed: boolean;
  code: string;
};

export const OUTCOME_NAMES = [
  "OUTCOME_OK",
  "OUTCOME_DENIED_SECURITY",
  "OUTCOME_NONE_CLARIFICATION",
  "OUTCOME_NONE_UNSUPPORTED",
  "OUTCOME_ERR_INTERNAL",
] as const;

export type OutcomeName = (typeof OUTCOME_NAMES)[number];

export const OUTCOME_BY_NAME: Record<OutcomeName, Outcome> = {
  OUTCOME_OK: Outcome.OK,
  OUTCOME_DENIED_SECURITY: Outcome.DENIED_SECURITY,
  OUTCOME_NONE_CLARIFICATION: Outcome.NONE_CLARIFICATION,
  OUTCOME_NONE_UNSUPPORTED: Outcome.NONE_UNSUPPORTED,
  OUTCOME_ERR_INTERNAL: Outcome.ERR_INTERNAL,
};

// Internal request-shape helpers, used only to render bootstrap log entries
// (tree/read) in a familiar CLI form.
export type ReqTree = { tool: "tree"; level?: number; root?: string };
export type ReqRead = {
  tool: "read";
  path: string;
  number?: boolean;
  start_line?: number;
  end_line?: number;
};

export type VerifyResult = boolean | { ok: boolean; reason?: string } | void;
export type VerifyFn = (
  sp: Scratchpad,
) => VerifyResult | Promise<VerifyResult>;

export type TreeNodeOut = { name: string; children: TreeNodeOut[] };

export type LlmCallResult = {
  content: string;
  reasoning?: string;
  reasoningTokens?: number;
  completionTokens?: number;
  promptTokens?: number;
};

// The async client injected into the sandbox as `harness`.
export type ScriptHarness = {
  tree(args?: { root?: string; level?: number }): Promise<TreeNodeOut>;
  find(args: {
    name: string;
    root?: string;
    kind?: "all" | "files" | "dirs";
    limit?: number;
  }): Promise<FindResponse>;
  search(args: {
    pattern: string;
    root?: string;
    limit?: number;
  }): Promise<{
    matches: Array<{ path: string; line: number; lineText: string }>;
  }>;
  list(args?: {
    path?: string;
  }): Promise<{ entries: Array<{ name: string; isDir: boolean }> }>;
  read(args: {
    path: string;
    start_line?: number;
    end_line?: number;
    number?: boolean;
  }): Promise<{ content: string; truncated: boolean }>;
  write(args: { path: string; content: string }): Promise<void>;
  delete(args: { path: string }): Promise<void>;
  stat(args: { path: string }): Promise<StatResponse>;
  exec(args: {
    path: string;
    args?: string[];
    stdin?: string;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  answer(scratchpad: Scratchpad, verify: VerifyFn): Promise<void>;
  opened(): string[];
};

export type ScriptOutcome = {
  output: string;
  error?: string;
  answered: boolean;
};
