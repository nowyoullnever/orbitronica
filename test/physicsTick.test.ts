// Characterization tests for stepPhysics (src/renderer/state/physics.ts), extracted
// mechanically from CanvasStage's setInterval tick body. These tests pin CURRENT
// behavior of the tick: callback sequencing/args, ref-map bookkeeping, and the
// updates map that CanvasStage forwards to App's onMovePlanets. Angle values that
// depend on floating-point accumulation are computed via the same trusted, separately
// tested primitives (normalizeAngle, ellipsePoint, getLoopBarTransitions) rather than
// hardcoded decimals, so the tests stay exact without transcription drift.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLISION_COOLDOWN_SECONDS, COLLISION_FLASH_SECONDS, COLLISION_SLOWDOWN, stepPhysics,
  type PlaybackCallback
} from "../src/renderer/state/physics.ts";
import { TAU, ellipsePoint, normalizeAngle } from "../src/renderer/utils/geometry.ts";
import { getLoopBarTransitions } from "../src/renderer/utils/sampleTrim.ts";
import { collisionPairKey } from "../src/renderer/utils/collision.ts";
import type { Orbit, Planet, TriggerBar } from "../src/renderer/state/types.ts";

function makeOrbit(overrides: Partial<Orbit> = {}): Orbit {
  return {
    id: "orbit-1", name: "Orbit 1", audioName: "sample.wav",
    x: 0, y: 0, radiusX: 100, radiusY: 100, initialRadiusX: 100, initialRadiusY: 100,
    // audioDuration === TAU makes getSampleDuration(orbit) === TAU, so a loop orbit's
    // angular step reduces to exactly `delta * effectiveSpeed * direction` -- easy to
    // predict by hand and to recompute with the shared primitives above.
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
    id: "bar-1", orbitId: "orbit-1", angle: 0, lengthRadians: TAU, startAngle: 0, kind: "play",
    ...overrides
  };
}

type LoopFrameCall = {
  kind: "loopFrame";
  orbitId: string; planet: Planet; barId: string; inside: boolean; angle: number; callback: PlaybackCallback;
};
type SequencePlayCall = {
  kind: "sequencePlay"; orbitId: string; planet: Planet; barId: string; callback: PlaybackCallback;
};
type SequenceStopCall = { kind: "sequenceStop"; orbitId: string; callback: PlaybackCallback };
type RecordedCall = LoopFrameCall | SequencePlayCall | SequenceStopCall;

function makeRecorder() {
  const calls: RecordedCall[] = [];
  return {
    calls,
    onLoopFrame: (orbit: Orbit, planet: Planet, bar: TriggerBar, inside: boolean, angle: number, callback: PlaybackCallback) => {
      calls.push({ kind: "loopFrame", orbitId: orbit.id, planet: { ...planet }, barId: bar.id, inside, angle, callback });
    },
    onSequencePlay: (orbit: Orbit, planet: Planet, bar: TriggerBar, callback: PlaybackCallback) => {
      calls.push({ kind: "sequencePlay", orbitId: orbit.id, planet: { ...planet }, barId: bar.id, callback });
    },
    onSequenceStop: (orbitId: string, callback: PlaybackCallback) => {
      calls.push({ kind: "sequenceStop", orbitId, callback });
    }
  };
}

function newRefs() {
  return {
    runtimeAngles: new Map<string, number>(),
    runtimeUnwrappedAngles: new Map<string, number>(),
    collisionPairCooldowns: new Map<string, number>(),
    triggerStates: new Map<string, boolean>(),
    lastSyncedAngles: new Map<string, number>(),
    angleSyncElapsed: { value: 0 }
  };
}

const CALLBACK: PlaybackCallback = { sceneId: "scene-1", epoch: 7 };

test("loop orbit play bar: enter transition, steady inside, exit transition", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const bar = makeBar({ id: "bar-play", orbitId: "loop-orbit", angle: 1.0, lengthRadians: 0.2, startAngle: 0.9, kind: "play" });
  const planet = makePlanet({ id: "p1", orbitId: "loop-orbit", angle: 0.85 });
  const recorder = makeRecorder();
  const refs = newRefs();
  const input = {
    orbits: [orbit], planets: [planet], bars: [bar],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    ...refs,
    onLoopFrame: recorder.onLoopFrame, onSequencePlay: recorder.onSequencePlay, onSequenceStop: recorder.onSequenceStop
  };

  // Tick 1: 0.85 -> 0.95, crossing the bar's enter edge (0.9) mid-tick and ending inside.
  const result1 = stepPhysics({ ...input, delta: 0.1 });
  const angle1 = normalizeAngle(0.95);
  const enterEdgeAngle = normalizeAngle(getLoopBarTransitions(0.85, 0.95, 1.0, 0.2)[0].angle);
  assert.equal(refs.runtimeUnwrappedAngles.get("p1"), 0.95);
  assert.equal(refs.runtimeAngles.get("p1"), angle1);
  assert.equal(recorder.calls.length, 2);
  const nextPlanet1 = { ...planet, angle: angle1, direction: 1 as const, collisionSpeedMultiplier: 1, collisionFlashRemaining: 0 };
  assert.deepEqual(recorder.calls[0], {
    kind: "loopFrame", orbitId: "loop-orbit", planet: nextPlanet1, barId: "bar-play",
    inside: true, angle: enterEdgeAngle, callback: CALLBACK
  });
  assert.deepEqual(recorder.calls[1], {
    kind: "loopFrame", orbitId: "loop-orbit", planet: nextPlanet1, barId: "bar-play",
    inside: true, angle: angle1, callback: CALLBACK
  });
  assert.equal(refs.triggerStates.get("p1:bar-play"), true);
  // 4e change: angle commits while playing are throttled to ANGLE_SYNC_INTERVAL_SECONDS
  // (250ms), not pushed every tick. After a single 0.1s tick nothing has accumulated
  // enough elapsed time yet, and no collision fields changed, so updates is empty --
  // onLoopFrame (asserted above) still fires every tick; only the React-state angle
  // commit is throttled.
  assert.deepEqual(result1.updates, new Map());

  // Tick 2: 0.95 -> 1.05, no edge crossed, stays inside -- only the steady-state call fires.
  recorder.calls.length = 0;
  const result2 = stepPhysics({ ...input, delta: 0.1 });
  const angle2 = normalizeAngle(1.05);
  assert.equal(getLoopBarTransitions(0.95, 1.05, 1.0, 0.2).length, 0);
  assert.equal(recorder.calls.length, 1);
  const nextPlanet2 = { ...planet, angle: angle2, direction: 1 as const, collisionSpeedMultiplier: 1, collisionFlashRemaining: 0 };
  assert.deepEqual(recorder.calls[0], {
    kind: "loopFrame", orbitId: "loop-orbit", planet: nextPlanet2, barId: "bar-play",
    inside: true, angle: angle2, callback: CALLBACK
  });
  // 4e change: elapsed is now 0.1+0.1=0.2s, still under the 250ms threshold -> still empty.
  assert.deepEqual(result2.updates, new Map());

  // Tick 3: 1.05 -> ~1.15, crossing the exit edge (1.1) mid-tick and ending outside.
  // (1.05 + 0.1 is not bit-identical to the literal 1.15, so recompute the same way
  // stepPhysics's accumulator does instead of hardcoding the sum.)
  const unwrapped3 = 1.05 + 0.1;
  recorder.calls.length = 0;
  const result3 = stepPhysics({ ...input, delta: 0.1 });
  const angle3 = normalizeAngle(unwrapped3);
  const exitEdgeAngle = normalizeAngle(getLoopBarTransitions(1.05, unwrapped3, 1.0, 0.2)[0].angle);
  assert.equal(recorder.calls.length, 2);
  const nextPlanet3 = { ...planet, angle: angle3, direction: 1 as const, collisionSpeedMultiplier: 1, collisionFlashRemaining: 0 };
  assert.deepEqual(recorder.calls[0], {
    kind: "loopFrame", orbitId: "loop-orbit", planet: nextPlanet3, barId: "bar-play",
    inside: false, angle: exitEdgeAngle, callback: CALLBACK
  });
  assert.deepEqual(recorder.calls[1], {
    kind: "loopFrame", orbitId: "loop-orbit", planet: nextPlanet3, barId: "bar-play",
    inside: false, angle: angle3, callback: CALLBACK
  });
  assert.equal(refs.triggerStates.get("p1:bar-play"), false);
  // 4e change: elapsed is now 0.2+0.1=0.30000000000000004s, past the 250ms threshold --
  // the periodic sync fires this tick and commits just the angle (no collision fields
  // changed, so they're absent, unlike the pre-4e unconditional commit).
  assert.deepEqual(result3.updates, new Map([["p1", { angle: angle3 }]]));
});

test("sequence orbit: play bar triggers once on entry, stop bar triggers on its own entry", () => {
  const orbit = makeOrbit({ id: "seq-orbit", mode: "sequence" });
  const playBar = makeBar({ id: "bar-play", orbitId: "seq-orbit", angle: 0.05, lengthRadians: 0.1, kind: "play" });
  const stopBar = makeBar({ id: "bar-stop", orbitId: "seq-orbit", angle: 0.15, lengthRadians: 0.1, kind: "stop" });
  const planet = makePlanet({ id: "p2", orbitId: "seq-orbit", angle: 0 });
  const recorder = makeRecorder();
  const refs = newRefs();
  const input = {
    orbits: [orbit], planets: [planet], bars: [playBar, stopBar],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    ...refs,
    onLoopFrame: recorder.onLoopFrame, onSequencePlay: recorder.onSequencePlay, onSequenceStop: recorder.onSequenceStop
  };
  // Sequence mode ignores orbit.audioDuration: baseDuration is the fixed
  // SEQUENCE_BASE_CYCLE_DURATION (4s), and effective speed is just planet.speed (1).
  const delta = 0.02;

  // Tick 1: enters the play bar's .04-radian window -> onSequencePlay fires once.
  const result1 = stepPhysics({ ...input, delta });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].kind, "sequencePlay");
  assert.equal((recorder.calls[0] as SequencePlayCall).barId, "bar-play");
  assert.deepEqual((recorder.calls[0] as SequencePlayCall).callback, CALLBACK);
  assert.equal(refs.triggerStates.get("p2:bar-play"), true);
  assert.equal(refs.triggerStates.get("p2:bar-stop"), false);
  void result1;

  // Tick 2: still inside the play bar's window -> no retrigger (triggerStates already true).
  recorder.calls.length = 0;
  stepPhysics({ ...input, delta });
  assert.equal(recorder.calls.length, 0);
  assert.equal(refs.triggerStates.get("p2:bar-play"), true);

  // Tick 3: leaves the play bar's window -> triggerStates flips false, no call (sequence
  // bars only fire on entry, never on exit).
  recorder.calls.length = 0;
  stepPhysics({ ...input, delta });
  assert.equal(recorder.calls.length, 0);
  assert.equal(refs.triggerStates.get("p2:bar-play"), false);

  // Tick 4: enters the stop bar's window -> onSequenceStop fires once.
  recorder.calls.length = 0;
  stepPhysics({ ...input, delta });
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(recorder.calls[0], { kind: "sequenceStop", orbitId: "seq-orbit", callback: CALLBACK });
  assert.equal(refs.triggerStates.get("p2:bar-stop"), true);
});

test("isPlaying=false: motion halts, runtime angle maps are resynced from React state every tick, decay still applies", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const bar = makeBar({ id: "bar-1", orbitId: "loop-orbit" });
  const planet = makePlanet({
    id: "p3", orbitId: "loop-orbit", angle: 1.23, collisionSpeedMultiplier: 0.4, collisionFlashRemaining: 0.12
  });
  const recorder = makeRecorder();
  const refs = newRefs();
  // Simulate a stale runtime ref (as if a previous playing session left the planet elsewhere);
  // isPlaying=false must force both maps back to the React-state angle every tick.
  refs.runtimeAngles.set("p3", 4.5);
  refs.runtimeUnwrappedAngles.set("p3", 4.5);

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [bar],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: recorder.onLoopFrame, onSequencePlay: recorder.onSequencePlay, onSequenceStop: recorder.onSequenceStop
  });

  assert.equal(refs.runtimeAngles.get("p3"), 1.23);
  assert.equal(refs.runtimeUnwrappedAngles.get("p3"), 1.23);
  // Collision decay (recovery toward 1, flash toward 0) runs unconditionally, even while paused.
  const expectedMultiplier = 0.4 + (1 - 0.4) * Math.min(1, 0.1 * 2.5);
  const expectedFlash = Math.max(0, 0.12 - 0.1);
  assert.equal(expectedMultiplier, 0.55);
  assert.ok(Math.abs(expectedFlash - 0.02) < 1e-9);
  // 4e change: no `angle` key. This is p3's first-ever tick (lastSyncedAngles has no
  // entry for it yet), so the pause/stop reconcile pass treats React state as
  // authoritative and *adopts* planet.angle into the runtime refs (asserted above)
  // instead of committing the stale preloaded runtime angle (4.5) into updates -- there
  // was never a legitimate "our own throttled sync fell behind" case here. The collision
  // fields still commit every tick they're actually changing, unchanged from 4a.
  assert.deepEqual(result.updates, new Map([
    ["p3", { collisionSpeedMultiplier: 0.55, collisionFlashRemaining: expectedFlash }]
  ]));
  // The per-bar loop still runs unconditionally (baseline 4a behavior): onLoopFrame is
  // called once with inside=false even though the transport is stopped.
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(recorder.calls[0], {
    kind: "loopFrame", orbitId: "loop-orbit",
    planet: { ...planet, angle: 1.23, direction: 1, collisionSpeedMultiplier: 0.55, collisionFlashRemaining: expectedFlash },
    barId: "bar-1", inside: false, angle: 1.23, callback: CALLBACK
  });
  // Cooldowns are unconditionally cleared while not playing.
  assert.equal(refs.collisionPairCooldowns.size, 0);
});

test("orbit.isPaused halts motion but leaves an existing runtime angle untouched (no resync from React state)", () => {
  const orbit = makeOrbit({ id: "loop-orbit", isPaused: true });
  const planet = makePlanet({ id: "p4", orbitId: "loop-orbit", angle: 0.5 });
  const refs = newRefs();
  // A stale in-flight runtime angle, distinct from the React-state angle: unlike the
  // isPlaying=false case, orbit.isPaused alone must NOT force a resync from planet.angle.
  refs.runtimeAngles.set("p4", 2.0);
  refs.runtimeUnwrappedAngles.set("p4", 2.0);
  const recorder = makeRecorder();

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: recorder.onLoopFrame, onSequencePlay: recorder.onSequencePlay, onSequenceStop: recorder.onSequenceStop
  });

  assert.equal(refs.runtimeAngles.get("p4"), 2.0);
  assert.equal(refs.runtimeUnwrappedAngles.get("p4"), 2.0);
  // 4e change: nothing to commit at all. Global isPlaying=true means the pause/stop
  // reconcile pass never runs (it's gated on !isPlaying), and this planet doesn't count
  // as "moving" for the periodic angle sync (isMoving requires !orbit.isPaused), and its
  // collision fields are already at rest (1 / 0, unchanged) -- so updates stays empty.
  assert.deepEqual(result.updates, new Map());
});

test("planet.isActive=false halts motion for that planet only and never populates its runtime ref", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const active = makePlanet({ id: "p-active", orbitId: "loop-orbit", angle: 0 });
  const inactive = makePlanet({ id: "p-inactive", orbitId: "loop-orbit", angle: 0, isActive: false });
  const refs = newRefs();

  const result = stepPhysics({
    orbits: [orbit], planets: [active, inactive], bars: [],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  assert.equal(refs.runtimeAngles.get("p-active"), normalizeAngle(0.1));
  assert.equal(refs.runtimeUnwrappedAngles.get("p-active"), 0.1);
  // Neither branch that writes runtimeAngles ran for the inactive planet (isPlaying is
  // true so the global resync branch is skipped, and planet.isActive gates the motion
  // branch) -- the ref map simply never gets an entry for it.
  assert.equal(refs.runtimeAngles.has("p-inactive"), false);
  assert.equal(refs.runtimeUnwrappedAngles.has("p-inactive"), false);
  // 4e change: the inactive planet never moved and has no collision fields to settle, so
  // it gets no updates entry at all (nothing changed, nothing to tell React state).
  assert.equal(result.updates.has("p-inactive"), false);
  // The active planet DID move, but a single 0.1s tick hasn't reached the 250ms periodic
  // sync threshold yet, so it also has no updates entry this tick.
  assert.equal(result.updates.has("p-active"), false);
  assert.equal(result.updates.size, 0);
});

test("reverse direction (direction=-1) decreases the unwrapped angle", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const planet = makePlanet({ id: "p5", orbitId: "loop-orbit", angle: 0, direction: -1 });
  const refs = newRefs();

  stepPhysics({
    orbits: [orbit], planets: [planet], bars: [],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  assert.equal(refs.runtimeUnwrappedAngles.get("p5"), -0.1);
  assert.equal(refs.runtimeAngles.get("p5"), normalizeAngle(-0.1));
});

test("collision between two planets on the same orbit flips direction, slows both, and starts a cooldown", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  // A starts at angle 0 moving forward (+1); B starts at angle 0.1 moving backward (-1) --
  // they swap positions this tick and must register a swept-circle contact.
  const a = makePlanet({ id: "pa", orbitId: "loop-orbit", angle: 0, direction: 1 });
  const b = makePlanet({ id: "pb", orbitId: "loop-orbit", angle: 0.1, direction: -1 });
  const refs = newRefs();

  const result = stepPhysics({
    orbits: [orbit], planets: [a, b], bars: [],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  const pairKey = collisionPairKey("pa", "pb");
  assert.equal(refs.collisionPairCooldowns.get(pairKey), COLLISION_COOLDOWN_SECONDS);
  const aAngle = normalizeAngle(0.1);
  const bAngle = normalizeAngle(0.0);
  const collidedA = {
    ...a, angle: aAngle, direction: -1 as const,
    collisionSpeedMultiplier: COLLISION_SLOWDOWN, collisionFlashRemaining: COLLISION_FLASH_SECONDS
  };
  const collidedB = {
    ...b, angle: bAngle, direction: 1 as const,
    collisionSpeedMultiplier: COLLISION_SLOWDOWN, collisionFlashRemaining: COLLISION_FLASH_SECONDS
  };
  // Collision-driven update entries are the full merged planet object (the collision
  // override spread wins every key), not a narrow partial like the non-collision case.
  assert.deepEqual(result.updates.get("pa"), collidedA);
  assert.deepEqual(result.updates.get("pb"), collidedB);
});

test("collision between two planets on different orbits uses swept screen-space contact only", () => {
  const orbitA = makeOrbit({ id: "orbit-a", x: 0, y: 0, radiusX: 100, radiusY: 100 });
  const orbitB = makeOrbit({ id: "orbit-b", x: 200, y: 0, radiusX: 100, radiusY: 100 });
  // A: rightmost point of orbit A (100,0) moving toward angle 0.1.
  const a = makePlanet({ id: "pa", orbitId: "orbit-a", angle: 0, direction: 1 });
  // B: just short of orbit B's leftmost point (touching orbit A's rightmost point),
  // moving onto it -- the two planets meet at (100, 0) this tick.
  const b = makePlanet({ id: "pb", orbitId: "orbit-b", angle: Math.PI - 0.1, direction: 1 });
  const refs = newRefs();

  const result = stepPhysics({
    orbits: [orbitA, orbitB], planets: [a, b], bars: [],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  const pairKey = collisionPairKey("pa", "pb");
  assert.equal(refs.collisionPairCooldowns.get(pairKey), COLLISION_COOLDOWN_SECONDS);
  assert.equal(result.updates.get("pa")?.direction, -1);
  assert.equal(result.updates.get("pb")?.direction, -1);
  assert.equal(result.updates.get("pa")?.collisionSpeedMultiplier, COLLISION_SLOWDOWN);
  assert.equal(result.updates.get("pb")?.collisionSpeedMultiplier, COLLISION_SLOWDOWN);
  // Sanity: the contact point both planets actually swept through this tick
  // (sin(PI) carries a tiny float residual, hence the epsilon on y).
  const contactPoint = ellipsePoint(orbitB, Math.PI);
  assert.equal(contactPoint.x, 100);
  assert.ok(Math.abs(contactPoint.y) < 1e-9);
});

test("collision cooldown decays each tick and expires, re-permitting a new collision check", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const refs = newRefs();
  const pairKey = collisionPairKey("pa", "pb");
  refs.collisionPairCooldowns.set(pairKey, COLLISION_COOLDOWN_SECONDS);
  const noopInput = {
    orbits: [orbit], planets: [] as Planet[], bars: [] as TriggerBar[],
    isPlaying: true, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  };

  stepPhysics({ ...noopInput, delta: 0.1, ...refs });
  assert.equal(refs.collisionPairCooldowns.get(pairKey), COLLISION_COOLDOWN_SECONDS - 0.1);
  stepPhysics({ ...noopInput, delta: 0.1, ...refs });
  assert.ok(refs.collisionPairCooldowns.has(pairKey));
  stepPhysics({ ...noopInput, delta: 0.1, ...refs });
  // 0.25 - 0.1 - 0.1 - 0.1 <= 0 -> deleted on the third decrement.
  assert.equal(refs.collisionPairCooldowns.has(pairKey), false);
});

test("isPlaying=false clears all collision cooldowns immediately", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const refs = newRefs();
  refs.collisionPairCooldowns.set(collisionPairKey("pa", "pb"), COLLISION_COOLDOWN_SECONDS);

  stepPhysics({
    orbits: [orbit], planets: [], bars: [],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  assert.equal(refs.collisionPairCooldowns.size, 0);
});

test("early-out: a fully-at-rest, not-playing tick with nothing pending does no work at all", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const bar = makeBar({ id: "bar-1", orbitId: "loop-orbit" });
  const planet = makePlanet({ id: "p-rest", orbitId: "loop-orbit", angle: 0.7 });
  const recorder = makeRecorder();
  const refs = newRefs();
  // Already fully reconciled: runtime, lastSynced, and React state all agree, so the
  // reconcile pass has nothing to adopt or commit, and there are no cooldowns or
  // lingering collision decay -- the early-out should skip the bar loop entirely (no
  // onLoopFrame calls at all, unlike the "isPlaying=false" decay test above, which had
  // a lingering collisionFlashRemaining keeping it out of the fast path).
  refs.runtimeAngles.set("p-rest", 0.7);
  refs.runtimeUnwrappedAngles.set("p-rest", 0.7);
  refs.lastSyncedAngles.set("p-rest", 0.7);

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [bar],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: recorder.onLoopFrame, onSequencePlay: recorder.onSequencePlay, onSequenceStop: recorder.onSequenceStop
  });

  assert.deepEqual(result.updates, new Map());
  assert.equal(recorder.calls.length, 0);
});

test("pause (isPlaying -> false, React state untouched) commits the true runtime angle once", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const planet = makePlanet({ id: "p-pause", orbitId: "loop-orbit", angle: 2.0 });
  const refs = newRefs();
  // Simulate several playing ticks' worth of throttled motion: the runtime accumulator
  // moved on to 2.5, but the last periodic sync (and therefore React state) only ever
  // saw 2.0 -- exactly the staleness the periodic sync is meant to tolerate while playing.
  refs.runtimeAngles.set("p-pause", 2.5);
  refs.runtimeUnwrappedAngles.set("p-pause", 2.5);
  refs.lastSyncedAngles.set("p-pause", 2.0);

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  // planet.angle (2.0) still matches what we last synced (2.0) -- nothing else touched
  // React state, so the divergence from the runtime accumulator (2.5) is OUR throttling.
  // Push the true final angle once so history/serialization don't see a stale position.
  assert.deepEqual(result.updates, new Map([["p-pause", { angle: 2.5 }]]));
  assert.equal(refs.lastSyncedAngles.get("p-pause"), 2.5);
  // The runtime refs are untouched (already correct) -- not overwritten from React state.
  assert.equal(refs.runtimeAngles.get("p-pause"), 2.5);
  assert.equal(refs.runtimeUnwrappedAngles.get("p-pause"), 2.5);
});

test("stop-with-reset (React state changed in the SAME batch as isPlaying -> false) adopts the reset, not the stale runtime angle", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  // Mirrors the transport's Stop button: setIsPlaying(false) and setPlanets(reset to 0)
  // are dispatched together, so by the time this tick runs, planet.angle is ALREADY 0 --
  // not a stale value waiting to be caught up.
  const planet = makePlanet({ id: "p-stop", orbitId: "loop-orbit", angle: 0 });
  const refs = newRefs();
  refs.runtimeAngles.set("p-stop", 2.5);
  refs.runtimeUnwrappedAngles.set("p-stop", 2.5);
  // The last thing stepPhysics itself synced was 2.0 (an earlier periodic commit) --
  // planet.angle (0) no longer matches that, which is the signal that something OTHER
  // than our own throttled sync changed React state.
  refs.lastSyncedAngles.set("p-stop", 2.0);

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  // Must NOT push the stale pre-stop runtime angle (2.5) into updates -- that would
  // fight the explicit reset and immediately undo it on the next React render.
  assert.deepEqual(result.updates, new Map());
  // Instead, the runtime refs adopt React state's reset value.
  assert.equal(refs.runtimeAngles.get("p-stop"), 0);
  assert.equal(refs.runtimeUnwrappedAngles.get("p-stop"), 0);
  assert.equal(refs.lastSyncedAngles.get("p-stop"), 0);
});

test("a brand new planet (never tracked) is adopted from React state, not treated as a stale commit", () => {
  const orbit = makeOrbit({ id: "loop-orbit" });
  const planet = makePlanet({ id: "p-new", orbitId: "loop-orbit", angle: 1.1 });
  const refs = newRefs();
  // No runtimeAngles/lastSyncedAngles entries at all -- as if the planet was just added
  // (paste, duplicate, click-to-place) while paused.

  const result = stepPhysics({
    orbits: [orbit], planets: [planet], bars: [],
    isPlaying: false, sceneId: CALLBACK.sceneId, playbackEpoch: CALLBACK.epoch,
    delta: 0.1, ...refs,
    onLoopFrame: () => {}, onSequencePlay: () => {}, onSequenceStop: () => {}
  });

  assert.deepEqual(result.updates, new Map());
  assert.equal(refs.runtimeAngles.get("p-new"), 1.1);
  assert.equal(refs.runtimeUnwrappedAngles.get("p-new"), 1.1);
  assert.equal(refs.lastSyncedAngles.get("p-new"), 1.1);
});
