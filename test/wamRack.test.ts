import assert from "node:assert/strict";
import test from "node:test";
import { OrbitWamRack, collectRetainedPluginSlotIds, duplicatePluginSlots, prunePluginStates } from "../src/renderer/audio/wamRack.ts";
import type { PluginSlot } from "../src/renderer/state/types.ts";

class Node {
  edges = new Set<Node>();
  connect(node: Node) { this.edges.add(node); return node as unknown as AudioNode; }
  disconnect(node?: Node) { if (node) this.edges.delete(node); else this.edges.clear(); }
}
const slot = (id: string, bypassed = false): PluginSlot => ({ id, catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed });

test("rack rewires only its owned edges and bypasses unavailable slots dry", async () => {
  const input = new Node(), destination = new Node(), external = new Node(), wam = new Node();
  input.connect(external); input.connect(destination);
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode, async () => ({ audioNode: wam as unknown as AudioNode }), new Map());
  await rack.reconcile([slot("a")]);
  assert.equal(input.edges.has(external), true);
  assert.equal(input.edges.has(destination), false);
  assert.equal(input.edges.has(wam), true);
  assert.equal(wam.edges.has(destination), true);
  await rack.reconcile([slot("a", true)]);
  assert.equal(input.edges.has(external), true);
  assert.equal(input.edges.has(destination), true);
  assert.equal(input.edges.has(wam), false);
});

test("removing a downstream plugin severs the surviving neighbour's dangling edge to it", async () => {
  const input = new Node(), destination = new Node(), a = new Node(), b = new Node();
  const byId = new Map<string, Node>([["a", a], ["b", b]]);
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode,
    async (s) => ({ audioNode: byId.get(s.id) as unknown as AudioNode }), new Map());
  await rack.reconcile([slot("a"), slot("b")]);
  assert.equal(a.edges.has(b), true); assert.equal(b.edges.has(destination), true);
  await rack.reconcile([slot("a")]); // remove b (the downstream node)
  // a must not keep feeding the removed/destroyed b (which owns a worklet + feedback loop).
  assert.equal(a.edges.has(b), false, "surviving neighbour must not dangle into the removed node");
  assert.equal(a.edges.has(destination), true, "a reconnects straight to destination");
  assert.equal(input.edges.has(a), true);
});

test("late instance is destroyed and never wired after a newer reconcile", async () => {
  const input = new Node(), destination = new Node(), late = new Node(); let resolve!: (value: any) => void; let destroys = 0;
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode, () => new Promise((done) => { resolve = done; }), new Map());
  const first = rack.reconcile([slot("a")]);
  await rack.reconcile([]);
  resolve({ audioNode: late as unknown as AudioNode, destroy: () => { destroys++; } });
  await first;
  assert.equal(destroys, 1); assert.equal(input.edges.has(late), false); assert.equal(input.edges.has(destination), true);
});

test("newer same-slot reconcile replaces an in-flight create and reaches ready", async () => {
  const input = new Node(), destination = new Node(), stale = new Node(), current = new Node();
  const resolvers: Array<(instance: any) => void> = []; let staleDestroy = 0;
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode,
    () => new Promise((resolve) => { resolvers.push(resolve); }), new Map());
  const first = rack.reconcile([slot("a")], 1);
  while (resolvers.length < 1) await new Promise((done) => setTimeout(done, 0));
  const latest = rack.reconcile([slot("a")], 2);
  while (resolvers.length < 2) await new Promise((done) => setTimeout(done, 0));
  resolvers[0]({ audioNode: stale as unknown as AudioNode, destroy: () => { staleDestroy++; } });
  resolvers[1]({ audioNode: current as unknown as AudioNode });
  await Promise.all([first, latest]);
  assert.equal(staleDestroy, 1);
  assert.equal(rack.getStatus("a"), "ready");
  assert.equal(input.edges.has(current), true);
  assert.equal(input.edges.has(stale), false);
});

test("freeze snapshots state and destroys runtime exactly once", async () => {
  const input = new Node(), destination = new Node(), wam = new Node(); let destroys = 0;
  const states = new Map();
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode, async () => ({ audioNode: wam as unknown as AudioNode, getState: async () => ({ feedback: .3 }), destroy: async () => { destroys++; } }), states);
  await rack.reconcile([slot("a")]); await rack.freeze(); await rack.freeze();
  assert.deepEqual(states.get("a"), { feedback: .3 }); assert.equal(destroys, 1); assert.equal(input.edges.has(destination), true);
});

test("save capture stages every ready slot and does not mutate durable state on a failed read", async () => {
  const input = new Node(), destination = new Node(), first = new Node(), second = new Node();
  const states = new Map<string, any>([["a", { old: true }]]);
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode, async (item) => ({
    audioNode: (item.id === "a" ? first : second) as unknown as AudioNode,
    getState: async () => {
      if (item.id === "b") throw new Error("read failed");
      return { fresh: true };
    }
  }), states);
  await rack.reconcile([slot("a"), slot("b")]);
  await assert.rejects(rack.captureActiveStateForSave(), /read failed/);
  assert.deepEqual(states.get("a"), { old: true });
});

test("slot state is independent of history metadata and clone receives fresh ids", () => {
  const state = new Map<string, any>([["a", { nested: [1] }], ["orphan", 2]]);
  const copied = duplicatePluginSlots([slot("a")], state, () => "b");
  assert.deepEqual(copied.slots, [slot("b")]); assert.deepEqual(copied.state.get("b"), { nested: [1] });
  (copied.state.get("b") as any).nested.push(2); assert.deepEqual(state.get("a"), { nested: [1] });
  const retained = collectRetainedPluginSlotIds([{ orbits: [{ plugins: [slot("a")] }] }]); prunePluginStates(state, retained);
  assert.equal(state.has("a"), true); assert.equal(state.has("orphan"), false);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("a stale freeze cannot destroy, dry-rewire, or overwrite a newer same-slot reconcile", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const read = deferred<any>();
  const states = new Map<string, any>([["a", { before: true }]]);
  let destroys = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      getState: () => read.promise,
      destroy: () => { destroys++; },
    }),
    states,
  );
  await rack.reconcile([slot("a")]);
  const staleFreeze = rack.freeze();
  await rack.reconcile([slot("a")]);
  states.set("a", { newest: true });
  read.resolve({ stale: true });
  await staleFreeze;
  assert.equal(destroys, 0);
  assert.equal(rack.getStatus("a"), "ready");
  assert.equal(input.edges.has(wam), true);
  assert.equal(input.edges.has(destination), false);
  assert.deepEqual(states.get("a"), { newest: true });
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`a stale setState ${outcome} retires only its old instance`, async () => {
    const input = new Node(), destination = new Node(), oldNode = new Node(), currentNode = new Node();
    const setOld = deferred<void>();
    const states = new Map<string, any>([["a", { feedback: .2 }]]);
    let calls = 0, oldDestroys = 0, currentDestroys = 0;
    const rack = new OrbitWamRack(
      input as unknown as AudioNode,
      destination as unknown as AudioNode,
      async () => {
        calls++;
        if (calls === 1) return {
          audioNode: oldNode as unknown as AudioNode,
          setState: () => setOld.promise,
          destroy: () => { oldDestroys++; },
        };
        return {
          audioNode: currentNode as unknown as AudioNode,
          setState: async () => undefined,
          destroy: () => { currentDestroys++; },
        };
      },
      states,
    );
    const first = rack.reconcile([slot("a")], 1);
    while (calls < 1) await new Promise((done) => setTimeout(done, 0));
    const latest = rack.reconcile([slot("a")], 2);
    while (calls < 2) await new Promise((done) => setTimeout(done, 0));
    if (outcome === "resolve") setOld.resolve(); else setOld.reject(new Error("stale restore failed"));
    await Promise.all([first, latest]);
    assert.equal(oldDestroys, 1);
    assert.equal(currentDestroys, 0);
    assert.equal(rack.getStatus("a"), "ready");
    assert.equal(input.edges.has(oldNode), false);
    assert.equal(input.edges.has(currentNode), true);
  });
}

test("delayed old destroyGui cannot erase a newer GUI mapping or audio runtime", async () => {
  const input = new Node(), destination = new Node(), oldNode = new Node(), currentNode = new Node();
  const releaseOldGui = deferred<void>();
  const oldGui = { parentElement: null, remove() {} } as unknown as HTMLElement;
  const currentGui = { parentElement: null, remove() {} } as unknown as HTMLElement;
  const container = { append() {} } as unknown as HTMLElement;
  let creates = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => {
      creates++;
      if (creates === 1) return {
        audioNode: oldNode as unknown as AudioNode,
        createGui: async () => oldGui,
        destroyGui: () => releaseOldGui.promise,
      };
      return {
        audioNode: currentNode as unknown as AudioNode,
        createGui: async () => currentGui,
        destroyGui: async () => undefined,
      };
    },
    new Map(),
  );
  await rack.reconcile([slot("a")]);
  await rack.mountGui("a", container);
  const oldRemoval = rack.reconcile([]);
  while (rack.getRuntime("a")?.disposed !== true) await new Promise((done) => setTimeout(done, 0));
  await rack.reconcile([slot("a")]);
  await rack.mountGui("a", container);
  releaseOldGui.resolve();
  await oldRemoval;
  assert.equal(rack.getStatus("a"), "ready");
  assert.equal(input.edges.has(currentNode), true);
  assert.equal(input.edges.has(oldNode), false);
  // A second mount observes the newer GUI rather than recreating it, proving
  // the old delayed teardown did not remove its slot mapping.
  await rack.mountGui("a", container);
});
