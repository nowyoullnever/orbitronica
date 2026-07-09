import { TAU } from "./geometry";

export function angularDistance(a: number, b: number) {
  const diff = Math.abs(a - b) % TAU;
  return Math.min(diff, TAU - diff);
}

export function enteredTriggerZone(
  states: Map<string, boolean>,
  planetId: string,
  barId: string,
  planetAngle: number,
  barAngle: number,
  threshold = 0.04
) {
  const key = `${planetId}:${barId}`;
  const inside = angularDistance(planetAngle, barAngle) < threshold;
  const entered = inside && !states.get(key);
  states.set(key, inside);
  return entered;
}
