import assert from "node:assert/strict";
import test from "node:test";
import { getLoopBarTransitions, MIN_SAMPLE_WINDOW_SECONDS, normalizeSampleWindow } from "../src/renderer/utils/sampleTrim.ts";

test("normalizes malformed and short sample windows", () => {
  assert.deepEqual(normalizeSampleWindow(2), { start: 0, end: 2, duration: 2 });
  assert.deepEqual(normalizeSampleWindow(2, -1, 4), { start: 0, end: 2, duration: 2 });
  const nearEnd = normalizeSampleWindow(2, 1.99, 0);
  assert.equal(nearEnd.start, 1.98);
  assert.equal(nearEnd.end, 2);
  assert.ok(Math.abs(nearEnd.duration - MIN_SAMPLE_WINDOW_SECONDS) < 1e-9);
  assert.deepEqual(normalizeSampleWindow(0.005, 0.004, 0), { start: 0, end: 0.005, duration: 0.005 });
  assert.deepEqual(normalizeSampleWindow(Number.NaN, 1, 2), { start: 0, end: 0, duration: 0 });
});

test("finds narrow loop-bar crossings across the zero-angle seam", () => {
  const transitions = getLoopBarTransitions(6, 6.5, 0, 0.2);
  assert.deepEqual(transitions.map(({ type }) => type), ["enter", "exit"]);
  assert.ok(transitions[0].fraction < transitions[1].fraction);
});

test("orders reverse and multi-lap loop-bar crossings", () => {
  const reverse = getLoopBarTransitions(0.3, -0.3, 0, 0.2);
  assert.deepEqual(reverse.map(({ type }) => type), ["enter", "exit"]);

  const multiLap = getLoopBarTransitions(0.2, Math.PI * 4 + 0.2, 0, 0.2);
  assert.deepEqual(multiLap.map(({ type }) => type), ["enter", "exit", "enter", "exit"]);
});
