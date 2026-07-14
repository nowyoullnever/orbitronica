// Pure physics/trigger step extracted from CanvasStage's setInterval tick. This module
// must not touch React or the DOM: CanvasStage is a thin driver that owns the refs,
// invokes stepPhysics once per tick, and applies the returned planet updates to React
// state itself (see the `onMovePlanets` call in CanvasStage's tick effect).
import type { Orbit, Planet, TriggerBar } from "./types";
import {
  TAU, ellipsePoint, getPlanetEffectiveSpeed, getSampleDuration, isAngleInsideBar, normalizeAngle
} from "../utils/geometry.ts";
import { collisionPairKey, hasSweptCircleContact, isAngularlyApproaching } from "../utils/collision.ts";
import { getLoopBarTransitions } from "../utils/sampleTrim.ts";
import { angularDistance } from "../utils/triggerDetection.ts";

// Radius (world units) used both for the drawn planet dot and for swept-circle collision
// contact. Kept here so CanvasStage's drawing code and the physics tick never drift apart.
export const PLANET_RADIUS = 6;
export const SEQUENCE_BASE_CYCLE_DURATION = 4;
export const COLLISION_SLOWDOWN = .4;
export const COLLISION_COOLDOWN_SECONDS = .25;
export const COLLISION_RECOVERY_RATE = 2.5;
export const COLLISION_FLASH_SECONDS = .12;

export type PlaybackCallback = { sceneId: string; epoch: number };

export type StepPhysicsInput = {
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  isPlaying: boolean;
  sceneId: string;
  playbackEpoch: number;
  delta: number;
  // Mutated in place, exactly like the ref-backed Maps the CanvasStage tick used to close over.
  runtimeAngles: Map<string, number>;
  runtimeUnwrappedAngles: Map<string, number>;
  collisionPairCooldowns: Map<string, number>;
  triggerStates: Map<string, boolean>;
  // The angle value most recently committed into `updates` (and therefore into React
  // state) for each planet, via either the periodic low-rate sync or a collision event.
  // Lets stepPhysics tell "React state is stale because we throttled it" apart from
  // "React state just changed for some other reason" (a drag, paste, the transport's
  // stop-resets-to-zero, a future edit feature, ...) when reconciling while paused.
  lastSyncedAngles: Map<string, number>;
  // Seconds accumulated since the last periodic angle sync, while playing. A mutable
  // box (not a bare number) so stepPhysics can update it in place like the Maps above.
  angleSyncElapsed: { value: number };
  onLoopFrame: (
    orbit: Orbit, planet: Planet, bar: TriggerBar, inside: boolean, angle: number, callback: PlaybackCallback
  ) => void;
  onSequencePlay: (orbit: Orbit, planet: Planet, bar: TriggerBar, callback: PlaybackCallback) => void;
  onSequenceStop: (orbitId: string, callback: PlaybackCallback) => void;
};

// Planets commit their angle into React state at most this often while playing (instead
// of every 10ms tick), and otherwise only when a collision needs to reach React state
// (direction flip / speed-multiplier / flash) -- see the ANGLE_SYNC_INTERVAL_SECONDS
// comment block inside stepPhysics for the full commit contract.
export const ANGLE_SYNC_INTERVAL_SECONDS = .25;

export type StepPhysicsResult = {
  updates: Map<string, Partial<Planet>>;
};

type MotionSample = {
  previousPosition: { x: number; y: number };
  currentPosition: { x: number; y: number };
  previousUnwrappedAngle: number;
  currentUnwrappedAngle: number;
};

// stepPhysics runs synchronously, once per 10ms interval tick, from a single driver
// (CanvasStage's tick effect) -- never reentrantly or concurrently. These scratch
// structures are cleared and refilled at the top of every call instead of being
// reallocated, since they're purely internal bookkeeping that never escapes the
// function (only `updates`, a fresh Map every call, is handed back to the caller and
// ultimately to React state).
const scratchOrbitsById = new Map<string, Orbit>();
const scratchBarsByOrbitId = new Map<string, TriggerBar[]>();
const scratchEffectiveBarsByOrbitId = new Map<string, TriggerBar[]>();
const scratchSampleDurationByOrbitId = new Map<string, number>();
const scratchDynamics = new Map<string, Planet>();
const scratchMotionSamples = new Map<string, MotionSample>();
const scratchContactPairs: Array<{ key: string; a: Planet; b: Planet }> = [];
const scratchContactedPlanetIds = new Set<string>();

function getEffectiveBars(orbit: Orbit): TriggerBar[] {
  const cached = scratchEffectiveBarsByOrbitId.get(orbit.id);
  if (cached) return cached;
  const grouped = scratchBarsByOrbitId.get(orbit.id) ?? [];
  const effective = orbit.mode === "loop" ? grouped : grouped.filter((item) => item.source !== "splice");
  scratchEffectiveBarsByOrbitId.set(orbit.id, effective);
  return effective;
}

function getBaseDuration(orbit: Orbit): number {
  if (orbit.mode !== "loop") return SEQUENCE_BASE_CYCLE_DURATION;
  const cached = scratchSampleDurationByOrbitId.get(orbit.id);
  if (cached !== undefined) return cached;
  const duration = getSampleDuration(orbit);
  scratchSampleDurationByOrbitId.set(orbit.id, duration);
  return duration;
}

export function stepPhysics(input: StepPhysicsInput): StepPhysicsResult {
  const {
    orbits, planets, bars, isPlaying, sceneId, playbackEpoch, delta,
    runtimeAngles, runtimeUnwrappedAngles, collisionPairCooldowns, triggerStates,
    lastSyncedAngles, angleSyncElapsed,
    onLoopFrame, onSequencePlay, onSequenceStop
  } = input;

  const updates = new Map<string, Partial<Planet>>();

  scratchOrbitsById.clear();
  for (const orbit of orbits) scratchOrbitsById.set(orbit.id, orbit);
  const orbitsById = scratchOrbitsById;

  // Reconcile the runtime angle refs against React state whenever the transport isn't
  // running. Two directions are possible and stepPhysics can't just always pick one:
  //  - If nothing besides our own throttled sync has touched planet.angle since we last
  //    committed it (lastSyncedAngles still matches), any divergence from the runtime
  //    accumulator is OUR staleness (we throttle angle commits to ANGLE_SYNC_INTERVAL_
  //    SECONDS while playing) -- push the true final angle into `updates` once so
  //    history/serialization don't capture a pre-throttle position.
  //  - Otherwise (a brand new planet we've never tracked, or planet.angle changed for
  //    some other reason -- a drag, paste, or the transport's stop-resets-to-zero,
  //    which lands in the SAME batch as isPlaying going false) React state is the more
  //    authoritative value: adopt it into the runtime refs instead of overwriting it.
  // This runs BEFORE the early-out below so a planet edited while already paused (e.g.
  // dragged) is picked up even on ticks that otherwise do no other work.
  if (!isPlaying) {
    for (const planet of planets) {
      if (!orbitsById.get(planet.orbitId)) continue;
      const runtimeAngle = runtimeAngles.get(planet.id);
      const lastSynced = lastSyncedAngles.get(planet.id);
      if (runtimeAngle === undefined || lastSynced === undefined || planet.angle !== lastSynced) {
        runtimeAngles.set(planet.id, planet.angle);
        runtimeUnwrappedAngles.set(planet.id, planet.angle);
        lastSyncedAngles.set(planet.id, planet.angle);
      } else if (runtimeAngle !== planet.angle) {
        updates.set(planet.id, { ...updates.get(planet.id), angle: runtimeAngle });
        lastSyncedAngles.set(planet.id, runtimeAngle);
      }
    }
    angleSyncElapsed.value = 0;
  }

  const anyLingeringCollisionEffect = planets.some((planet) =>
    orbitsById.get(planet.orbitId) &&
    (planet.collisionSpeedMultiplier !== 1 || planet.collisionFlashRemaining > 0));
  if (!isPlaying && collisionPairCooldowns.size === 0 && !anyLingeringCollisionEffect) {
    return { updates };
  }

  scratchBarsByOrbitId.clear();
  for (const bar of bars) {
    const list = scratchBarsByOrbitId.get(bar.orbitId);
    if (list) list.push(bar);
    else scratchBarsByOrbitId.set(bar.orbitId, [bar]);
  }
  scratchEffectiveBarsByOrbitId.clear();
  scratchSampleDurationByOrbitId.clear();

  scratchDynamics.clear();
  scratchMotionSamples.clear();
  const dynamics = scratchDynamics;
  const motionSamples = scratchMotionSamples;

  if (!isPlaying) collisionPairCooldowns.clear();
  else for (const [pair, remaining] of collisionPairCooldowns) {
    const nextRemaining = remaining - delta;
    if (nextRemaining > 0) collisionPairCooldowns.set(pair, nextRemaining);
    else collisionPairCooldowns.delete(pair);
  }

  // Angle commits while playing are throttled to ANGLE_SYNC_INTERVAL_SECONDS: decided
  // once per tick (not per planet) so every moving planet syncs on the same cadence.
  let shouldSyncAngles = false;
  if (isPlaying) {
    angleSyncElapsed.value += delta;
    if (angleSyncElapsed.value >= ANGLE_SYNC_INTERVAL_SECONDS) {
      shouldSyncAngles = true;
      angleSyncElapsed.value = 0;
    }
  }

  for (const planet of planets) {
    const orbit = orbitsById.get(planet.orbitId);
    if (!orbit) continue;
    let angle = runtimeAngles.get(planet.id) ?? planet.angle;
    let unwrappedAngle = runtimeUnwrappedAngles.get(planet.id) ?? angle;
    const previousUnwrappedAngle = unwrappedAngle;
    const previousPosition = ellipsePoint(orbit, previousUnwrappedAngle);
    let collisionSpeedMultiplier = planet.collisionSpeedMultiplier +
      (1 - planet.collisionSpeedMultiplier) * Math.min(1, delta * COLLISION_RECOVERY_RATE);
    collisionSpeedMultiplier = Math.min(1, Math.max(.1, collisionSpeedMultiplier));
    if (collisionSpeedMultiplier > .9995) collisionSpeedMultiplier = 1;
    const collisionFlashRemaining = Math.max(0, planet.collisionFlashRemaining - delta);
    const direction = planet.direction;
    const isMoving = isPlaying && !orbit.isPaused && planet.isActive;
    if (isMoving) {
      const baseDuration = getBaseDuration(orbit);
      unwrappedAngle += delta * (TAU / baseDuration) *
        getPlanetEffectiveSpeed(orbit, { speed: planet.speed, pitchCents: planet.pitchCents, collisionSpeedMultiplier }) *
        direction;
      angle = normalizeAngle(unwrappedAngle);
      runtimeAngles.set(planet.id, angle);
      runtimeUnwrappedAngles.set(planet.id, unwrappedAngle);
    }
    // Only allocate a new planet snapshot when something actually differs from the
    // React-state planet (angle moved, or collision decay changed a field); otherwise
    // reuse the existing reference untouched -- same field values either way, since
    // `direction` never changes here (collision-driven flips happen in a later pass).
    const changed = angle !== planet.angle ||
      collisionSpeedMultiplier !== planet.collisionSpeedMultiplier ||
      collisionFlashRemaining !== planet.collisionFlashRemaining;
    const next: Planet = changed
      ? { ...planet, angle, direction, collisionSpeedMultiplier, collisionFlashRemaining }
      : planet;
    dynamics.set(planet.id, next);
    motionSamples.set(planet.id, {
      previousPosition,
      currentPosition: ellipsePoint(orbit, unwrappedAngle),
      previousUnwrappedAngle,
      currentUnwrappedAngle: unwrappedAngle
    });
    // Selective commit contract (replaces the old "every planet, every tick" push):
    //  - Collision fields (direction is folded in separately below, once an actual
    //    contact resolves) reach React state on every tick they're still settling --
    //    App.tsx's onMovePlanets drives setActivePlanetTapeRate off collisionSpeedMultiplier
    //    changes, and undo/history needs them -- but stop once fully at rest (multiplier
    //    === 1 and flash === 0), matching `changed`'s collision half exactly.
    //  - Angle only commits for planets actually moving this tick, at the throttled
    //    cadence decided above (or via the pause/stop reconcile pass already run).
    const collisionFieldsChanged = collisionSpeedMultiplier !== planet.collisionSpeedMultiplier ||
      collisionFlashRemaining !== planet.collisionFlashRemaining;
    if (collisionFieldsChanged) {
      updates.set(planet.id, { ...updates.get(planet.id), collisionSpeedMultiplier, collisionFlashRemaining });
    }
    if (shouldSyncAngles && isMoving) {
      updates.set(planet.id, { ...updates.get(planet.id), angle });
      lastSyncedAngles.set(planet.id, angle);
    }
    for (const bar of getEffectiveBars(orbit)) {
      const callback = { sceneId, epoch: playbackEpoch };
      const key = `${planet.id}:${bar.id}`;
      if (orbit.mode === "loop") {
        const inside = isMoving &&
          bar.kind === "play" && isAngleInsideBar(angle, bar.angle, bar.lengthRadians);
        const transitions = isMoving && bar.kind === "play"
          ? getLoopBarTransitions(previousUnwrappedAngle, unwrappedAngle, bar.angle, bar.lengthRadians)
          : [];
        // audioEngine.syncLoop only needs a call when something changes: it starts/stops
        // playback on inside transitions, drives position purely from the native audio
        // loop (loopStart/loopEnd) while inside, and is a true no-op when called again
        // with inside=false and no active playback for this key. So skip the call only
        // when inside stays false with no transition -- calling every tick while inside
        // is true (or a transition just occurred) is preserved, since that path also
        // carries live volume/tapeRate updates (e.g. mid-collision-recovery).
        const previouslyInside = triggerStates.get(key);
        const skippable = !inside && previouslyInside === false && transitions.length === 0;
        if (!skippable) {
          for (const transition of transitions) {
            onLoopFrame(orbit, next, bar, transition.type === "enter", normalizeAngle(transition.angle), callback);
          }
          onLoopFrame(orbit, next, bar, inside, angle, callback);
        }
        triggerStates.set(key, inside);
      } else {
        const inside = isMoving && angularDistance(angle, bar.angle) < .04;
        if (inside && !triggerStates.get(key)) {
          if (bar.kind === "stop") onSequenceStop(orbit.id, callback);
          else onSequencePlay(orbit, next, bar, callback);
        }
        triggerStates.set(key, inside);
      }
    }
  }
  const collisionPlanets = [...dynamics.values()].filter((planet) => {
    const orbit = orbitsById.get(planet.orbitId);
    return isPlaying && planet.isActive && Boolean(orbit);
  });
  scratchContactPairs.length = 0;
  const contactPairs = scratchContactPairs;
  for (let left = 0; left < collisionPlanets.length; left++) {
    for (let right = left + 1; right < collisionPlanets.length; right++) {
      const a = collisionPlanets[left], b = collisionPlanets[right];
      const pair = collisionPairKey(a.id, b.id);
      if (collisionPairCooldowns.has(pair)) continue;
      const orbitA = orbitsById.get(a.orbitId);
      const orbitB = orbitsById.get(b.orbitId);
      const motionA = motionSamples.get(a.id);
      const motionB = motionSamples.get(b.id);
      if (!orbitA || !orbitB || !motionA || !motionB) continue;
      // Only bounce when the two planets are actually moving toward each other this
      // tick. Without this, planets sitting close together stay overlapped and flip
      // direction repeatedly, gluing them together in a periodic forward/reverse cycle.
      //
      // On the SAME orbit, measure approach by the angular gap, not screen distance:
      // orbits are ellipses, so two planets holding a fixed angular gap still see their
      // straight-line distance grow and shrink as they travel. Using screen distance
      // there produces phantom "approaching" for planets that move in lockstep, so they
      // never separate on the orbit and oscillate forever. Cross-orbit pairs have no
      // shared angle, so their swept screen-space motion determines contact.
      let colliding: boolean;
      if (a.orbitId === b.orbitId) {
        colliding = isAngularlyApproaching(
          motionA.previousUnwrappedAngle, motionA.currentUnwrappedAngle,
          motionB.previousUnwrappedAngle, motionB.currentUnwrappedAngle
        ) && hasSweptCircleContact(
          motionA.previousPosition, motionA.currentPosition,
          motionB.previousPosition, motionB.currentPosition,
          PLANET_RADIUS
        );
      } else {
        colliding = hasSweptCircleContact(
          motionA.previousPosition, motionA.currentPosition,
          motionB.previousPosition, motionB.currentPosition,
          PLANET_RADIUS
        );
      }
      if (colliding) contactPairs.push({ key: pair, a, b });
    }
  }
  scratchContactedPlanetIds.clear();
  const contactedPlanetIds = scratchContactedPlanetIds;
  for (const { key, a, b } of contactPairs) {
    collisionPairCooldowns.set(key, COLLISION_COOLDOWN_SECONDS);
    contactedPlanetIds.add(a.id);
    contactedPlanetIds.add(b.id);
  }
  for (const planet of collisionPlanets) {
    if (!contactedPlanetIds.has(planet.id)) continue;
    const collided: Planet = {
      ...planet,
      direction: (planet.direction * -1) as 1 | -1,
      collisionSpeedMultiplier: COLLISION_SLOWDOWN,
      collisionFlashRemaining: COLLISION_FLASH_SECONDS
    };
    dynamics.set(planet.id, collided);
    updates.set(planet.id, { ...updates.get(planet.id), ...collided });
    // The collision-event commit carries angle too (unchanged from the 4a baseline, via
    // the `...collided` spread above) -- keep the reconcile pass's bookkeeping in step so
    // a pause/stop right after a collision doesn't mistake this for an external edit.
    lastSyncedAngles.set(planet.id, collided.angle);
  }
  return { updates };
}
