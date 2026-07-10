export const MIN_SAMPLE_WINDOW_SECONDS = 0.02;

export type SampleWindow = {
  start: number;
  end: number;
  duration: number;
};

export type LoopBarTransition = {
  type: "enter" | "exit";
  /** Position within the movement, from 0 (previous angle) through 1 (next angle). */
  fraction: number;
  angle: number;
};

const TAU = Math.PI * 2;
const FULL_LOOP_EPSILON = 0.0001;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Produces a valid playback window even for corrupt project data and clips shorter
 * than the regular minimum. The entire short clip remains selectable.
 */
export function normalizeSampleWindow(
  audioDuration: number,
  sampleStart?: number,
  sampleEnd?: number
): SampleWindow {
  const duration = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : 0;
  if (duration === 0) return { start: 0, end: 0, duration: 0 };

  const minimum = Math.min(MIN_SAMPLE_WINDOW_SECONDS, duration);
  const startInput = Number.isFinite(sampleStart) ? sampleStart : 0;
  const endInput = Number.isFinite(sampleEnd) ? sampleEnd : duration;
  const start = clamp(startInput!, 0, duration - minimum);
  const end = clamp(endInput!, start + minimum, duration);
  return { start, end, duration: end - start };
}

/**
 * Finds every loop-bar edge crossed between two unwrapped angles. Point sampling
 * misses narrow bars when frames are slow; callers can apply these in order.
 */
export function getLoopBarTransitions(
  previousAngle: number,
  nextAngle: number,
  center: number,
  lengthRadians: number
): LoopBarTransition[] {
  if (
    !Number.isFinite(previousAngle) ||
    !Number.isFinite(nextAngle) ||
    !Number.isFinite(center) ||
    !Number.isFinite(lengthRadians) ||
    nextAngle === previousAngle ||
    lengthRadians >= TAU - FULL_LOOP_EPSILON ||
    lengthRadians <= 0
  ) return [];

  const direction = Math.sign(nextAngle - previousAngle);
  const low = Math.min(previousAngle, nextAngle);
  const high = Math.max(previousAngle, nextAngle);
  const half = lengthRadians / 2;
  const firstCycle = Math.floor((low - center - half) / TAU) - 1;
  const lastCycle = Math.ceil((high - center + half) / TAU) + 1;
  const transitions: LoopBarTransition[] = [];

  for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
    const startEdge = center - half + cycle * TAU;
    const endEdge = center + half + cycle * TAU;
    const edges = direction > 0
      ? [{ angle: startEdge, type: "enter" as const }, { angle: endEdge, type: "exit" as const }]
      : [{ angle: endEdge, type: "enter" as const }, { angle: startEdge, type: "exit" as const }];
    for (const edge of edges) {
      if (edge.angle <= low || edge.angle > high) continue;
      transitions.push({
        type: edge.type,
        fraction: (edge.angle - previousAngle) / (nextAngle - previousAngle),
        angle: edge.angle
      });
    }
  }

  return transitions.sort((a, b) => a.fraction - b.fraction);
}
