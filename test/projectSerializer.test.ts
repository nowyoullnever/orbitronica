import assert from "node:assert/strict";
import test from "node:test";
import { parseProject, serializeProject } from "../src/renderer/project/projectSerializer.ts";
import type { Orbit } from "../src/renderer/state/types.ts";

const selection = { orbitId: null, planetId: null, barId: null };

test("persists only manual bars because splice bars are derived", () => {
  const project = serializeProject("test", [], [], [
    { id: "manual", orbitId: "orbit", angle: 0, lengthRadians: 1, startAngle: 0, kind: "play" },
    { id: "splice", orbitId: "orbit", angle: 1, lengthRadians: 1, startAngle: 1, kind: "play", source: "splice" }
  ], 1, selection, { volume: 1, pan: 0 });

  assert.deepEqual(project.bars.map((bar) => bar.id), ["manual"]);
});

test("round-trips master mix and waveform visibility", () => {
  const orbit: Orbit = {
    id: "orbit", name: "Orbit", audioName: "sample.wav", x: 10, y: 20,
    radiusX: 100, radiusY: 80, initialRadiusX: 100, initialRadiusY: 80,
    audioDuration: 2, mode: "loop", volume: 1, isPaused: false, isMuted: false,
    isSolo: false, color: "#000", sequenceRetriggerMode: "overlap", showWaveform: false
  };
  const serialized = serializeProject("mix", [orbit, { ...orbit, id: "legacy", showWaveform: undefined }], [], [],
    1, selection, { volume: .4, pan: -.25 });
  const parsed = parseProject(JSON.stringify(serialized));

  assert.equal(parsed.schemaVersion, 4);
  assert.deepEqual(parsed.master, { volume: .4, pan: -.25 });
  assert.equal(parsed.orbits[0].showWaveform, false);
  assert.equal(parsed.orbits[1].showWaveform, undefined);
});

test("defaults and normalizes master mix from older or malformed projects", () => {
  const base = { orbits: [], planets: [], bars: [] };
  assert.deepEqual(parseProject(JSON.stringify(base)).master, { volume: 1, pan: 0 });
  assert.deepEqual(parseProject(JSON.stringify({
    ...base, master: { volume: 5, pan: -5 }
  })).master, { volume: 1, pan: -1 });
  assert.deepEqual(parseProject(JSON.stringify({
    ...base, master: { volume: "invalid", pan: null }
  })).master, { volume: 1, pan: 0 });
});
