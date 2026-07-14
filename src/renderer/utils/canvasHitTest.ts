// Pure hit-testing math extracted from CanvasStage's hitTestCanvas. Depends only on
// world-space geometry (orbits/planets/bars, a point, and the current zoom), so it can
// run outside React/DOM and be driven deterministically from tests.
import type { Orbit, Planet, TriggerBar } from "../state/types";
import {
  ellipsePoint, isAngleInsideBar, isFullLoopBar, orbitAngleAtPoint
} from "./geometry.ts";
import { angularDistance } from "./triggerDetection.ts";
import { PLANET_RADIUS } from "../state/physics.ts";

export const PLANET_STROKE_WIDTH = 2;
const BAR_EDGE_HIT_RADIUS = 8;
const ORBIT_LINE_TOLERANCE = 8;

export type HitTestResult =
  | { type: "planet"; planetId: string; orbitId: string }
  | { type: "bar-edge"; barId: string; orbitId: string; edge: "start" | "end" }
  | { type: "bar-body"; barId: string; orbitId: string }
  | { type: "orbit-line"; orbitId: string }
  | { type: "orbit-inside"; orbitId: string }
  | { type: "empty" };

export type HitTestInput = {
  x: number;
  y: number;
  zoom: number;
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  // Optional override for a planet's angle (e.g. CanvasStage's runtime ref, which tracks
  // true motion between the throttled React-state commits -- see physics.ts). Defaults
  // to the planet's own `angle` field, matching pre-ref-driven-motion behavior exactly.
  resolveAngle?: (planet: Planet) => number;
};

function pointDistanceToOrbit(orbit: Orbit, x: number, y: number) {
  const angle = orbitAngleAtPoint(orbit, x, y);
  const point = ellipsePoint(orbit, angle);
  return Math.hypot(point.x - x, point.y - y);
}

export function hitTestCanvas(input: HitTestInput): HitTestResult {
  const { x, y, orbits, planets, bars } = input;
  const zoom = input.zoom || 1;
  const resolveAngle = input.resolveAngle ?? ((planet: Planet) => planet.angle);
  const barEdgeHitRadius = BAR_EDGE_HIT_RADIUS / zoom;
  const orbitLineTolerance = ORBIT_LINE_TOLERANCE / zoom;
  const barBodyLineTolerance = 10 / zoom;
  for (let index = planets.length - 1; index >= 0; index--) {
    const planet = planets[index];
    const orbit = orbits.find((item) => item.id === planet.orbitId);
    if (!orbit) continue;
    const point = ellipsePoint(orbit, resolveAngle(planet));
    if (Math.hypot(point.x - x, point.y - y) <= PLANET_RADIUS + PLANET_STROKE_WIDTH / 2) {
      return { type: "planet", planetId: planet.id, orbitId: orbit.id };
    }
  }
  for (let index = bars.length - 1; index >= 0; index--) {
    const bar = bars[index];
    const orbit = orbits.find((item) => item.id === bar.orbitId);
    if (!orbit || orbit.mode !== "loop" || bar.source === "splice") continue;
    const start = bar.angle - bar.lengthRadians / 2;
    const end = bar.angle + bar.lengthRadians / 2;
    if (Math.hypot(ellipsePoint(orbit, start).x - x, ellipsePoint(orbit, start).y - y) <= barEdgeHitRadius) {
      return { type: "bar-edge", barId: bar.id, orbitId: orbit.id, edge: "start" };
    }
    if (Math.hypot(ellipsePoint(orbit, end).x - x, ellipsePoint(orbit, end).y - y) <= barEdgeHitRadius) {
      return { type: "bar-edge", barId: bar.id, orbitId: orbit.id, edge: "end" };
    }
  }
  for (let index = bars.length - 1; index >= 0; index--) {
    const bar = bars[index];
    const orbit = orbits.find((item) => item.id === bar.orbitId);
    if (!orbit || bar.source === "splice") continue;
    const angle = orbitAngleAtPoint(orbit, x, y);
    const onLine = pointDistanceToOrbit(orbit, x, y) <= barBodyLineTolerance;
    const onBar = orbit.mode === "loop"
      ? !isFullLoopBar(bar) && isAngleInsideBar(angle, bar.angle, bar.lengthRadians)
      : angularDistance(angle, bar.angle) <= .07;
    if (onLine && onBar) return { type: "bar-body", barId: bar.id, orbitId: orbit.id };
  }
  for (let index = orbits.length - 1; index >= 0; index--) {
    const orbit = orbits[index];
    if (pointDistanceToOrbit(orbit, x, y) <= orbitLineTolerance) {
      return { type: "orbit-line", orbitId: orbit.id };
    }
  }
  for (let index = orbits.length - 1; index >= 0; index--) {
    const orbit = orbits[index];
    const normalized = ((x - orbit.x) / orbit.radiusX) ** 2 + ((y - orbit.y) / orbit.radiusY) ** 2;
    if (normalized < 1) return { type: "orbit-inside", orbitId: orbit.id };
  }
  return { type: "empty" };
}
