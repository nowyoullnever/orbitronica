import assert from "node:assert/strict";
import test from "node:test";
import { parseProject, serializeProject, validateJsonValue } from "../src/renderer/project/projectSerializer.ts";
import { createSpliceBars } from "../src/renderer/state/scenes.ts";
import type { Orbit, Planet, Scene, TriggerBar } from "../src/renderer/state/types.ts";

const orbit = (id: string, extra: Partial<Orbit> = {}): Orbit => ({
  id, name: id, audioName: `${id}.wav`, x: 0, y: 0, radiusX: 100, radiusY: 80,
  initialRadiusX: 100, initialRadiusY: 80, audioDuration: 2, mode: "loop", volume: 1,
  audioPan: 0, isPaused: false, isMuted: false, isSolo: false, color: "#000",
  sequenceRetriggerMode: "overlap", ...extra
});
const planet = (id: string, orbitId: string, extra: Partial<Planet> = {}): Planet => ({
  id, orbitId, angle: .5, speed: 1, volume: 1, audioPan: 0, pitchCents: 0,
  isActive: true, direction: 1, collisionSpeedMultiplier: 1, collisionFlashRemaining: 0,
  ...extra
});
const bar = (id: string, orbitId: string, extra: Partial<TriggerBar> = {}): TriggerBar => ({
  id, orbitId, angle: 0, lengthRadians: 1, startAngle: 0, kind: "play", source: "manual", ...extra
});
const scene = (id: string, extra: Partial<Scene> = {}): Scene => ({
  id, name: id, orbits: [], planets: [], bars: [], viewport: { zoom: 1, offsetX: 0, offsetY: 0 },
  selection: { orbitId: null, planetId: null, barId: null },
  multiSelection: { orbitIds: [], planetIds: [] }, ...extra
});

test("v6 round-trip preserves every scene and active document state", () => {
  const loop = orbit("loop", { spliceCount: 2, showWaveform: false });
  const first = scene("first", {
    name: "Intro", orbits: [loop],
    planets: [planet("p", "loop", {
      pendingSpeed: 2, isSpeedProcessing: true, speedProcessRequestId: "request",
      collisionSpeedMultiplier: 3, collisionFlashRemaining: 12
    })],
    bars: [bar("manual", "loop"), ...createSpliceBars(loop)],
    viewport: { zoom: 2, offsetX: 30, offsetY: -40 },
    selection: { orbitId: "loop", planetId: null, barId: "loop:splice:0" },
    multiSelection: { orbitIds: ["loop"], planetIds: ["p"] }
  });
  const second = scene("second", { name: "Outro" });
  const serialized = serializeProject("mix", [first, second], second.id, .25, { volume: .4, pan: -.25 });

  assert.equal(serialized.schemaVersion, 6);
  assert.equal(serialized.appName, "Orbitronica");
  assert.deepEqual(serialized.scenes[0].bars.map((item) => item.id), ["manual"]);
  assert.equal("multiSelection" in serialized.scenes[0], false);
  assert.equal("speedProcessRequestId" in serialized.scenes[0].planets[0], false);
  assert.equal("collisionFlashRemaining" in serialized.scenes[0].planets[0], false);

  const parsed = parseProject(JSON.stringify(serialized));
  assert.equal(parsed.activeSceneId, "second");
  assert.deepEqual(parsed.scenes.map((item) => item.name), ["Intro", "Outro"]);
  assert.deepEqual(parsed.scenes[0].viewport, { zoom: 2, offsetX: 30, offsetY: -40 });
  assert.deepEqual(parsed.scenes[0].selection, { orbitId: "loop", planetId: null, barId: "loop:splice:0" });
  assert.deepEqual(parsed.scenes[0].multiSelection, { orbitIds: [], planetIds: [] });
  assert.deepEqual(parsed.scenes[0].bars.map((item) => item.id), ["manual", "loop:splice:0"]);
  assert.equal(parsed.scenes[0].planets[0].speedProcessRequestId, undefined);
  assert.equal(parsed.scenes[0].planets[0].collisionSpeedMultiplier, 1);
  assert.equal(parsed.scenes[0].planets[0].collisionFlashRemaining, 0);
  assert.deepEqual(parsed.master, { volume: .4, pan: -.25 });
  assert.equal(parsed.lastLoopBarLengthRadians, .25);
});

test("v4 and unversioned projects migrate to one normalized scene", () => {
  const legacy = {
    schemaVersion: 4,
    projectName: "Legacy",
    orbits: [orbit("o", { spliceCount: 2 })],
    planets: [{ ...planet("p", "o"), audioPan: undefined }],
    bars: [bar("manual", "o"), { ...bar("o:splice:0", "o"), source: "splice" }],
    ui: { orbitId: "o", planetId: null, barId: null },
    master: { volume: 5, pan: -5 }
  };
  const migrated = parseProject(JSON.stringify(legacy), () => "migrated-scene");
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.scenes.length, 1);
  assert.equal(migrated.scenes[0].id, "migrated-scene");
  assert.equal(migrated.scenes[0].name, "Scene 1");
  assert.deepEqual(migrated.scenes[0].viewport, { zoom: 1, offsetX: 0, offsetY: 0 });
  assert.deepEqual(migrated.scenes[0].selection, legacy.ui);
  assert.deepEqual(migrated.scenes[0].bars.map((item) => item.id), ["manual", "o:splice:0"]);
  assert.equal(migrated.scenes[0].planets[0].audioPan, 0);
  assert.deepEqual(migrated.master, { volume: 1, pan: -1 });

  const unversioned = { ...legacy } as Record<string, unknown>;
  delete unversioned.schemaVersion;
  assert.equal(parseProject(JSON.stringify(unversioned), () => "legacy-scene").scenes[0].id, "legacy-scene");
});

test("v2, v3, v4, and unversioned legacy documents normalize into reopenable v5", () => {
  for (const schemaVersion of [undefined, 2, 3, 4]) {
    const legacy = {
      ...(schemaVersion === undefined ? {} : { schemaVersion }), projectName: "Historical",
      orbits: [orbit("o", { volume: 3, audioPan: -3, spliceCount: 99, spliceStartAngle: -1 })],
      planets: [planet("p", "o", { angle: -1, speed: 12, volume: 3, audioPan: -4, pitchCents: 5000 })],
      bars: [bar("b", "o", { angle: -1, startAngle: 99, lengthRadians: 99 })]
    };
    const migrated = parseProject(JSON.stringify(legacy), () => `scene-${schemaVersion ?? "old"}`);
    const reopened = parseProject(JSON.stringify(serializeProject(
      migrated.projectName, migrated.scenes, migrated.activeSceneId,
      migrated.lastLoopBarLengthRadians, migrated.master
    )));
    assert.equal(reopened.scenes[0].orbits[0].volume, 1);
    assert.equal(reopened.scenes[0].planets[0].speed, 8);
    assert.equal(reopened.scenes[0].planets[0].pitchCents, 4800);
  }
});

test("legacy malformed optional fields are repaired before the migrated document is reopened", () => {
  const legacy = {
    schemaVersion: 4,
    orbits: [{
      ...orbit("o"), audioPath: 42, isMissingAudio: "yes", showWaveform: "no",
      sampleStart: "start", sampleEnd: "end", spliceCount: "many", spliceStartAngle: "left"
    }],
    planets: [{ ...planet("p", "o"), isActive: "sometimes" }],
    bars: [bar("b", "o")]
  };
  const migrated = parseProject(JSON.stringify(legacy), () => "scene");
  const reopened = parseProject(JSON.stringify(serializeProject(
    migrated.projectName, migrated.scenes, migrated.activeSceneId,
    migrated.lastLoopBarLengthRadians, migrated.master
  )));

  const reopenedOrbit = reopened.scenes[0].orbits[0];
  assert.equal(reopenedOrbit.audioPath, undefined);
  assert.equal(reopenedOrbit.isMissingAudio, undefined);
  assert.equal(reopenedOrbit.showWaveform, undefined);
  assert.equal(reopenedOrbit.spliceCount, 0);
  assert.equal(reopened.scenes[0].planets[0].isActive, true);
});

test("serialization closes runtime numeric domains while native v5 remains strict", () => {
  const unstable = scene("s", {
    orbits: [orbit("o", { volume: 4, audioPan: -4, spliceStartAngle: -1 })],
    planets: [planet("p", "o", { angle: -1, speed: 12, pitchCents: 5000 })],
    bars: [bar("b", "o", { angle: -1, lengthRadians: 99, startAngle: -1 })]
  });
  const serialized = serializeProject("x", [unstable], "s", 99, { volume: 3, pan: -3 });
  assert.doesNotThrow(() => parseProject(JSON.stringify(serialized)));
  assert.equal(serialized.scenes[0].planets[0].speed, 8);
  assert.equal(serialized.scenes[0].planets[0].pitchCents, 4800);
});

test("empty v5 scenes repair and invalid active/selection state falls back safely", () => {
  const empty = parseProject(JSON.stringify({
    schemaVersion: 5, appName: "Orbitonic", scenes: [], activeSceneId: "missing"
  }), () => "fresh");
  assert.equal(empty.scenes.length, 1);
  assert.equal(empty.activeSceneId, "fresh");

  const input = serializeProject("test", [scene("s", {
    viewport: { zoom: Number.POSITIVE_INFINITY, offsetX: Number.NaN, offsetY: 2 },
    selection: { orbitId: "stale", planetId: null, barId: null }
  })], "s", 1, { volume: 1, pan: 0 });
  input.activeSceneId = "missing";
  const repaired = parseProject(JSON.stringify(input));
  assert.equal(repaired.activeSceneId, "s");
  assert.deepEqual(repaired.scenes[0].selection, { orbitId: null, planetId: null, barId: null });
  assert.deepEqual(repaired.scenes[0].viewport, { zoom: 1, offsetX: 0, offsetY: 2 });
});

test("v5 rejects cross-kind duplicates, same-scene broken refs, and reserved splice collisions", () => {
  const duplicate = serializeProject("x", [scene("same", { orbits: [orbit("same")] })], "same", 1, { volume: 1, pan: 0 });
  assert.throws(() => parseProject(JSON.stringify(duplicate)), /Duplicate ID/);

  const broken = serializeProject("x", [scene("s", { planets: [planet("p", "elsewhere")] })], "s", 1, { volume: 1, pan: 0 });
  assert.throws(() => parseProject(JSON.stringify(broken)), /outside its scene/);

  const reserved = serializeProject("x", [scene("s", {
    orbits: [orbit("o", { spliceCount: 2 })], bars: [bar("o:splice:0", "o")]
  })], "s", 1, { volume: 1, pan: 0 });
  assert.throws(() => parseProject(JSON.stringify(reserved)), /Reserved ID/);
});

test("v4 migration also rejects a persisted ID occupying an implied splice reservation", () => {
  const legacy = {
    schemaVersion: 4,
    orbits: [orbit("o", { spliceCount: 2 })], planets: [], bars: [bar("o:splice:0", "o")]
  };
  assert.throws(() => parseProject(JSON.stringify(legacy), () => "scene"), /Reserved ID/);
});

test("unsupported future versions and malformed shapes fail clearly", () => {
  assert.throws(() => parseProject(JSON.stringify({ schemaVersion: 7 })), /Unsupported Orbitronica schema version 7/);
  assert.throws(() => parseProject(JSON.stringify({
    schemaVersion: 5, appName: "Orbitonic", scenes: {}
  })), /require a scenes array/);
  assert.throws(() => parseProject("not json"), /JSON could not be parsed/);
});

test("v6 keeps slot metadata in scenes and only current slot JSON state in the external store", () => {
  const source = scene("s", { orbits: [orbit("o", {
    plugins: [{ id: "slot", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false }]
  })] });
  const encoded = serializeProject("plugins", [source], "s", 1, { volume: 1, pan: 0 }, new Map([
    ["slot", { delay: .5, nested: [true, null] }]
  ]));
  assert.deepEqual(encoded.pluginStates, { slot: { delay: .5, nested: [true, null] } });
  assert.equal("state" in encoded.scenes[0].orbits[0].plugins![0], false);
  const decoded = parseProject(JSON.stringify(encoded));
  assert.deepEqual(decoded.pluginStates, encoded.pluginStates);
  const malformed = structuredClone(encoded) as any;
  malformed.pluginStates.unknown = {};
  assert.throws(() => parseProject(JSON.stringify(malformed)), /unknown slot/);
});

test("v6 rejects unsafe or oversized plugin state while v5 migrates with an empty store", () => {
  const legacy = serializeProject("old", [scene("s")], "s", 1, { volume: 1, pan: 0 });
  const v5 = { ...legacy, schemaVersion: 5 as const, appName: "Orbitonic" as const } as any;
  delete v5.pluginStates;
  const migrated = parseProject(JSON.stringify(v5));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.pluginStates, {});
  assert.throws(() => validateJsonValue({ nope: Infinity }), /non-finite/);
  assert.throws(() => validateJsonValue(() => undefined), /JSON-safe/);
});

test("v5 strictly rejects malformed durable entity fields and enums", () => {
  const valid = serializeProject("x", [scene("s", {
    orbits: [orbit("o")], planets: [planet("p", "o")], bars: [bar("b", "o")]
  })], "s", 1, { volume: 1, pan: 0 });
  const malformed = (change: (copy: any) => void) => {
    const copy = structuredClone(valid);
    change(copy);
    return JSON.stringify(copy);
  };
  assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].orbits[0].radiusX = "wide"; })), /radiusX/);
  assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].orbits[0].mode = "oneshot"; })), /mode/);
  assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].planets[0].direction = 0; })), /direction/);
  assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].bars[0].kind = "pause"; })), /kind/);
  assert.throws(() => parseProject(malformed((copy) => { delete copy.scenes[0].viewport.zoom; })), /viewport/);
  for (const [field, value] of [
    ["audioPath", 42], ["isMissingAudio", "yes"], ["showWaveform", "yes"],
    ["sampleStart", "start"], ["sampleEnd", "end"], ["spliceCount", "many"], ["spliceStartAngle", "left"]
  ] as const) {
    assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].orbits[0][field] = value; })),
      new RegExp(field));
  }
  for (const [field, value] of [
    ["radiusX", 0], ["initialRadiusY", -1], ["audioDuration", -1], ["volume", 1.1],
    ["audioPan", -1.1], ["sampleStart", -1], ["sampleEnd", 3], ["spliceCount", 3],
    ["spliceStartAngle", Math.PI * 2]
  ] as const) {
    assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].orbits[0][field] = value; })),
      new RegExp(field));
  }
  for (const [field, value] of [
    ["angle", -1], ["speed", 0], ["volume", -0.1], ["audioPan", 2], ["pitchCents", 5000]
  ] as const) {
    assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].planets[0][field] = value; })),
      new RegExp(field));
  }
  for (const [field, value] of [
    ["angle", Math.PI * 2], ["startAngle", -1], ["lengthRadians", 0], ["startTime", -1]
  ] as const) {
    assert.throws(() => parseProject(malformed((copy) => { copy.scenes[0].bars[0][field] = value; })),
      new RegExp(field));
  }
});
