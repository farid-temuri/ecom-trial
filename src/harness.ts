import type { Client } from "@connectrpc/connect";
import {
  EcomRuntime,
  NodeKind,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import type { Features } from "./config";
import { runSubmissionGates } from "./gates";
import { collectMdFromList, collectMdPaths, queueNewMdPaths, treeToPlain, truncateForLog } from "./format";
import { OUTCOME_BY_NAME, type Scratchpad, type ScriptHarness, type VerifyFn } from "./types";
import { errMsg } from "./util";

const FIND_KIND: Record<"all" | "files" | "dirs", NodeKind> = {
  all: NodeKind.UNSPECIFIED,
  files: NodeKind.FILE,
  dirs: NodeKind.DIR,
};

export type HarnessState = {
  openedPaths: Set<string>;
  readSet: Set<string>;
  preloadedMdPaths: Set<string>;
  pendingMdPaths: Set<string>;
  scratchpad: Scratchpad;
};

// A minimal event sink for the diagnostic probe. The production wiring passes
// bus.emit; tests pass a noop or a spy.
export type ProbeEmit = (event: {
  type: "bootstrap";
  taskId: string;
  tool: string;
  input: unknown;
  output: string;
  outputBytes: number;
  ok: boolean;
  ts: number;
}) => void;

export function ensureRefsArray(sp: Scratchpad): string[] {
  if (!Array.isArray(sp.refs)) sp.refs = [];
  return sp.refs as string[];
}

// Push a path into scratchpad.refs unless canonical mode owns citations.
export function autoCite(
  sp: Scratchpad,
  path: string,
  features: Features,
): void {
  if (features.refsWhyCanonical) return; // refs_why owns citations
  const refs = ensureRefsArray(sp);
  if (!refs.includes(path)) refs.push(path);
}

export type BuildHarnessDeps = {
  vm: Client<typeof EcomRuntime>;
  state: HarnessState;
  features: Features;
  taskId: string;
  emit: ProbeEmit;
};

export function buildHarness(deps: BuildHarnessDeps): ScriptHarness {
  const { vm, state, features, taskId, emit } = deps;
  const { openedPaths, readSet, preloadedMdPaths, pendingMdPaths, scratchpad } =
    state;

  return {
    async tree(args = {}) {
      const res = await vm.tree({ root: args.root ?? "/", level: args.level ?? 2 });
      const mdPaths = collectMdPaths(res.root, args.root ?? "/");
      if (features.lazyMd) queueNewMdPaths(mdPaths, preloadedMdPaths, pendingMdPaths);
      return treeToPlain(res.root);
    },
    async find(args) {
      const res = await vm.find({
        root: args.root ?? "/",
        name: args.name,
        kind: FIND_KIND[args.kind ?? "all"],
        limit: args.limit ?? 10,
      });
      if (features.lazyMd) queueNewMdPaths(res.paths ?? [], preloadedMdPaths, pendingMdPaths);
      return res;
    },
    async search(args) {
      const res = await vm.search({
        root: args.root ?? "/",
        pattern: args.pattern,
        limit: args.limit ?? 10,
      });
      const matches = (res.matches ?? []).map((m) => ({
        path: m.path,
        line: m.line,
        lineText: m.lineText,
      }));
      if (features.lazyMd) {
        queueNewMdPaths(
          matches.map((m) => m.path),
          preloadedMdPaths,
          pendingMdPaths,
        );
      }
      return { matches };
    },
    async list(args = {}) {
      const path = args.path ?? "/";
      const res = await vm.list({ path });
      openedPaths.add(path);
      const entries = (res.entries ?? []).map((e) => ({
        name: e.name,
        isDir: e.kind === NodeKind.DIR,
      }));
      const mdPaths = collectMdFromList(
        path,
        entries.filter((e) => !e.isDir).map((e) => e.name),
      );
      if (features.lazyMd) queueNewMdPaths(mdPaths, preloadedMdPaths, pendingMdPaths);
      return { entries };
    },
    async read(args) {
      const res = await vm.read({
        path: args.path,
        number: args.number ?? false,
        startLine: args.start_line ?? 0,
        endLine: args.end_line ?? 0,
      });
      // Flat /proc/catalog/SKU.json aliases resolve at runtime but the grader
      // compares refs by exact string equality against the canonical nested
      // path. Detect a flat catalog read, find the canonical path, surface it.
      let effectivePath = args.path;
      let canonicalNote = "";
      if (/^\/proc\/catalog\/[^/]+\.json$/.test(args.path)) {
        const basename = args.path.split("/").pop()!;
        try {
          const fr = await vm.find({
            root: "/proc/catalog",
            name: basename,
            kind: NodeKind.FILE,
            limit: 2,
          });
          const matches = (fr.paths ?? []).filter((p) => p.endsWith("/" + basename));
          if (matches.length === 1 && matches[0] !== args.path) {
            effectivePath = matches[0]!;
            canonicalNote =
              `\n\n[harness note] You read "${args.path}" but the canonical workspace path is "${effectivePath}". ` +
              `The runtime resolves the alias, but the grader checks refs by exact string equality. ` +
              `Cite the canonical path; the alias has NOT been added to your read set.`;
          }
        } catch {
          // find failed — leave effectivePath as-is.
        }
      }
      openedPaths.add(effectivePath);
      readSet.add(effectivePath);
      if (features.autoCite) autoCite(scratchpad, effectivePath, features);
      return {
        content: (res.content ?? "") + canonicalNote,
        truncated: res.truncated ?? false,
      };
    },
    async write(args) {
      await vm.write({ path: args.path, content: args.content });
      openedPaths.add(args.path);
      readSet.add(args.path);
      if (features.autoCite) autoCite(scratchpad, args.path, features);
    },
    async delete(args) {
      await vm.delete({ path: args.path });
      openedPaths.add(args.path);
      if (features.autoCite) autoCite(scratchpad, args.path, features);
    },
    async stat(args) {
      const res = await vm.stat({ path: args.path });
      openedPaths.add(args.path);
      // stat does NOT add to readSet — metadata only, not content.
      if (features.lazyMd && args.path.endsWith(".md")) {
        queueNewMdPaths([args.path], preloadedMdPaths, pendingMdPaths);
      }
      return res;
    },
    async exec(args) {
      const res = await vm.exec({
        path: args.path,
        args: args.args ?? [],
        stdin: args.stdin ?? "",
      });
      // exec'd binaries are legitimate evidence sources (e.g. /bin/id for
      // identity in DENIED_SECURITY answers). Treat a successful exec like a read.
      openedPaths.add(args.path);
      readSet.add(args.path);
      return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.exitCode ?? 0,
      };
    },
    async answer(sp: Scratchpad, verify: VerifyFn) {
      if (features.debugRefProbe) {
        await runRefAliasProbe(vm, sp, taskId, emit);
      }
      const { outcome, refs } = await runSubmissionGates(sp, verify, {
        features,
        readSet,
        openedPaths,
      });
      const message = typeof sp.answer === "string" ? sp.answer : "";
      await vm.answer({ message, outcome: OUTCOME_BY_NAME[outcome], refs });
    },
    opened() {
      return [...(features.strictRefs ? readSet : openedPaths)].sort();
    },
  };
}

// Diagnostic probe — for every *.json ref about to be submitted, find all
// on-disk paths the SKU lives at and emit them. Surfaces brand-mirror vs
// category-mirror vs flat aliases. Never blocks submission.
async function runRefAliasProbe(
  vm: Client<typeof EcomRuntime>,
  sp: Scratchpad,
  taskId: string,
  emit: ProbeEmit,
): Promise<void> {
  try {
    const whyKeys =
      sp.refs_why && typeof sp.refs_why === "object" && !Array.isArray(sp.refs_why)
        ? Object.keys(sp.refs_why as Record<string, unknown>)
        : [];
    const refsArr = Array.isArray(sp.refs)
      ? (sp.refs as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const candidates = new Set<string>();
    for (const r of [...whyKeys, ...refsArr]) {
      if (typeof r !== "string") continue;
      const stripped = r.replace(/[#?].*$/, "");
      if (!stripped.endsWith(".json")) continue;
      candidates.add(stripped);
    }
    for (const ref of candidates) {
      const base = ref.split("/").pop() ?? ref;
      let outputLine: string;
      let ok = true;
      try {
        const fr = await vm.find({ root: "/", name: base, kind: FIND_KIND.files, limit: 50 });
        const paths = fr.paths ?? [];
        outputLine = `submitted: ${ref}\nfound ${paths.length} on-disk path(s) for ${base}:\n${paths.join("\n")}`;
      } catch (err) {
        ok = false;
        outputLine = `submitted: ${ref}\nfind failed: ${errMsg(err)}`;
      }
      const { text, bytes } = truncateForLog(outputLine);
      emit({
        type: "bootstrap",
        taskId,
        tool: "ref_alias_probe",
        input: { ref, name: base },
        output: text,
        outputBytes: bytes,
        ok,
        ts: Date.now(),
      });
    }
  } catch {
    // Diagnostic only — never block submission.
  }
}
