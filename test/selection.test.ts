import assert from "node:assert/strict";
import test from "node:test";
import type { Orbit, Planet } from "../src/renderer/state/types.ts";
import {
  clearSelectionState, collectMarqueeSelection, selectMultipleState, selectSingleState
} from "../src/renderer/utils/selection.ts";

const orbit = (id: string, x: number): Orbit => ({
  id, name: id, audioName: `${id}.wav`, x, y: 100, radiusX: 30, radiusY: 20,
  initialRadiusX: 30, initialRadiusY: 20, audioDuration: 1, mode: "loop", volume: 1,
  isPaused: false, isMuted: false, isSolo: false, color: "#000", sequenceRetriggerMode: "overlap"
});
const planet = (id: string, orbitId: string, angle: number): Planet => ({
  id, orbitId, angle, speed: 1, volume: 1, pitchCents: 0, isActive: true, direction: 1,
  collisionSpeedMultiplier: 1, collisionFlashRemaining: 0
});

test("selection transitions keep single and multiple selection mutually exclusive", () => {
  assert.deepEqual(selectSingleState({ orbitId: "a", planetId: null, barId: null }), {
    selection: { orbitId: "a", planetId: null, barId: null },
    multiSelection: { orbitIds: [], planetIds: [] }
  });
  assert.deepEqual(selectMultipleState(["a"], ["p"]), {
    selection: { orbitId: null, planetId: null, barId: null },
    multiSelection: { orbitIds: ["a"], planetIds: ["p"] }
  });
  assert.deepEqual(clearSelectionState(), {
    selection: { orbitId: null, planetId: null, barId: null },
    multiSelection: { orbitIds: [], planetIds: [] }
  });
});

test("marquee selection handles reverse bounds and missing parent orbits", () => {
  const orbits = [orbit("inside", 100), orbit("outside", 200)];
  const planets = [
    planet("inside-planet", "inside", 0),
    planet("outside-planet", "outside", 0),
    planet("orphan", "missing", 0)
  ];
  const selected = collectMarqueeSelection(orbits, planets, { sx: 150, sy: 130, x: 60, y: 70 });

  assert.deepEqual(selected, { orbitIds: ["inside"], planetIds: ["inside-planet"] });
});

test("an empty marquee selects nothing", () => {
  assert.deepEqual(collectMarqueeSelection([orbit("a", 100)], [planet("p", "a", 0)], {
    sx: 0, sy: 0, x: 0, y: 0
  }), { orbitIds: [], planetIds: [] });
});
