import { describe, expect, test } from "bun:test";
import { Outcome } from "@buf/bitgn_api.bufbuild_es/bitgn/vm/ecom/ecom_pb";
import type { Features } from "./config";
import { buildHarness, autoCite, type HarnessState } from "./harness";
import { makeFakeVm } from "./test-helpers";
import type { Scratchpad } from "./types";

function feats(o: Partial<Features> = {}): Features {
  return {
    lazyMd: false,
    autoCite: false,
    strictRefs: false,
    citingReasoning: false,
    structuredFacts: false,
    refsWhyCanonical: false,
    debugRefProbe: false,
    navHints: false,
    ...o,
  };
}

function freshState(scratchpad: Scratchpad = { refs: [] }): HarnessState {
  return {
    openedPaths: new Set(),
    readSet: new Set(),
    preloadedMdPaths: new Set(),
    pendingMdPaths: new Set(),
    scratchpad,
  };
}

describe("autoCite", () => {
  test("adds a path to refs in non-canonical mode", () => {
    const sp: Scratchpad = { refs: [] };
    autoCite(sp, "/a.json", feats());
    expect(sp.refs).toEqual(["/a.json"]);
  });
  test("dedupes", () => {
    const sp: Scratchpad = { refs: ["/a.json"] };
    autoCite(sp, "/a.json", feats());
    expect(sp.refs).toEqual(["/a.json"]);
  });
  test("is a no-op under canonical mode", () => {
    const sp: Scratchpad = { refs: [] };
    autoCite(sp, "/a.json", feats({ refsWhyCanonical: true }));
    expect(sp.refs).toEqual([]);
  });
});

describe("harness.read", () => {
  test("adds the path to openedPaths and readSet", async () => {
    const { vm } = makeFakeVm({ files: { "/x.json": "{}" } });
    const state = freshState();
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    const r = await h.read({ path: "/x.json" });
    expect(r.content).toBe("{}");
    expect(state.openedPaths.has("/x.json")).toBe(true);
    expect(state.readSet.has("/x.json")).toBe(true);
  });

  test("resolves a flat /proc/catalog alias to the canonical nested path", async () => {
    const { vm } = makeFakeVm({
      files: { "/proc/catalog/FST-1.json": "{}" },
      findPaths: { "FST-1.json": ["/proc/catalog/fasteners/FST-1.json"] },
    });
    const state = freshState();
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    const r = await h.read({ path: "/proc/catalog/FST-1.json" });
    // canonical note appended; canonical path (not the alias) added to readSet.
    expect(r.content).toContain("[harness note]");
    expect(state.readSet.has("/proc/catalog/fasteners/FST-1.json")).toBe(true);
    expect(state.readSet.has("/proc/catalog/FST-1.json")).toBe(false);
  });

  test("auto-cites when the feature is on", async () => {
    const { vm } = makeFakeVm({ files: { "/x.json": "{}" } });
    const sp: Scratchpad = { refs: [] };
    const state = freshState(sp);
    const h = buildHarness({ vm, state, features: feats({ autoCite: true }), taskId: "t", emit: () => {} });
    await h.read({ path: "/x.json" });
    expect(sp.refs).toEqual(["/x.json"]);
  });
});

describe("harness.exec / stat", () => {
  test("exec adds the binary to readSet (citable evidence)", async () => {
    const { vm } = makeFakeVm();
    const state = freshState();
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    await h.exec({ path: "/bin/id" });
    expect(state.readSet.has("/bin/id")).toBe(true);
  });
  test("stat adds to openedPaths but NOT readSet", async () => {
    const { vm } = makeFakeVm();
    const state = freshState();
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    await h.stat({ path: "/x.json" });
    expect(state.openedPaths.has("/x.json")).toBe(true);
    expect(state.readSet.has("/x.json")).toBe(false);
  });
});

describe("harness.answer", () => {
  test("runs the gate pipeline then forwards to vm.answer", async () => {
    const { vm, calls } = makeFakeVm({ files: { "/a.json": "{}" } });
    const sp: Scratchpad = { refs: ["/a.json"], outcome: "OUTCOME_OK", answer: "Total: 1" };
    const state = freshState(sp);
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    await h.read({ path: "/a.json" });
    await h.answer(sp, () => ({ ok: true }));
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0]).toEqual({
      message: "Total: 1",
      outcome: Outcome.OK,
      refs: ["/a.json"],
    });
  });

  test("a failing gate throws and does NOT call vm.answer", async () => {
    const { vm, calls } = makeFakeVm();
    const sp: Scratchpad = { refs: ["/never-opened.json"], outcome: "OUTCOME_OK", answer: "x" };
    const state = freshState(sp);
    const h = buildHarness({ vm, state, features: feats(), taskId: "t", emit: () => {} });
    await expect(h.answer(sp, () => true)).rejects.toThrow(/never opened/);
    expect(calls.answer).toHaveLength(0);
  });

  test("debug probe emits only when the feature is on", async () => {
    const { vm } = makeFakeVm({ files: { "/a.json": "{}" } });
    const sp: Scratchpad = { refs: ["/a.json"], outcome: "OUTCOME_OK", answer: "x" };
    const state = freshState(sp);
    const events: string[] = [];
    const h = buildHarness({
      vm,
      state,
      features: feats({ debugRefProbe: true }),
      taskId: "t",
      emit: (e) => events.push(e.tool),
    });
    await h.read({ path: "/a.json" });
    await h.answer(sp, () => true);
    expect(events).toContain("ref_alias_probe");
  });
});
