import assert from "node:assert/strict";
import test from "node:test";
import { getFLStylePanMatrix } from "../src/renderer/audio/flStylePan.ts";

function apply(matrix: ReturnType<typeof getFLStylePanMatrix>, left: number, right: number) {
  return {
    left: left * matrix.leftToLeft + right * matrix.rightToLeft,
    right: left * matrix.leftToRight + right * matrix.rightToRight
  };
}

test("FL-style pan preserves stereo at center and collects both channels at hard sides", () => {
  assert.deepEqual(apply(getFLStylePanMatrix(0), 2, 3), { left: 2, right: 3 });
  assert.deepEqual(apply(getFLStylePanMatrix(100), 2, 3), { left: 0, right: 5 });
  assert.deepEqual(apply(getFLStylePanMatrix(-100), 2, 3), { left: 5, right: 0 });
});

test("orbit and planet FL-style pans are applied sequentially rather than summed", () => {
  const orbitPanned = apply(getFLStylePanMatrix(100), 2, 3);
  assert.deepEqual(apply(getFLStylePanMatrix(-100), orbitPanned.left, orbitPanned.right), { left: 5, right: 0 });
  const leftPanned = apply(getFLStylePanMatrix(-100), 2, 3);
  assert.deepEqual(apply(getFLStylePanMatrix(100), leftPanned.left, leftPanned.right), { left: 0, right: 5 });
});
