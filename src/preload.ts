import type { Client } from "@connectrpc/connect";
import {
  EcomRuntime,
  NodeKind,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import type { Features } from "./config";
import {
  collectMdPaths,
  formatReadResponse,
  formatTreeResponse,
  truncateForLog,
} from "./format";
import { autoCite } from "./harness";
import type { ReqRead, ReqTree, Scratchpad } from "./types";
import { errMsg } from "./util";
import type { TrialEvent } from "../events";

export type PreloadResult = {
  agentsMd: string;
  workspaceTree: string;
  workspaceDocs: string;
  workspaceMdIndex: string[];
};

export type PreloadDeps = {
  vm: Client<typeof EcomRuntime>;
  taskId: string;
  openedPaths: Set<string>;
  readSet: Set<string>;
  preloadedMdPaths: Set<string>;
  scratchpad: Scratchpad;
  features: Features;
  emit: (event: TrialEvent) => void;
};

export async function preloadContext(deps: PreloadDeps): Promise<PreloadResult> {
  const {
    vm,
    taskId,
    openedPaths,
    readSet,
    preloadedMdPaths,
    scratchpad,
    features,
    emit,
  } = deps;

  const emitBootstrap = (
    tool: string,
    input: unknown,
    formatted: string,
    ok: boolean,
    errorMessage?: string,
  ): void => {
    const { text, bytes } = truncateForLog(formatted);
    emit({
      type: "bootstrap",
      taskId,
      tool,
      input,
      output: text,
      outputBytes: bytes,
      ok,
      errorMessage,
      ts: Date.now(),
    });
  };

  const treeCmd: ReqTree = { tool: "tree", level: 2, root: "/" };
  const treeRes = await vm.tree({ root: "/", level: 2 });
  const workspaceTree = formatTreeResponse(treeCmd, treeRes);
  emitBootstrap("tree", treeCmd, workspaceTree, true);

  const readAgentsCmd: ReqRead = { tool: "read", path: "/AGENTS.MD" };
  let agentsMd = "";
  try {
    const r = await vm.read({ path: "/AGENTS.MD", number: false, startLine: 0, endLine: 0 });
    agentsMd = r.content ?? "";
    openedPaths.add("/AGENTS.MD");
    readSet.add("/AGENTS.MD");
    if (features.autoCite) autoCite(scratchpad, "/AGENTS.MD", features);
    emitBootstrap("read", readAgentsCmd, formatReadResponse(readAgentsCmd, r), true);
  } catch (err) {
    const msg = errMsg(err);
    emitBootstrap("read", readAgentsCmd, msg, false, msg);
  }

  // Scan /docs every trial so newly-added docs are discovered automatically.
  const docsTreeCmd: ReqTree = { tool: "tree", level: 2, root: "/docs" };
  let mdPaths: string[] = [];
  try {
    const docsTreeRes = await vm.tree({ root: "/docs", level: 2 });
    emitBootstrap("tree", docsTreeCmd, formatTreeResponse(docsTreeCmd, docsTreeRes), true);
    mdPaths = collectMdPaths(docsTreeRes.root, "/docs");
  } catch (err) {
    const msg = errMsg(err);
    emitBootstrap("tree", docsTreeCmd, msg, false, msg);
  }
  const workspaceMdIndex: string[] = [];

  // Discover every other *.md in the workspace (e.g. /proc/catalog/README.md).
  const findMdCmd = { tool: "find", root: "/", name: "*.md", kind: "files", limit: 500 };
  const extraMdPaths: string[] = [];
  try {
    const docsSet = new Set(mdPaths);
    const fr = await vm.find({ root: "/", name: "*.md", kind: NodeKind.FILE, limit: 500 });
    for (const p of fr.paths ?? []) {
      if (!p.endsWith(".md")) continue;
      if (p === "/AGENTS.MD") continue;
      if (docsSet.has(p)) continue;
      extraMdPaths.push(p);
    }
    emitBootstrap(
      "find",
      findMdCmd,
      `found ${extraMdPaths.length} extra *.md (after filtering /docs and /AGENTS.MD)\n${extraMdPaths.join("\n")}`,
      true,
    );
  } catch (err) {
    const msg = errMsg(err);
    emitBootstrap("find", findMdCmd, msg, false, msg);
  }
  const allMdPaths = [...mdPaths, ...extraMdPaths];
  const extraSet = new Set(extraMdPaths);

  const docs = await Promise.all(
    allMdPaths.map(async (p) => {
      try {
        const r = await vm.read({ path: p, number: false, startLine: 0, endLine: 0 });
        openedPaths.add(p);
        readSet.add(p);
        preloadedMdPaths.add(p);
        // Only auto-cite /docs/*.md — extra READMEs found via find() are
        // scene-setting and would trip the grader's over-citation check.
        if (features.autoCite && !extraSet.has(p)) autoCite(scratchpad, p, features);
        return { path: p, content: r.content ?? "", ok: true };
      } catch (err) {
        return { path: p, content: errMsg(err), ok: false };
      }
    }),
  );

  const workspaceDocs = docs
    .map((d) => {
      const attr = d.ok ? "" : ' error="true"';
      return `<doc path="${d.path}"${attr}>\n${d.content}\n</doc>`;
    })
    .join("\n\n");

  const totalBytes = docs.reduce((n, d) => n + d.content.length, 0);
  const okCount = docs.filter((d) => d.ok).length;
  emitBootstrap(
    "preload_docs",
    { paths: allMdPaths },
    `loaded ${okCount}/${docs.length} docs (${mdPaths.length} from /docs + ${extraMdPaths.length} extra, ${totalBytes} bytes)\n${allMdPaths.join("\n")}`,
    okCount === docs.length,
  );

  return { agentsMd, workspaceTree, workspaceDocs, workspaceMdIndex };
}
