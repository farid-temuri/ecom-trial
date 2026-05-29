import type {
  ReadResponse,
  TreeResponse,
  TreeResponse_Entry,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import type { ReqRead, ReqTree, TreeNodeOut } from "./types";

export const LOG_OUTPUT_CAP_BYTES = 16384;

// Anything with the fields we inspect to decide whether output was truncated.
type Truncatable = { truncated?: boolean; stderr?: string };

export function renderCommand(command: string, body: string): string {
  return `${command}\n${body}`;
}

export function isTruncated(result: Truncatable): boolean {
  if (result.truncated) return true;
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return stderr.toLowerCase().includes("warning: result truncated");
}

export function markTruncated(
  result: Truncatable,
  body: string,
  hint: string,
): string {
  if (!isTruncated(result)) return body;
  const marker = `[TRUNCATED: ${hint}]`;
  return body ? `${body}\n${marker}` : marker;
}

export function formatTreeEntry(
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

export function formatTreeResponse(cmd: ReqTree, res: TreeResponse): string {
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

export function formatReadResponse(cmd: ReqRead, res: ReadResponse): string {
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

export function truncateForLog(s: string): { text: string; bytes: number } {
  const buf = Buffer.from(s, "utf8");
  const bytes = buf.length;
  if (bytes <= LOG_OUTPUT_CAP_BYTES) return { text: s, bytes };
  const head = buf.subarray(0, LOG_OUTPUT_CAP_BYTES).toString("utf8");
  return { text: `${head}\n[TRUNCATED: original ${bytes} bytes]`, bytes };
}

export function collectMdPaths(
  root: TreeResponse_Entry | undefined,
  basePath: string,
): string[] {
  if (!root) return [];
  const out: string[] = [];
  const walk = (entry: TreeResponse_Entry, parent: string): void => {
    const path = `${parent}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.name.endsWith(".md")) out.push(path);
    for (const child of entry.children ?? []) walk(child, path);
  };
  for (const child of root.children ?? []) walk(child, basePath);
  return out;
}

// Scan a directory listing for *.md paths the model might want to read.
export function collectMdFromList(basePath: string, names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (n.endsWith(".md")) {
      const p = `${basePath.replace(/\/+$/, "")}/${n}`.replace(/\/+/g, "/");
      out.push(p);
    }
  }
  return out;
}

export function queueNewMdPaths(
  paths: string[],
  preloaded: Set<string>,
  pending: Set<string>,
): void {
  for (const p of paths) {
    if (!p.endsWith(".md")) continue;
    if (preloaded.has(p)) continue;
    pending.add(p);
  }
}

export function treeToPlain(entry: TreeResponse_Entry | undefined): TreeNodeOut {
  if (!entry) return { name: "", children: [] };
  return {
    name: entry.name,
    children: (entry.children ?? []).map(treeToPlain),
  };
}

// Serialize a captured console argument: strings pass through; everything else
// is JSON with bigint/Uint8Array made safe; unserializable values fall back to
// String().
export function jsonish(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  try {
    return JSON.stringify(
      v,
      (_k, x) => {
        if (typeof x === "bigint") return x.toString();
        if (x instanceof Uint8Array) return Buffer.from(x).toString("base64");
        return x;
      },
      2,
    );
  } catch {
    return String(v);
  }
}
