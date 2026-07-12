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

test("freeze snapshots state and destroys runtime exactly once", async () => {
  const input = new Node(), destination = new Node(), wam = new Node(); let destroys = 0;
  const states = new Map();
  const rack = new OrbitWamRack(input as unknown as AudioNode, destination as unknown as AudioNode, async () => ({ audioNode: wam as unknown as AudioNode, getState: async () => ({ feedback: .3 }), destroy: async () => { destroys++; } }), states);
  await rack.reconcile([slot("a")]); await rack.freeze(); await rack.freeze();
  assert.deepEqual(states.get("a"), { feedback: .3 }); assert.equal(destroys, 1); assert.equal(input.edges.has(destination), true);
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
