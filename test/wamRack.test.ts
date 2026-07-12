import assert from "node:assert/strict";
import test from "node:test";
import { OrbitWamRack, SceneWamCoordinator, collectRetainedPluginSlotIds, duplicatePluginSlots, prunePluginStates } from "../src/renderer/audio/wamRack.ts";
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

test("scene coordinator is last-wins and publishes ownership only after hydrate", async () => {
  const calls: string[] = []; let release!: () => void;
  const slow = { freeze: async () => { calls.push("freeze"); }, reconcile: async () => { calls.push("slow"); await new Promise<void>((done) => { release = done; }); } };
  const fast = { freeze: async () => { calls.push("freeze-fast"); }, reconcile: async () => { calls.push("fast"); } };
  const coordinator = new SceneWamCoordinator((id) => id === "b" ? [{ rack: slow, slots: [slot("b")] }] : [{ rack: fast, slots: [slot("c")] }]);
  const old = coordinator.transition("a", "b"); while (!release) await new Promise((done) => setTimeout(done, 0)); const newer = coordinator.transition("b", "c"); release();
  assert.equal(await newer, true); assert.equal(await old, false); assert.equal(coordinator.runtimeOwnerSceneId, "c"); assert.deepEqual(calls, ["freeze-fast", "slow", "freeze", "fast"]);
});
