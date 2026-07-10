import type { Orbit } from "../state/types";

export const TAU = Math.PI * 2;
export const FULL_LOOP_EPSILON = 0.0001;

export function normalizeAngle(angle: number) {
  return ((angle % TAU) + TAU) % TAU;
}

export function ellipsePoint(orbit: Orbit, angle: number) {
  return {
    x: orbit.x + Math.cos(angle) * orbit.radiusX,
    y: orbit.y + Math.sin(angle) * orbit.radiusY
  };
}

export function orbitAngleAtPoint(orbit: Orbit, x: number, y: number) {
  return normalizeAngle(Math.atan2((y - orbit.y) / orbit.radiusY, (x - orbit.x) / orbit.radiusX));
}

export function distanceToOrbit(orbit: Orbit, x: number, y: number) {
  const angle = orbitAngleAtPoint(orbit, x, y);
  const point = ellipsePoint(orbit, angle);
  return Math.hypot(point.x - x, point.y - y);
}

export function findNearestOrbit(orbits: Orbit[], x: number, y: number, tolerance = 14) {
  let nearest: Orbit | null = null;
  let distance = tolerance;
  for (const orbit of orbits) {
    const current = distanceToOrbit(orbit, x, y);
    if (current < distance) {
      nearest = orbit;
      distance = current;
    }
  }
  return nearest;
}

// Effective playback window into the sample, clamped and defaulting to the full sample.
export function getSampleStart(orbit: Orbit) {
  return Math.min(Math.max(orbit.sampleStart ?? 0, 0), orbit.audioDuration);
}

export function getSampleEnd(orbit: Orbit) {
  return Math.min(Math.max(orbit.sampleEnd ?? orbit.audioDuration, getSampleStart(orbit)), orbit.audioDuration);
}

export function getSampleDuration(orbit: Orbit) {
  return Math.max(0.0001, getSampleEnd(orbit) - getSampleStart(orbit));
}

export function getBarTimeRange(bar: { angle: number; lengthRadians: number }, orbit: Orbit) {
  if (isFullLoopBar(bar)) return { startTime: 0, endTime: orbit.audioDuration };
  const half = bar.lengthRadians / 2;
  const startAngle = normalizeAngle(bar.angle - half);
  const endAngle = normalizeAngle(bar.angle + half);
  return {
    startTime: startAngle / TAU * orbit.audioDuration,
    endTime: endAngle / TAU * orbit.audioDuration
  };
}

export function isAngleInsideBar(angle: number, center: number, lengthRadians: number) {
  if (lengthRadians >= TAU - FULL_LOOP_EPSILON) return true;
  const raw = Math.abs(normalizeAngle(angle) - normalizeAngle(center));
  return Math.min(raw, TAU - raw) <= lengthRadians / 2;
}

export function isFullLoopBar(bar: { lengthRadians: number }) {
  return bar.lengthRadians >= TAU - FULL_LOOP_EPSILON;
}

export function getOrbitSizeScale(orbit: Orbit) {
  const currentSize = (orbit.radiusX + orbit.radiusY) / 2;
  const initialSize = (orbit.initialRadiusX + orbit.initialRadiusY) / 2;
  return initialSize <= 0 ? 1 : currentSize / initialSize;
}

export function getOrbitTapeRate(orbit: Orbit) {
  if (orbit.mode === "sequence") return 1;
  const currentSize = (orbit.radiusX + orbit.radiusY) / 2;
  const initialSize = (orbit.initialRadiusX + orbit.initialRadiusY) / 2;
  if (currentSize <= 0 || initialSize <= 0) return 1;
  // Smaller loop orbit = faster/higher pitch. Larger loop orbit = slower/lower pitch.
  return initialSize / currentSize;
}

export function hasUserSpeedOrPitchChange(planet: { speed?: number; pitchCents?: number }) {
  return Math.abs((planet.speed ?? 1) - 1) > 0.0001 || Math.abs(planet.pitchCents ?? 0) > 0.0001;
}

export function getLegacyOrbitSizeRate(
  orbit: Orbit,
  planet: { collisionSpeedMultiplier?: number }
) {
  if (orbit.mode === "sequence") return 1;
  // This is the exact orbit-size behavior from commit 3e8ee22:
  // smaller orbit = faster/higher, larger orbit = slower/lower.
  return (planet.collisionSpeedMultiplier ?? 1) / getOrbitSizeScale(orbit);
}

export function getPlanetEffectiveSpeed(
  orbit: Orbit,
  planet: { speed: number; pitchCents?: number; collisionSpeedMultiplier?: number }
) {
  const collision = planet.collisionSpeedMultiplier ?? 1;
  if (orbit.mode === "sequence") return planet.speed;
  if (!hasUserSpeedOrPitchChange(planet)) return getLegacyOrbitSizeRate(orbit, planet);
  return planet.speed * getOrbitTapeRate(orbit) * collision;
}

export function centsToPlaybackRate(cents: number) {
  return Math.pow(2, cents / 1200);
}

export function rateToCents(rate: number) {
  return rate > 0 ? 1200 * Math.log2(rate) : 0;
}

export function getTapeStyleRuntimeRateOnly(
  orbit: Orbit,
  planet: { speed?: number; pitchCents?: number; collisionSpeedMultiplier?: number }
) {
  if (orbit.mode === "sequence") return 1;
  if (!hasUserSpeedOrPitchChange(planet)) return getLegacyOrbitSizeRate(orbit, planet);
  return getOrbitTapeRate(orbit) * (planet.collisionSpeedMultiplier ?? 1);
}

// User speed is pitch-preserving and rendered into a processed buffer.
// Raw playbackRate is reserved for immediate tape-style runtime effects only.
export function getSpeedBasedPlaybackRate(
  orbit: Orbit,
  planet: { collisionSpeedMultiplier?: number }
) {
  return getTapeStyleRuntimeRateOnly(orbit, planet);
}

export function arePlanetCirclesColliding(
  a: { x: number; y: number },
  b: { x: number; y: number },
  radiusA: number,
  radiusB = radiusA
) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= radiusA + radiusB;
}
