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

test("pending third-party destroy cannot block dry topology publication", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const never = new Promise<void>(() => undefined);
  const diagnostics: string[] = [];
  let destroys = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      destroy: () => { destroys++; return never; },
    }),
    new Map(),
    (reason) => diagnostics.push(reason),
    { cleanupDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a")]);

  const removal = rack.reconcile([]);
  assert.equal(input.edges.has(wam), false, "removed node is detached before the first await");
  assert.equal(input.edges.has(destination), true, "dry path is published before the first await");
  const outcome = await Promise.race([
    removal.then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  assert.equal(outcome, "completed");
  assert.equal(destroys, 1);
  assert.equal(input.edges.has(wam), false);
  assert.equal(input.edges.has(destination), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(diagnostics.includes("cleanup-timeout"), true);
});

test("pending downstream destroy cannot leave a surviving plugin disconnected", async () => {
  const input = new Node(), destination = new Node(), a = new Node(), b = new Node();
  const never = new Promise<void>(() => undefined);
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async (item) => ({
      audioNode: (item.id === "a" ? a : b) as unknown as AudioNode,
      ...(item.id === "b" ? { destroy: () => never } : {}),
    }),
    new Map(),
    () => undefined,
    { cleanupDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a"), slot("b")]);

  const removal = rack.reconcile([slot("a")]);
  assert.equal(a.edges.has(b), false, "dangling edge is severed before the first await");
  assert.equal(a.edges.has(destination), true, "survivor is published before the first await");
  const outcome = await Promise.race([
    removal.then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  assert.equal(outcome, "completed");
  assert.equal(input.edges.has(a), true);
  assert.equal(a.edges.has(b), false);
  assert.equal(a.edges.has(destination), true);
});

test("concurrent mountGui calls for the same instance create the plugin GUI exactly once", async () => {
  // Reproduces React StrictMode's mount -> cleanup -> mount probe: the effect
  // fires twice before the async createGui() from the first call resolves.
  // A naive implementation invokes createGui() twice, constructing two
  // independent plugin GUI instances (each owning its own drag/animation
  // state); only one ever gets destroyed if the plugin's destroyGui() is a
  // no-op, leaking a live, invisible GUI that can no longer be interacted with.
  const input = new Node(), destination = new Node(), wam = new Node();
  const container = { append() {} } as unknown as HTMLElement;
  let creates = 0;
  let resolveGui!: (gui: HTMLElement) => void;
  const gui = { parentElement: null, remove() {} } as unknown as HTMLElement;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      createGui: () => { creates++; return new Promise<HTMLElement>((resolve) => { resolveGui = resolve; }); },
      destroyGui: async () => undefined,
    }),
    new Map(),
  );
  await rack.reconcile([slot("a")]);

  const first = rack.mountGui("a", container);
  const second = rack.mountGui("a", container);
  resolveGui(gui);
  await Promise.all([first, second]);

  assert.equal(creates, 1, "createGui must be coalesced across concurrent mount calls");
});

test("pending destroyGui cannot delay runtime retirement or rewire", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const never = new Promise<void>(() => undefined);
  let guiRemovals = 0;
  const gui = { parentElement: null, remove: () => { guiRemovals++; } } as unknown as HTMLElement;
  const container = { append() {} } as unknown as HTMLElement;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      createGui: async () => gui,
      destroyGui: () => never,
    }),
    new Map(),
    () => undefined,
    { cleanupDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a")]);
  await rack.mountGui("a", container);

  const outcome = await Promise.race([
    rack.reconcile([]).then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  assert.equal(outcome, "completed");
  assert.equal(guiRemovals, 1);
  assert.equal(input.edges.has(wam), false);
  assert.equal(input.edges.has(destination), true);
});

test("cleanup rejection is diagnosed and repeated lifecycle calls destroy exactly once", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const diagnostics: string[] = [];
  const gui = { parentElement: null, remove() {} } as unknown as HTMLElement;
  const container = { append() {} } as unknown as HTMLElement;
  let destroys = 0, guiDestroys = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      createGui: async () => gui,
      destroyGui: async () => { guiDestroys++; throw new Error("gui cleanup failed"); },
      destroy: async () => { destroys++; throw new Error("cleanup failed"); },
    }),
    new Map(),
    (reason) => diagnostics.push(reason),
    { cleanupDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a")]);
  await rack.mountGui("a", container);
  await Promise.all([rack.reconcile([]), rack.freeze(), rack.disposeAll()]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(destroys, 1);
  assert.equal(guiDestroys, 1);
  assert.equal(diagnostics.includes("destroy-failed"), true);
  assert.equal(diagnostics.includes("gui-cleanup-failed"), true);
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

test("freeze state timeout preserves last-good state and still completes teardown", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const never = new Promise<unknown>(() => undefined);
  const states = new Map<string, any>([["a", { lastGood: true }]]);
  const diagnostics: string[] = [];
  let destroys = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      getState: () => never,
      destroy: () => { destroys++; },
    }),
    states,
    (reason) => diagnostics.push(reason),
    { cleanupDeadlineMs: 5, stateDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a")]);

  await rack.freeze();

  assert.deepEqual(states.get("a"), { lastGood: true });
  assert.equal(diagnostics.includes("state-timeout"), true);
  assert.equal(destroys, 1);
  assert.equal(input.edges.has(destination), true);
});

test("save state timeout rejects atomically instead of publishing a partial capture", async () => {
  const input = new Node(), destination = new Node(), first = new Node(), second = new Node();
  const never = new Promise<unknown>(() => undefined);
  const states = new Map<string, any>([["a", { old: true }]]);
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async (item) => ({
      audioNode: (item.id === "a" ? first : second) as unknown as AudioNode,
      getState: item.id === "a" ? async () => ({ fresh: true }) : () => never,
    }),
    states,
    () => undefined,
    { stateDeadlineMs: 5 },
  );
  await rack.reconcile([slot("a"), slot("b")]);

  await assert.rejects(rack.captureActiveStateForSave(), /wam-state-timeout/);
  assert.deepEqual(states.get("a"), { old: true });
});

test("setState timeout leaves durable state intact and retires the unusable instance once", async () => {
  const input = new Node(), destination = new Node(), wam = new Node();
  const never = new Promise<void>(() => undefined);
  const states = new Map<string, any>([["a", { feedback: .4 }]]);
  let destroys = 0;
  const rack = new OrbitWamRack(
    input as unknown as AudioNode,
    destination as unknown as AudioNode,
    async () => ({
      audioNode: wam as unknown as AudioNode,
      setState: () => never,
      destroy: () => { destroys++; },
    }),
    states,
    () => undefined,
    { cleanupDeadlineMs: 5, stateDeadlineMs: 5 },
  );

  await rack.reconcile([slot("a")]);

  assert.equal(rack.getStatus("a"), "unavailable");
  assert.deepEqual(states.get("a"), { feedback: .4 });
  assert.equal(destroys, 1);
  assert.equal(input.edges.has(destination), true);
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
    let calls = 0, oldSetStateCalls = 0, oldDestroys = 0, currentDestroys = 0;
    const rack = new OrbitWamRack(
      input as unknown as AudioNode,
      destination as unknown as AudioNode,
      async () => {
        calls++;
        if (calls === 1) return {
          audioNode: oldNode as unknown as AudioNode,
          setState: () => { oldSetStateCalls++; return setOld.promise; },
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
    while (oldSetStateCalls < 1) await new Promise((done) => setTimeout(done, 0));
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
  await oldRemoval;
  await rack.reconcile([slot("a")]);
  await rack.mountGui("a", container);
  releaseOldGui.resolve();
  assert.equal(rack.getStatus("a"), "ready");
  assert.equal(input.edges.has(currentNode), true);
  assert.equal(input.edges.has(oldNode), false);
  // A second mount observes the newer GUI rather than recreating it, proving
  // the old delayed teardown did not remove its slot mapping.
  await rack.mountGui("a", container);
});
