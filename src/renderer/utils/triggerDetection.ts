import { TAU } from "./geometry";

export function angularDistance(a: number, b: number) {
  const diff = Math.abs(a - b) % TAU;
  return Math.min(diff, TAU - diff);
}
