import type { Orbit } from "../state/types";
import { normalizeSampleWindow } from "./sampleTrim.ts";

export const TAU = Math.PI * 2;
export const FULL_LOOP_EPSILON = 0.0001;
export const SPLICE_MAX_PIECES = 32;

export function normalizeSpliceCount(count: number) {
  if (!Number.isFinite(count) || Math.abs(count) < 2) return 0;
  const even = Math.min(SPLICE_MAX_PIECES, Math.max(-SPLICE_MAX_PIECES, Math.round(count / 2) * 2));
  return even;
}

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

function distanceToOrbit(orbit: Orbit, x: number, y: number) {
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
  return normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd).start;
}

export function getSampleEnd(orbit: Orbit) {
  return normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd).end;
}

export function getSampleDuration(orbit: Orbit) {
  return Math.max(0.0001, normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd).duration);
}

export function isAngleInsideBar(angle: number, center: number, lengthRadians: number) {
  if (lengthRadians >= TAU - FULL_LOOP_EPSILON) return true;
  const raw = Math.abs(normalizeAngle(angle) - normalizeAngle(center));
  return Math.min(raw, TAU - raw) <= lengthRadians / 2;
}

export function isFullLoopBar(bar: { lengthRadians: number }) {
  return bar.lengthRadians >= TAU - FULL_LOOP_EPSILON;
}

// Slice a loop into `|spliceCount|` equal pieces that alternate bar / gap, and return
// the bar pieces (half of them). A positive count places a bar on the piece at the start
// angle; a negative count shifts the phase by one piece so the loop starts on a gap.
// `startAngleOffset` rotates the whole pattern (the splice's start point).
export function spliceBarSpecs(
  spliceCount: number, startAngleOffset = 0
): { angle: number; lengthRadians: number; startAngle: number }[] {
  const pieces = Math.abs(normalizeSpliceCount(spliceCount));
  if (pieces < 2) return [];
  const pieceLength = TAU / pieces;
  const phase = spliceCount > 0 ? 0 : 1;
  const base = normalizeAngle(startAngleOffset);
  const specs: { angle: number; lengthRadians: number; startAngle: number }[] = [];
  for (let piece = phase; piece < pieces; piece += 2) {
    const startAngle = normalizeAngle(base + piece * pieceLength);
    specs.push({
      startAngle,
      lengthRadians: pieceLength,
      angle: normalizeAngle(startAngle + pieceLength / 2)
    });
  }
  return specs;
}

function getOrbitSizeScale(orbit: Orbit) {
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

function hasUserSpeedOrPitchChange(planet: { speed?: number; pitchCents?: number }) {
  return Math.abs((planet.speed ?? 1) - 1) > 0.0001 || Math.abs(planet.pitchCents ?? 0) > 0.0001;
}

function getLegacyOrbitSizeRate(
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
