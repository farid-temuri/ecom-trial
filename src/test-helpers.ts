// Test doubles shared by harness.test.ts and loop.test.ts. Imported only by
// tests — not part of the production runtime.
import type { Client } from "@connectrpc/connect";
import { EcomRuntime } from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import type { LlmClient } from "./openrouter";
import type { ChatMessage, LlmCallResult, NextStep } from "./types";

export type FakeVmCalls = {
  answer: Array<{ message: string; outcome: number; refs: string[] }>;
  read: Array<{ path: string }>;
  find: Array<{ name: string; root: string }>;
  write: Array<{ path: string; content: string }>;
};

export type FakeVmOptions = {
  // path -> content for reads; missing paths return "".
  files?: Record<string, string>;
  // basename -> on-disk paths returned by find (for canonical resolution).
  findPaths?: Record<string, string[]>;
};

export function makeFakeVm(opts: FakeVmOptions = {}): {
  vm: Client<typeof EcomRuntime>;
  calls: FakeVmCalls;
} {
  const calls: FakeVmCalls = { answer: [], read: [], find: [], write: [] };
  const files = opts.files ?? {};
  const findPaths = opts.findPaths ?? {};
  const vm = {
    async tree() {
      return { root: { name: "/", children: [] } };
    },
    async find(a: { name: string; root?: string }) {
      calls.find.push({ name: a.name, root: a.root ?? "/" });
      return { paths: findPaths[a.name] ?? [], truncated: false };
    },
    async search() {
      return { matches: [] };
    },
    async list() {
      return { entries: [] };
    },
    async read(a: { path: string }) {
      calls.read.push({ path: a.path });
      return { content: files[a.path] ?? "", truncated: false };
    },
    async write(a: { path: string; content: string }) {
      calls.write.push({ path: a.path, content: a.content });
      return {};
    },
    async delete() {
      return {};
    },
    async stat(a: { path: string }) {
      return { path: a.path, kind: 0, contentType: "", writable: true };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async answer(a: { message: string; outcome: number; refs: string[] }) {
      calls.answer.push({ message: a.message, outcome: a.outcome, refs: a.refs });
      return {};
    },
  };
  return { vm: vm as unknown as Client<typeof EcomRuntime>, calls };
}

// Build an LlmClient that returns the supplied code strings in order, one per
// call, wrapped as a valid NextStep. After the list is exhausted it repeats the
// last entry (useful for "model never answers" scenarios).
export function scriptedLlm(codes: string[]): {
  llm: LlmClient;
  callCount: () => number;
} {
  let i = 0;
  const llm: LlmClient = async (
    _model: string,
    _messages: ChatMessage[],
  ): Promise<LlmCallResult> => {
    const code = codes[Math.min(i, codes.length - 1)] ?? "";
    i++;
    const step: NextStep = {
      current_state: `step ${i}`,
      plan_remaining_steps_brief: ["work"],
      task_completed: false,
      code,
    };
    return { content: JSON.stringify(step) };
  };
  return { llm, callCount: () => i };
}
