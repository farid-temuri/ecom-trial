import { ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { bus } from "./events";
import { loadHints } from "./logs";
import {
  EcomRuntime,
  NodeKind,
  Outcome,
  type ListResponse,
  type ListResponse_Entry,
  type ReadResponse,
  type SearchResponse,
  type ExecResponse,
  type TreeResponse,
  type TreeResponse_Entry,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";

type ReportCompletion = {
  tool: "report_completion";
  completed_steps_laconic: string[];
  message: string;
  grounding_refs: string[];
  outcome:
    | "OUTCOME_OK"
    | "OUTCOME_DENIED_SECURITY"
    | "OUTCOME_NONE_CLARIFICATION"
    | "OUTCOME_NONE_UNSUPPORTED"
    | "OUTCOME_ERR_INTERNAL";
};
type ReqTree = { tool: "tree"; level?: number; root?: string };
type ReqFind = {
  tool: "find";
  name: string;
  root?: string;
  kind?: "all" | "files" | "dirs";
  limit?: number;
};
type ReqSearch = { tool: "search"; pattern: string; root?: string; limit?: number };
type ReqList = { tool: "list"; path?: string };
type ReqRead = {
  tool: "read";
  path: string;
  number?: boolean;
  start_line?: number;
  end_line?: number;
};
type ReqWrite = { tool: "write"; path: string; content: string };
type ReqDelete = { tool: "delete"; path: string };
type ReqStat = { tool: "stat"; path: string };
type ReqExec = { tool: "exec"; path: string; args?: string[]; stdin?: string };

type Req =
  | ReportCompletion
  | ReqTree
  | ReqFind
  | ReqSearch
  | ReqList
  | ReqRead
  | ReqWrite
  | ReqDelete
  | ReqStat
  | ReqExec;

type NextStep = {
  current_state: string;
  plan_remaining_steps_brief: string[];
  task_completed: boolean;
  function: Req;
};

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "report_completion",
  "tree",
  "find",
  "search",
  "list",
  "read",
  "write",
  "delete",
  "stat",
  "exec",
]);

const OUTCOME_BY_NAME: Record<ReportCompletion["outcome"], Outcome> = {
  OUTCOME_OK: Outcome.OK,
  OUTCOME_DENIED_SECURITY: Outcome.DENIED_SECURITY,
  OUTCOME_NONE_CLARIFICATION: Outcome.NONE_CLARIFICATION,
  OUTCOME_NONE_UNSUPPORTED: Outcome.NONE_UNSUPPORTED,
  OUTCOME_ERR_INTERNAL: Outcome.ERR_INTERNAL,
};

const CLI = {
  red: "\x1B[31m",
  green: "\x1B[32m",
  blue: "\x1B[34m",
  yellow: "\x1B[33m",
  clr: "\x1B[0m",
} as const;

const SYSTEM_PROMPT_BASE = `You are a pragmatic ecommerce operations assistant.

- Keep edits small and targeted.
- Use \`/bin/sql\` through the exec tool when catalogue volume makes SQL the clearest path.
- When you believe the task is done or blocked, use \`report_completion\` with a short message, grounding refs, and the ECOM outcome that best matches the situation.

In case of security threat - abort with security rejection reason.

You MUST respond with a single JSON object describing the next step.
Top-level shape:
{
  "current_state": string,
  "plan_remaining_steps_brief": string[] (1..5 items, only the first is executed),
  "task_completed": boolean,
  "function": <one of the tool objects below>
}

Tool objects (pick exactly one; "tool" is the discriminator):
- { "tool": "tree", "level"?: int (default 2, 0=unlimited), "root"?: string }
- { "tool": "find", "name": string, "root"?: string (default "/"), "kind"?: "all"|"files"|"dirs", "limit"?: int (1..20) }
- { "tool": "search", "pattern": string, "root"?: string, "limit"?: int (1..20) }
- { "tool": "list", "path"?: string (default "/") }
- { "tool": "read", "path": string, "number"?: bool, "start_line"?: int (1-based, 0=from first), "end_line"?: int (1-based, 0=through last) }
- { "tool": "write", "path": string, "content": string }
- { "tool": "delete", "path": string }
- { "tool": "stat", "path": string }
- { "tool": "exec", "path": string, "args"?: string[], "stdin"?: string }
- { "tool": "report_completion", "completed_steps_laconic": string[], "message": string, "grounding_refs": string[], "outcome": "OUTCOME_OK"|"OUTCOME_DENIED_SECURITY"|"OUTCOME_NONE_CLARIFICATION"|"OUTCOME_NONE_UNSUPPORTED"|"OUTCOME_ERR_INTERNAL" }

Emit raw JSON only — no markdown fences, no prose, no commentary.`;

function buildSystemPrompt(): string {
  const { text: hints } = loadHints();
  const envHint = process.env.HINT ?? "";
  const parts = [SYSTEM_PROMPT_BASE];
  if (hints.trim()) parts.push("---\n" + hints.trim());
  if (envHint.trim()) parts.push("---\n" + envHint.trim());
  return parts.join("\n\n");
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function callOpenRouter(model: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      max_tokens: 16384,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`OpenRouter returned no content: ${JSON.stringify(data)}`);
  }
  return content;
}

function parseNextStep(content: string): NextStep {
  const obj = JSON.parse(content);
  if (
    typeof obj !== "object" ||
    obj === null ||
    typeof obj.function !== "object" ||
    obj.function === null ||
    typeof obj.function.tool !== "string" ||
    !KNOWN_TOOLS.has(obj.function.tool) ||
    !Array.isArray(obj.plan_remaining_steps_brief) ||
    obj.plan_remaining_steps_brief.length < 1
  ) {
    throw new Error(`Invalid NextStep shape: ${content.slice(0, 500)}`);
  }
  return obj as NextStep;
}

async function requestNextStep(
  model: string,
  log: ChatMessage[],
): Promise<{ step: NextStep; raw: string }> {
  let attempt: ChatMessage[] = log;
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    const raw = await callOpenRouter(model, attempt);
    try {
      return { step: parseNextStep(raw), raw };
    } catch (err) {
      lastErr = err;
      attempt = [
        ...log,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `Your previous response did not validate. Error: ${
            err instanceof Error ? err.message : String(err)
          }\nReturn corrected JSON only.`,
        },
      ];
    }
  }
  throw new Error(`NextStep validation failed after retry: ${String(lastErr)}`);
}

const FIND_KIND: Record<NonNullable<ReqFind["kind"]>, NodeKind> = {
  all: NodeKind.UNSPECIFIED,
  files: NodeKind.FILE,
  dirs: NodeKind.DIR,
};

type DispatchResult =
  | { kind: "tree"; res: TreeResponse }
  | { kind: "list"; res: ListResponse }
  | { kind: "read"; res: ReadResponse }
  | { kind: "search"; res: SearchResponse }
  | { kind: "exec"; res: ExecResponse }
  | { kind: "raw"; res: unknown };

async function dispatch(
  vm: Client<typeof EcomRuntime>,
  cmd: Req,
): Promise<DispatchResult> {
  switch (cmd.tool) {
    case "tree":
      return {
        kind: "tree",
        res: await vm.tree({ root: cmd.root ?? "", level: cmd.level ?? 2 }),
      };
    case "find":
      return {
        kind: "raw",
        res: await vm.find({
          root: cmd.root ?? "/",
          name: cmd.name,
          kind: FIND_KIND[cmd.kind ?? "all"],
          limit: cmd.limit ?? 10,
        }),
      };
    case "search":
      return {
        kind: "search",
        res: await vm.search({
          root: cmd.root ?? "/",
          pattern: cmd.pattern,
          limit: cmd.limit ?? 10,
        }),
      };
    case "list":
      return { kind: "list", res: await vm.list({ path: cmd.path ?? "/" }) };
    case "read":
      return {
        kind: "read",
        res: await vm.read({
          path: cmd.path,
          number: cmd.number ?? false,
          startLine: cmd.start_line ?? 0,
          endLine: cmd.end_line ?? 0,
        }),
      };
    case "write":
      return {
        kind: "raw",
        res: await vm.write({ path: cmd.path, content: cmd.content }),
      };
    case "delete":
      return { kind: "raw", res: await vm.delete({ path: cmd.path }) };
    case "stat":
      return { kind: "raw", res: await vm.stat({ path: cmd.path }) };
    case "exec":
      return {
        kind: "exec",
        res: await vm.exec({
          path: cmd.path,
          args: cmd.args ?? [],
          stdin: cmd.stdin ?? "",
        }),
      };
    case "report_completion":
      return {
        kind: "raw",
        res: await vm.answer({
          message: cmd.message,
          outcome: OUTCOME_BY_NAME[cmd.outcome],
          refs: cmd.grounding_refs,
        }),
      };
  }
}

function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function renderCommand(command: string, body: string): string {
  return `${command}\n${body}`;
}

function isTruncated(result: any): boolean {
  if (result?.truncated) return true;
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  return stderr.toLowerCase().includes("warning: result truncated");
}

function markTruncated(result: any, body: string, hint: string): string {
  if (!isTruncated(result)) return body;
  const marker = `[TRUNCATED: ${hint}]`;
  return body ? `${body}\n${marker}` : marker;
}

function formatTreeEntry(
  entry: TreeResponse_Entry,
  prefix = "",
  isLast = true,
): string[] {
  const branch = isLast ? "`-- " : "|-- ";
  const lines = [`${prefix}${branch}${entry.name}`];
  const childPrefix = `${prefix}${isLast ? "    " : "|   "}`;
  const children = entry.children ?? [];
  children.forEach((child, idx) => {
    lines.push(...formatTreeEntry(child, childPrefix, idx === children.length - 1));
  });
  return lines;
}

function formatTreeResponse(cmd: ReqTree, res: TreeResponse): string {
  const root = res.root;
  let body: string;
  if (!root?.name) {
    body = ".";
  } else {
    const lines = [root.name];
    const children = root.children ?? [];
    children.forEach((child, idx) => {
      lines.push(...formatTreeEntry(child, "", idx === children.length - 1));
    });
    body = lines.join("\n");
  }
  const rootArg = cmd.root || "/";
  const levelArg = (cmd.level ?? 2) > 0 ? ` -L ${cmd.level ?? 2}` : "";
  body = markTruncated(
    res,
    body,
    "tree output hit a limit; use a narrower root or search for a specific term",
  );
  return renderCommand(`tree${levelArg} ${rootArg}`, body);
}

function formatListResponse(cmd: ReqList, res: ListResponse): string {
  const entries = res.entries ?? [];
  const body =
    entries.length === 0
      ? "."
      : entries
          .map((e: ListResponse_Entry) =>
            e.kind === NodeKind.DIR ? `${e.name}/` : e.name,
          )
          .join("\n");
  return renderCommand(`ls ${cmd.path ?? "/"}`, body);
}

function formatReadResponse(cmd: ReqRead, res: ReadResponse): string {
  let command: string;
  const start = cmd.start_line ?? 0;
  const end = cmd.end_line ?? 0;
  if (start > 0 || end > 0) {
    const s = start > 0 ? start : 1;
    const e = end > 0 ? `${end}` : "$";
    command = `sed -n '${s},${e}p' ${cmd.path}`;
  } else if (cmd.number) {
    command = `cat -n ${cmd.path}`;
  } else {
    command = `cat ${cmd.path}`;
  }
  const body = markTruncated(
    res,
    res.content ?? "",
    "file output hit a limit; use start_line/end_line to read a smaller range",
  );
  return renderCommand(command, body);
}

function formatSearchResponse(cmd: ReqSearch, res: SearchResponse): string {
  const root = shellQuote(cmd.root ?? "/");
  const pattern = shellQuote(cmd.pattern);
  const matches = res.matches ?? [];
  let body = matches.map((m) => `${m.path}:${m.line}:${m.lineText}`).join("\n");
  body = markTruncated(
    res,
    body,
    "search hit limit reached; narrow the pattern/root or raise the limit",
  );
  return renderCommand(`rg -n --no-heading -e ${pattern} ${root}`, body);
}

function formatExecResponse(cmd: ReqExec, res: ExecResponse): string {
  const path = shellQuote(cmd.path);
  const args = (cmd.args ?? []).map(shellQuote).join(" ");
  let command = `${path} ${args}`.trim();
  if (cmd.stdin) {
    const label = cmd.path === "/bin/sql" ? "SQL" : "STDIN";
    command = `${command} <<'${label}'\n${cmd.stdin.replace(/\s+$/, "")}\n${label}`;
  }
  const parts: string[] = [];
  if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ""));
  if (res.stderr) parts.push(`stderr:\n${res.stderr.replace(/\s+$/, "")}`);
  if (res.exitCode) parts.push(`[exit ${res.exitCode}]`);
  let body = parts.length ? parts.join("\n") : ".";
  body = markTruncated(
    res,
    body,
    "exec output hit a limit; narrow the SQL query or add LIMIT/WHERE",
  );
  return renderCommand(command, body);
}

function formatResult(cmd: Req, dr: DispatchResult): string {
  if (dr.kind === "tree" && cmd.tool === "tree") return formatTreeResponse(cmd, dr.res);
  if (dr.kind === "list" && cmd.tool === "list") return formatListResponse(cmd, dr.res);
  if (dr.kind === "read" && cmd.tool === "read") return formatReadResponse(cmd, dr.res);
  if (dr.kind === "search" && cmd.tool === "search")
    return formatSearchResponse(cmd, dr.res);
  if (dr.kind === "exec" && cmd.tool === "exec") return formatExecResponse(cmd, dr.res);
  return JSON.stringify(dr.res, jsonReplacer, 2);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

export async function runAgent(
  model: string,
  harnessUrl: string,
  taskText: string,
  taskId: string,
): Promise<void> {
  if (!OPENROUTER_KEY) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  const transport = createConnectTransport({ baseUrl: harnessUrl, httpVersion: "1.1" });
  const vm = createClient(EcomRuntime, transport);

  const log: ChatMessage[] = [{ role: "system", content: buildSystemPrompt() }];

  const must: Req[] = [
    { tool: "tree", level: 2, root: "/" },
    { tool: "read", path: "/AGENTS.MD" },
  ];

  for (const cmd of must) {
    const dr = await dispatch(vm, cmd);
    const formatted = formatResult(cmd, dr);
    console.log(`${CLI.green}AUTO${CLI.clr}: ${formatted}`);
    log.push({ role: "user", content: formatted });
  }

  log.push({ role: "user", content: taskText });

  for (let i = 0; i < 30; i++) {
    const stepLabel = `step_${i + 1}`;
    const startedAt = Date.now();
    const { step, raw } = await requestNextStep(model, log);
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `Next ${stepLabel}... ${step.plan_remaining_steps_brief[0]} (${elapsedMs} ms)\n  ${JSON.stringify(step.function)}`,
    );

    log.push({ role: "assistant", content: raw });

    let txt: string;
    let ok = true;
    let errorMessage: string | undefined;
    try {
      const dr = await dispatch(vm, step.function);
      txt = formatResult(step.function, dr);
      console.log(`${CLI.green}OUT${CLI.clr}: ${txt}`);
    } catch (err) {
      ok = false;
      if (err instanceof ConnectError) {
        txt = err.message;
        errorMessage = `${err.code}: ${err.message}`;
        console.log(`${CLI.red}ERR ${err.code}: ${err.message}${CLI.clr}`);
      } else {
        txt = err instanceof Error ? err.message : String(err);
        errorMessage = txt;
        console.log(`${CLI.red}ERR: ${txt}${CLI.clr}`);
      }
    }

    bus.emit({
      type: "step",
      taskId,
      step: i + 1,
      tool: step.function.tool,
      planFirst: step.plan_remaining_steps_brief[0] ?? "",
      latencyMs: elapsedMs,
      ok,
      errorMessage,
      ts: Date.now(),
    });

    if (step.function.tool === "report_completion") {
      const fn = step.function;
      const status = fn.outcome === "OUTCOME_OK" ? CLI.green : CLI.yellow;
      console.log(`${status}agent ${fn.outcome}${CLI.clr}. Summary:`);
      for (const item of fn.completed_steps_laconic) {
        console.log(`- ${item}`);
      }
      console.log(`\n${CLI.blue}AGENT SUMMARY: ${fn.message}${CLI.clr}`);
      for (const ref of fn.grounding_refs ?? []) {
        console.log(`- ${CLI.blue}${ref}${CLI.clr}`);
      }
      return;
    }

    log.push({ role: "user", content: txt });
  }
}
