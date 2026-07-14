import assert from "node:assert/strict";
import test from "node:test";
import type { Orbit, Planet, Scene, TriggerBar } from "../src/renderer/state/types.ts";
import {
  collectHistoryProjectIds, collectRetainedAudioSets, collectRetainedOrbitIds, collectSceneIds, createEmptyScene,
  createHistorySnapshot, createProjectIdAllocator, createProjectIdAllocatorForScenes, createSpliceBars, deleteScene,
  durableSceneStructureToken, getRetainedAudioSets, nextDefaultSceneName, nextSceneTabIndex,
  planSceneDuplicate, reconcileSceneOrbitMix, renameScene, reorderScenes, replaceOrbitSpliceSettings,
  runActiveSceneTransition, runStagedDocumentTransaction, scenesHavePluginSlots, stageSceneDuplicate,
  updatePlanetForFreshRequest, updateSceneById, validateScenes,
  type RetainedAudioCache
} from "../src/renderer/state/scenes.ts";
import type { HistorySnapshot, PluginSlot } from "../src/renderer/state/types.ts";

const orbit = (id: string, extra: Partial<Orbit> = {}): Orbit => ({
  id, name: id, audioName: `${id}.wav`, x: 0, y: 0, radiusX: 100, radiusY: 100,
  initialRadiusX: 100, initialRadiusY: 100, audioDuration: 2, mode: "loop", volume: 1,
  audioPan: 0, isPaused: false, isMuted: false, isSolo: false, color: "#fff",
  sequenceRetriggerMode: "overlap", ...extra
});
const planet = (id: string, orbitId: string, extra: Partial<Planet> = {}): Planet => ({
  id, orbitId, angle: 0, speed: 1, volume: 1, audioPan: 0, pitchCents: 0,
  isActive: true, direction: 1, collisionSpeedMultiplier: 1, collisionFlashRemaining: 0,
  ...extra
});
const bar = (id: string, orbitId: string, extra: Partial<TriggerBar> = {}): TriggerBar => ({
  id, orbitId, angle: 0, lengthRadians: .1, startAngle: 0, kind: "play", source: "manual",
  ...extra
});
const scene = (extra: Partial<Scene> = {}): Scene => ({
  id: "scene-a", name: "Scene 1", orbits: [], planets: [], bars: [],
  viewport: { zoom: 1, offsetX: 0, offsetY: 0 },
  selection: { orbitId: null, planetId: null, barId: null },
  multiSelection: { orbitIds: [], planetIds: [] }, ...extra
});
const ids = (...values: string[]) => {
  let index = 0;
  return () => values[index++];
};

test("empty scenes have isolated defaults and default names fill the lowest gap", () => {
  const a = createEmptyScene("Scene 1", () => "a");
  const b = createEmptyScene("Scene 2", () => "b");
  a.multiSelection.orbitIds.push("changed");
  assert.deepEqual(b.multiSelection, { orbitIds: [], planetIds: [] });
  assert.equal(nextDefaultSceneName([{ name: "Scene 1" }, { name: "Custom" }, { name: "Scene 3" }]), "Scene 2");
});

test("scene updater preserves untouched references", () => {
  const a = scene();
  const b = scene({ id: "scene-b" });
  const next = updateSceneById([a, b], "scene-b", (current) => ({ ...current, name: "B" }));
  assert.equal(next[0], a);
  assert.notEqual(next[1], b);
});

test("scene rename trims, rejects blank/no-op, and permits duplicate names", () => {
  const a = scene({ name: "First" });
  const b = scene({ id: "scene-b", name: "Same" });
  const input = [a, b];
  assert.equal(renameScene(input, a.id, "   "), input);
  assert.equal(renameScene(input, a.id, " First "), input);
  const renamed = renameScene(input, a.id, " Same ");
  assert.deepEqual(renamed.map((item) => item.name), ["Same", "Same"]);
});

test("delete chooses next then previous and protects the final scene", () => {
  const a = scene({ id: "a" });
  const b = scene({ id: "b" });
  const c = scene({ id: "c" });
  const middle = deleteScene([a, b, c], "b", "b");
  assert.deepEqual(middle.scenes.map((item) => item.id), ["a", "c"]);
  assert.equal(middle.activeSceneId, "c");
  assert.equal(deleteScene([a, b], "b", "b").activeSceneId, "a");
  const final = deleteScene([a], "a", "a");
  assert.equal(final.scenes[0], a);
  assert.equal(final.activeSceneId, "a");
});

test("reorder moves once to the target position and reports no-op by reference", () => {
  const input = [scene({ id: "a" }), scene({ id: "b" }), scene({ id: "c" })];
  assert.equal(reorderScenes(input, "a", "a"), input);
  assert.deepEqual(reorderScenes(input, "a", "b").map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(reorderScenes(input, "c", "a").map((item) => item.id), ["c", "a", "b"]);
});

test("active scene transition stops sources exactly once and skips navigation no-ops", () => {
  const calls: string[] = [];
  const effects = {
    stopActivePlaybacks: () => calls.push("stop"),
    closeTransientUi: () => calls.push("close"),
    cancelInteractions: () => calls.push("cancel")
  };
  assert.equal(runActiveSceneTransition("a", "a", effects), false);
  assert.deepEqual(calls, []);
  assert.equal(runActiveSceneTransition("a", "b", effects), true);
  assert.deepEqual(calls, ["stop", "close", "cancel"]);
  calls.length = 0;
  assert.equal(runActiveSceneTransition("a", "a", effects, true), true);
  assert.deepEqual(calls, ["stop", "close", "cancel"]);
});

test("active scene designation happens synchronously before outgoing sources stop", () => {
  const calls: string[] = [];
  runActiveSceneTransition("a", "b", {
    designateAudibleScene: () => calls.push("designate:b"),
    stopActivePlaybacks: () => calls.push("stop"),
    closeTransientUi: () => calls.push("close"),
    cancelInteractions: () => calls.push("cancel")
  });
  assert.deepEqual(calls, ["designate:b", "stop", "close", "cancel"]);
});

test("history projection clears async and collision runtime state with structural sharing", () => {
  const stable = planet("stable", "orbit-a");
  const processing = planet("pending", "orbit-a", {
    pendingSpeed: 2, isSpeedProcessing: true, processingSpeed: 2,
    speedProcessRequestId: "request", speedProcessingError: "old",
    pendingPitchCents: 100, isPitchProcessing: true, processingPitchCents: 100,
    pitchProcessRequestId: "pitch", collisionSpeedMultiplier: 2, collisionFlashRemaining: 9
  });
  const input = scene({ orbits: [orbit("orbit-a")], planets: [stable, processing] });
  const snapshot = createHistorySnapshot([input], input.id, { volume: .5, pan: .25 });
  assert.equal(snapshot.scenes[0].planets[0], stable);
  assert.equal(snapshot.scenes[0].planets[1].speedProcessRequestId, undefined);
  assert.equal(snapshot.scenes[0].planets[1].isPitchProcessing, false);
  assert.equal(snapshot.scenes[0].planets[1].collisionSpeedMultiplier, 1);
  assert.equal(snapshot.scenes[0].planets[1].collisionFlashRemaining, 0);
});

test("history retention spans current, undo, and redo scenes", () => {
  const current = scene({ orbits: [orbit("current")] });
  const undoScene = scene({ id: "undo-scene", orbits: [orbit("undo")] });
  const redoScene = scene({ id: "redo-scene", orbits: [orbit("redo")] });
  const retained = collectRetainedOrbitIds(
    [current],
    [createHistorySnapshot([undoScene], undoScene.id, { volume: 1, pan: 0 })],
    [createHistorySnapshot([redoScene], redoScene.id, { volume: 1, pan: 0 })]
  );
  assert.deepEqual([...retained].sort(), ["current", "redo", "undo"]);
});

test("collectRetainedAudioSets skips the plugin-slot walk when no scene ever carried a plugin slot", () => {
  const withoutPlugins = [scene({ orbits: [orbit("a")] })];
  let walkCalls = 0;
  const spy = (scenes: readonly Scene[]) => {
    walkCalls++;
    return new Set(scenes.flatMap((item) => item.orbits.flatMap((o) => (o.plugins ?? []).map((p) => p.id))));
  };
  const sets = collectRetainedAudioSets(withoutPlugins, [], [], spy);
  assert.equal(walkCalls, 0, "the plugin-slot walk must not run when nothing has plugin slots");
  assert.deepEqual([...sets.pluginSlotIds], []);
  assert.deepEqual([...sets.orbitIds], ["a"]);
  assert.equal(scenesHavePluginSlots(withoutPlugins), false);

  const pluginSlot: PluginSlot = { id: "slot-a", catalogId: "cat", pluginVersion: "1", bypassed: false };
  const withPlugins = [scene({ orbits: [orbit("b", { plugins: [pluginSlot] })] })];
  const sets2 = collectRetainedAudioSets(withPlugins, [], [], spy);
  assert.equal(walkCalls, 1, "the plugin-slot walk must run once real plugin slots exist");
  assert.deepEqual([...sets2.pluginSlotIds], ["slot-a"]);
  assert.equal(scenesHavePluginSlots(withPlugins), true);
});

test("getRetainedAudioSets memoizes per revision and always matches a fresh computation across push/undo/redo/delete", () => {
  const pluginSlot: PluginSlot = { id: "slot-1", catalogId: "cat", pluginVersion: "1", bypassed: false };
  const sceneWithPlugin = scene({ id: "s1", orbits: [orbit("orbit-1", { plugins: [pluginSlot] })] });
  const sceneWithoutPlugin = scene({ id: "s1", orbits: [orbit("orbit-2")] });
  const master = { volume: 1, pan: 0 };
  const collectPluginSlotIds = (documentScenes: readonly Scene[]) =>
    new Set(documentScenes.flatMap((item) => item.orbits.flatMap((o) => (o.plugins ?? []).map((p) => p.id))));

  let revision = 0;
  let cache: RetainedAudioCache = null;
  const undo: HistorySnapshot[] = [];
  const redo: HistorySnapshot[] = [];

  function assertMatchesFresh(currentScenes: readonly Scene[]) {
    const memoized = getRetainedAudioSets(currentScenes, undo, redo, revision, cache, collectPluginSlotIds);
    cache = memoized.cache;
    const fresh = collectRetainedAudioSets(currentScenes, undo, redo, collectPluginSlotIds);
    assert.deepEqual([...memoized.sets.orbitIds].sort(), [...fresh.orbitIds].sort());
    assert.deepEqual([...memoized.sets.pluginSlotIds].sort(), [...fresh.pluginSlotIds].sort());
    return memoized;
  }

  // pushHistory: push a snapshot and bump the revision, mirroring App.tsx's pushHistory/commitSceneDocument.
  undo.push(createHistorySnapshot([sceneWithPlugin], "s1", master));
  revision++;
  let currentScenes: readonly Scene[] = [sceneWithoutPlugin];
  const first = assertMatchesFresh(currentScenes);

  // Same revision and the same scenes reference must hit the cache: identical Set instances, no recomputation.
  const repeat = getRetainedAudioSets(currentScenes, undo, redo, revision, cache, collectPluginSlotIds);
  assert.equal(repeat.sets, first.sets, "unchanged revision and scenes must reuse the cached result object");
  assert.equal(repeat.sets.orbitIds, first.sets.orbitIds);
  assert.equal(repeat.sets.pluginSlotIds, first.sets.pluginSlotIds);

  // undo(): pop undo, push redo, bump revision.
  const popped = undo.pop()!;
  redo.push(createHistorySnapshot(currentScenes as Scene[], "s1", master));
  revision++;
  currentScenes = popped.scenes;
  assertMatchesFresh(currentScenes);

  // redo(): pop redo, push undo, bump revision.
  const redone = redo.pop()!;
  undo.push(createHistorySnapshot(currentScenes as Scene[], "s1", master));
  revision++;
  currentScenes = redone.scenes;
  assertMatchesFresh(currentScenes);

  // delete (pushHistory-equivalent): push a snapshot, drop the plugin-carrying orbit, bump revision.
  undo.push(createHistorySnapshot(currentScenes as Scene[], "s1", master));
  revision++;
  currentScenes = [scene({ id: "s1", orbits: [] })];
  assertMatchesFresh(currentScenes);
});

test("project ID allocation excludes history, retries collisions, and never reuses issued tombstones", () => {
  const current = scene({ id: "current", orbits: [orbit("orbit-a", { spliceCount: 2 })] });
  const old = scene({ id: "old", orbits: [orbit("old-orbit")] });
  const history = createHistorySnapshot([old], old.id, { volume: 1, pan: 0 });
  const reserved = collectHistoryProjectIds([current], [history]);
  const allocator = createProjectIdAllocator(reserved, ids("old-orbit", "orbit-a:splice:0", "fresh", "fresh", "later"));
  assert.equal(allocator.next(), "fresh");
  assert.equal(allocator.next(), "later");
  assert.deepEqual([...allocator.issued()], ["fresh", "later"]);
});

test("orbit ID allocation atomically reserves implied IDs against tombstones", () => {
  const allocator = createProjectIdAllocator([], ids(
    "bad:splice:0", // Establish a durable tombstone in the derived namespace.
    "bad",          // Rejected because its implied ID is tombstoned.
    "good",         // Accepted together with good:splice:0.
    "good:splice:0", "ordinary" // Ordinary allocation must skip the reservation.
  ));
  assert.equal(allocator.next(), "bad:splice:0");
  assert.equal(allocator.nextWithReservations((candidate) => [`${candidate}:splice:0`]), "good");
  assert.equal(allocator.next(), "ordinary");
  assert.deepEqual([...allocator.issued()], ["bad:splice:0", "good", "ordinary"]);
  assert.equal(allocator.issued().has("bad"), false, "a rejected candidate must not leak into tombstones");
});

test("derived splice ownership supports same-orbit re-expansion and rejects foreign provenance atomically", () => {
  const sameOwner = createProjectIdAllocator();
  sameOwner.reserveDerived("o", ["o:splice:0", "o:splice:1"]);
  sameOwner.reserveDerived("o", []); // Shrink does not surrender deterministic ownership.
  assert.doesNotThrow(() => sameOwner.reserveDerived("o", ["o:splice:0", "o:splice:1"]));
  assert.throws(() => sameOwner.reserveDerived("other", ["o:splice:0"]), /already reserved/);

  const manualTombstone = createProjectIdAllocator([], ids("o:splice:0", "free"));
  assert.equal(manualTombstone.next(), "o:splice:0");
  const unchanged = scene({ orbits: [orbit("o")] });
  const proposed = replaceOrbitSpliceSettings([unchanged], unchanged.id, "o", 2, 0);
  assert.throws(() => manualTombstone.reserveDerived("o", ["o:splice:0"]), /already reserved/);
  assert.equal(unchanged.orbits[0].spliceCount, undefined);
  assert.notEqual(proposed, unchanged);

  const noPartialLeak = createProjectIdAllocator([], ids("fresh-derived"));
  noPartialLeak.reserve(["occupied"]);
  assert.throws(() => noPartialLeak.reserveDerived("o", ["fresh-derived", "occupied"]), /already reserved/);
  assert.equal(noPartialLeak.next(), "fresh-derived");
});

test("opened documents preflight an isolated allocator session before any staged side effect", async () => {
  const loadedOrbit = orbit("loaded", { spliceCount: 2 });
  const loaded = scene({ id: "loaded-scene", orbits: [loadedOrbit], bars: createSpliceBars(loadedOrbit) });
  const allocator = createProjectIdAllocatorForScenes(
    [loaded], ids("loaded", "loaded:splice:0", "fresh")
  );
  assert.equal(allocator.next(), "fresh");

  let staged = false;
  const liveDocument = [scene({ id: "live" })];
  const liveAudio = ["live-audio"];
  const invalid = scene({
    id: "candidate", orbits: [orbit("o", { spliceCount: 2 })],
    bars: [bar("o:splice:0", "o")]
  });
  assert.throws(() => createProjectIdAllocatorForScenes([invalid]), /already reserved/);
  assert.equal(staged, false);
  assert.equal(liveDocument[0].id, "live");
  assert.deepEqual(liveAudio, ["live-audio"]);

  const oldSession = createProjectIdAllocator([], () => "old-tombstone");
  assert.equal(oldSession.next(), "old-tombstone");
  const newSession = createProjectIdAllocatorForScenes([loaded], () => "old-tombstone");
  assert.equal(newSession.next(), "old-tombstone", "opening starts a fresh tombstone session");
});

test("durable scene token ignores simulation and transient UI but detects incompatible edits", () => {
  const base = scene({ orbits: [orbit("o")], planets: [planet("p", "o")] });
  const simulation = {
    ...base,
    planets: [{ ...base.planets[0], angle: 2, direction: -1, collisionFlashRemaining: 8, collisionSpeedMultiplier: 3 }],
    viewport: { zoom: 2, offsetX: 10, offsetY: 20 },
    selection: { orbitId: "o", planetId: "p", barId: null }
  };
  assert.equal(durableSceneStructureToken(simulation), durableSceneStructureToken(base));
  assert.notEqual(durableSceneStructureToken({
    ...base, orbits: [{ ...base.orbits[0], volume: .5 }]
  }), durableSceneStructureToken(base));
  assert.notEqual(durableSceneStructureToken({
    ...base, planets: [{ ...base.planets[0], speed: 2 }]
  }), durableSceneStructureToken(base));
});

test("mixer reconciliation covers inactive scenes", () => {
  const calls: string[] = [];
  reconcileSceneOrbitMix([
    scene({ orbits: [orbit("a", { volume: .2, audioPan: -.5 })] }),
    scene({ id: "b", orbits: [orbit("b", { volume: .8, audioPan: .5 })] })
  ], (id, volume, pan) => calls.push(`${id}:${volume}:${pan}`));
  assert.deepEqual(calls, ["a:0.2:-0.5", "b:0.8:0.5"]);
});

test("staged document transaction does not publish on stage or commit failure", async () => {
  const calls: string[] = [];
  await assert.rejects(runStagedDocumentTransaction({
    stage: async () => { throw new Error("decode"); },
    commit: () => calls.push("commit"), publish: () => calls.push("publish")
  }), /decode/);
  assert.deepEqual(calls, []);
  await assert.rejects(runStagedDocumentTransaction({
    stage: async () => "staged",
    commit: () => { calls.push("commit"); throw new Error("install"); },
    rollback: (value) => calls.push(`rollback:${value}`),
    publish: () => calls.push("publish")
  }), /install/);
  assert.deepEqual(calls, ["commit", "rollback:staged"]);
  calls.length = 0;
  await runStagedDocumentTransaction({
    stage: async () => "same-target-id", commit: (value) => calls.push(`commit:${value}`),
    publish: () => calls.push("publish")
  });
  assert.deepEqual(calls, ["commit:same-target-id", "publish"]);
});

test("tab keyboard navigation wraps and supports boundaries", () => {
  assert.equal(nextSceneTabIndex(0, 3, "ArrowLeft"), 2);
  assert.equal(nextSceneTabIndex(2, 3, "ArrowRight"), 0);
  assert.equal(nextSceneTabIndex(1, 3, "Home"), 0);
  assert.equal(nextSceneTabIndex(1, 3, "End"), 2);
});

test("async request results target the captured scene and ignore stale success or failure", () => {
  const a = scene({
    planets: [planet("p", "o", { speedProcessRequestId: "new", isSpeedProcessing: true })],
    orbits: [orbit("o")]
  });
  const b = scene({ id: "scene-b", orbits: [orbit("other")], planets: [planet("q", "other")] });
  const input = [a, b];
  const stale = updatePlanetForFreshRequest(input, a.id, "p", "speed", "old", (item) => ({ ...item, speed: 3 }));
  assert.equal(stale, input);
  assert.equal(stale[0].planets[0].speed, 1);
  assert.equal(stale[1], b);
  const applied = updatePlanetForFreshRequest(stale, a.id, "p", "speed", "new", (item) => ({ ...item, speed: 2 }));
  assert.equal(applied[0].planets[0].speed, 2);
  assert.equal(applied[1], b);
});

test("validation rejects cross-kind duplicates, cross-scene references, and reserved splice collisions", () => {
  const duplicate = scene({ id: "same", orbits: [orbit("same")] });
  assert.equal(validateScenes([duplicate]).ok, false);

  const broken = scene({ orbits: [orbit("a")], planets: [planet("p", "elsewhere")] });
  assert.equal(validateScenes([broken]).ok, false);

  const reserved = scene({
    orbits: [orbit("a", { spliceCount: 4 })],
    bars: [bar("a:splice:0", "a")]
  });
  const result = validateScenes([reserved]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(" "), /Reserved ID/);
});

test("splice settings regenerate stable IDs and reject a complete-document collision atomically", () => {
  const source = scene({ orbits: [orbit("a", { spliceCount: 4 })] });
  const generated = replaceOrbitSpliceSettings([source], source.id, "a", 4, 1)[0];
  assert.deepEqual(generated.bars.map((item) => item.id), ["a:splice:0", "a:splice:1"]);
  const regenerated = replaceOrbitSpliceSettings([generated], source.id, "a", 4, 2)[0];
  assert.deepEqual(regenerated.bars.map((item) => item.id), ["a:splice:0", "a:splice:1"]);

  const collision = scene({ orbits: [orbit("a")], bars: [bar("a:splice:0", "a")] });
  assert.throws(() => replaceOrbitSpliceSettings([collision], collision.id, "a", 2, 0), /Reserved ID/);
  assert.equal(collision.orbits[0].spliceCount, undefined);
});

test("duplicate remaps all IDs and references, regenerates splice bars, and clears transients", () => {
  const sourceOrbit = orbit("o", { spliceCount: 2 });
  const source = scene({
    orbits: [sourceOrbit],
    planets: [planet("p", "o", { isSpeedProcessing: true, speedProcessRequestId: "r" })],
    bars: [bar("m", "o"), ...createSpliceBars(sourceOrbit)],
    selection: { orbitId: "o", planetId: "p", barId: "m" },
    multiSelection: { orbitIds: ["o"], planetIds: ["p"] }
  });
  const plan = planSceneDuplicate(source, { createId: ids("s2", "o2", "p2", "m2") });
  assert.equal(plan.scene.planets[0].orbitId, "o2");
  assert.equal(plan.scene.bars.find((item) => item.source === "manual")?.orbitId, "o2");
  assert.equal(plan.scene.bars.find((item) => item.source === "splice")?.id, "o2:splice:0");
  assert.deepEqual(plan.scene.selection, { orbitId: "o2", planetId: "p2", barId: "m2" });
  assert.deepEqual(plan.scene.multiSelection, { orbitIds: ["o2"], planetIds: ["p2"] });
  assert.equal(plan.scene.planets[0].speedProcessRequestId, undefined);
  assert.equal(validateScenes([source, plan.scene]).ok, true);
  assert.equal(collectSceneIds([source, plan.scene]).size, 10);
});

test("scene duplication gives every WAM slot a fresh globally reserved ID and explicit state map", () => {
  const source = scene({ orbits: [orbit("o", { plugins: [
    { id: "slot-a", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false },
    { id: "slot-b", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: true }
  ] })] });
  const plan = planSceneDuplicate(source, {
    createId: ids("scene-copy", "orbit-copy"),
    createPluginSlotId: ids("slot-copy-a", "slot-copy-b"),
    occupiedIds: ["history-slot"]
  });
  assert.deepEqual(plan.scene.orbits[0].plugins?.map((slot) => slot.id), ["slot-copy-a", "slot-copy-b"]);
  assert.deepEqual([...plan.pluginSlotIdMap], [["slot-a", "slot-copy-a"], ["slot-b", "slot-copy-b"]]);
  assert.equal(collectHistoryProjectIds([source, plan.scene]).has("slot-copy-a"), true);
  const allocator = createProjectIdAllocatorForScenes([source, plan.scene], ids("slot-copy-a", "fresh"));
  assert.equal(allocator.next(), "fresh", "slot IDs reserve the same project namespace as entity IDs");
});

test("duplicate remaps a selected derived splice bar to its regenerated counterpart", () => {
  const sourceOrbit = orbit("o", { spliceCount: 2 });
  const source = scene({
    orbits: [sourceOrbit],
    bars: createSpliceBars(sourceOrbit),
    selection: { orbitId: "o", planetId: null, barId: "o:splice:0" }
  });
  const plan = planSceneDuplicate(source, { createId: ids("s2", "o2") });
  assert.equal(plan.scene.selection.barId, "o2:splice:0");
});

test("duplicate retries an orbit candidate whose implied splice ID is occupied", () => {
  const sourceOrbit = orbit("o", { spliceCount: 2 });
  const source = scene({ orbits: [sourceOrbit], bars: createSpliceBars(sourceOrbit) });
  const plan = planSceneDuplicate(source, {
    occupiedIds: ["bad:splice:0"],
    createId: ids("s2", "bad", "good")
  });
  assert.equal(plan.scene.orbits[0].id, "good");
  assert.equal(plan.scene.bars[0].id, "good:splice:0");
});

test("audio staging skips missing audio and rolls back completed copies on failure", async () => {
  const source = scene({ orbits: [orbit("one"), orbit("missing", { isMissingAudio: true }), orbit("two")] });
  const plan = planSceneDuplicate(source, { createId: ids("s2", "one2", "missing2", "two2") });
  const staged: string[] = [];
  const rolledBack: string[] = [];
  await assert.rejects(stageSceneDuplicate(source, plan, {
    stage: (_source, target) => {
      if (target === "two2") throw new Error("copy failed");
      staged.push(target);
    },
    rollback: (target) => { rolledBack.push(target); }
  }), /copy failed/);
  assert.deepEqual(staged, ["one2"]);
  // The failing target is also rolled back because a staging implementation may
  // throw after it has created a partial runtime entry.
  assert.deepEqual(rolledBack, ["two2", "one2"]);
});
