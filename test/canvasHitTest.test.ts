// Characterization tests for the pure hit-test math extracted from CanvasStage's
// hitTestCanvas (src/renderer/utils/canvasHitTest.ts). Pins the priority order (planet >
// bar edge > bar body > orbit line > orbit interior > empty) and the zoom-scaled hit radii.
import assert from "node:assert/strict";
import test from "node:test";
import { hitTestCanvas, PLANET_STROKE_WIDTH } from "../src/renderer/utils/canvasHitTest.ts";
import { PLANET_RADIUS } from "../src/renderer/state/physics.ts";
import { TAU } from "../src/renderer/utils/geometry.ts";
import type { Orbit, Planet, TriggerBar } from "../src/renderer/state/types.ts";

function makeOrbit(overrides: Partial<Orbit> = {}): Orbit {
  return {
    id: "orbit-1", name: "Orbit 1", audioName: "sample.wav",
    x: 0, y: 0, radiusX: 100, radiusY: 100, initialRadiusX: 100, initialRadiusY: 100,
    audioDuration: TAU, mode: "loop", volume: 1, audioPan: 0,
    isPaused: false, isMuted: false, isSolo: false, color: "#ffffff",
    sequenceRetriggerMode: "overlap",
    ...overrides
  };
}

function makePlanet(overrides: Partial<Planet> = {}): Planet {
  return {
    id: "planet-1", orbitId: "orbit-1", angle: 0, speed: 1, volume: 1, audioPan: 0,
    pitchCents: 0, isActive: true, direction: 1, collisionSpeedMultiplier: 1,
    collisionFlashRemaining: 0,
    ...overrides
  };
}

function makeBar(overrides: Partial<TriggerBar> = {}): TriggerBar {
  return {
    id: "bar-1", orbitId: "orbit-1", angle: 0, lengthRadians: 0.4, startAngle: -0.2, kind: "play",
    ...overrides
  };
}

test("empty canvas: no orbits/planets/bars anywhere reports empty", () => {
  const result = hitTestCanvas({ x: 0, y: 0, zoom: 1, orbits: [], planets: [], bars: [] });
  assert.deepEqual(result, { type: "empty" });
});

test("a click on a planet's dot wins over everything underneath it", () => {
  const orbit = makeOrbit();
  // Planet sits at angle 0 -> world point (100, 0).
  const planet = makePlanet({ id: "p1", angle: 0 });
  const bar = makeBar({ id: "bar-1", angle: 0, lengthRadians: TAU }); // full-loop bar under the planet too
  const result = hitTestCanvas({ x: 100, y: 0, zoom: 1, orbits: [orbit], planets: [planet], bars: [bar] });
  assert.deepEqual(result, { type: "planet", planetId: "p1", orbitId: "orbit-1" });
});

test("planet hit radius is a fixed world-space value, unlike bar/orbit tolerances which divide by zoom", () => {
  const orbit = makeOrbit();
  const planet = makePlanet({ id: "p1", angle: 0 });
  const edge = PLANET_RADIUS + PLANET_STROKE_WIDTH / 2;
  const insideProbe = { x: 100 + edge - 0.5, y: 0 };
  const outsideProbe = { x: 100 + edge + 0.5, y: 0 };
  // Just inside the fixed radius hits at any zoom.
  assert.equal(
    hitTestCanvas({ ...insideProbe, zoom: 1, orbits: [orbit], planets: [planet], bars: [] }).type, "planet"
  );
  assert.equal(
    hitTestCanvas({ ...insideProbe, zoom: .25, orbits: [orbit], planets: [planet], bars: [] }).type, "planet"
  );
  // Just outside the fixed radius misses at any zoom -- unlike BAR_EDGE_HIT_RADIUS/
  // ORBIT_LINE_TOLERANCE below, the planet radius is never divided by zoom.
  assert.equal(
    hitTestCanvas({ ...outsideProbe, zoom: 1, orbits: [orbit], planets: [planet], bars: [] }).type, "orbit-line"
  );
  assert.equal(
    hitTestCanvas({ ...outsideProbe, zoom: .25, orbits: [orbit], planets: [planet], bars: [] }).type, "orbit-line"
  );
});

test("bar edge hit radius grows in world space as zoom shrinks", () => {
  const orbit = makeOrbit();
  const bar = makeBar({ id: "bar-1", angle: 0, lengthRadians: 0.4, startAngle: -0.2 });
  // Bar's start edge sits at angle -0.2 -> world point ellipsePoint(orbit, -0.2).
  const startAngle = -0.2;
  const startPoint = { x: Math.cos(startAngle) * 100, y: Math.sin(startAngle) * 100 };
  // 10 world units away from the edge point along x: a miss at zoom 1 (8/1 = 8 radius),
  // but a hit at zoom 0.5 (8/0.5 = 16 radius).
  const probe = { x: startPoint.x + 10, y: startPoint.y };
  assert.notEqual(
    hitTestCanvas({ ...probe, zoom: 1, orbits: [orbit], planets: [], bars: [bar] }).type, "bar-edge"
  );
  assert.deepEqual(
    hitTestCanvas({ ...probe, zoom: .5, orbits: [orbit], planets: [], bars: [bar] }),
    { type: "bar-edge", barId: "bar-1", orbitId: "orbit-1", edge: "start" }
  );
});

test("bar body hit requires both being near the orbit line and inside the bar's angular span", () => {
  const orbit = makeOrbit();
  const bar = makeBar({ id: "bar-1", angle: 0, lengthRadians: 0.4, startAngle: -0.2 });
  // On the orbit line (radius 100) at angle 0.05, well inside +-0.2 and away from the edges.
  const onBarPoint = { x: Math.cos(0.05) * 100, y: Math.sin(0.05) * 100 };
  assert.deepEqual(
    hitTestCanvas({ ...onBarPoint, zoom: 1, orbits: [orbit], planets: [], bars: [bar] }),
    { type: "bar-body", barId: "bar-1", orbitId: "orbit-1" }
  );
  // Same radius, but well outside the bar's angular span -> falls through to orbit-line.
  const offBarPoint = { x: Math.cos(2) * 100, y: Math.sin(2) * 100 };
  assert.deepEqual(
    hitTestCanvas({ ...offBarPoint, zoom: 1, orbits: [orbit], planets: [], bars: [bar] }),
    { type: "orbit-line", orbitId: "orbit-1" }
  );
});

test("sequence bars use a fixed angular tolerance and hit-test as body only (no bar-edge)", () => {
  const orbit = makeOrbit({ mode: "sequence" });
  const bar = makeBar({ id: "bar-1", angle: 0, lengthRadians: 0.4, startAngle: -0.2, kind: "play" });
  const onBarPoint = { x: 100, y: 0 };
  assert.deepEqual(
    hitTestCanvas({ ...onBarPoint, zoom: 1, orbits: [orbit], planets: [], bars: [bar] }),
    { type: "bar-body", barId: "bar-1", orbitId: "orbit-1" }
  );
});

test("splice-sourced bars are excluded from bar hit-testing entirely", () => {
  const orbit = makeOrbit();
  const bar = makeBar({ id: "bar-1", angle: 0, lengthRadians: 0.4, startAngle: -0.2, source: "splice" });
  const onBarPoint = { x: 100, y: 0 };
  assert.deepEqual(
    hitTestCanvas({ ...onBarPoint, zoom: 1, orbits: [orbit], planets: [], bars: [bar] }),
    { type: "orbit-line", orbitId: "orbit-1" }
  );
});

test("falls through to orbit-line, then orbit-inside, then empty as the point moves inward", () => {
  const orbit = makeOrbit();
  assert.deepEqual(
    hitTestCanvas({ x: 100, y: 0, zoom: 1, orbits: [orbit], planets: [], bars: [] }),
    { type: "orbit-line", orbitId: "orbit-1" }
  );
  assert.deepEqual(
    hitTestCanvas({ x: 50, y: 0, zoom: 1, orbits: [orbit], planets: [], bars: [] }),
    { type: "orbit-inside", orbitId: "orbit-1" }
  );
  assert.deepEqual(
    hitTestCanvas({ x: 500, y: 500, zoom: 1, orbits: [orbit], planets: [], bars: [] }),
    { type: "empty" }
  );
});

test("later (higher-index) orbits and planets win when overlapping, matching top-of-z-order drawing", () => {
  const back = makeOrbit({ id: "back", x: 0, y: 0, radiusX: 100, radiusY: 100 });
  const front = makeOrbit({ id: "front", x: 0, y: 0, radiusX: 100, radiusY: 100 });
  assert.deepEqual(
    hitTestCanvas({ x: 100, y: 0, zoom: 1, orbits: [back, front], planets: [], bars: [] }),
    { type: "orbit-line", orbitId: "front" }
  );
  const planetBack = makePlanet({ id: "p-back", orbitId: "front", angle: 0 });
  const planetFront = makePlanet({ id: "p-front", orbitId: "front", angle: 0 });
  assert.deepEqual(
    hitTestCanvas({
      x: 100, y: 0, zoom: 1, orbits: [front], planets: [planetBack, planetFront], bars: []
    }),
    { type: "planet", planetId: "p-front", orbitId: "front" }
  );
});
