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

test("planet pan is applied before the shared orbit-bus pan, rather than summed", () => {
  const planetPanned = apply(getFLStylePanMatrix(-50), 2, 3);
  const final = apply(getFLStylePanMatrix(50), planetPanned.left, planetPanned.right);
  assert.deepEqual(final, { left: 1.75, right: 3.25 });
  // Reversing these stages is a different result, proving their values are not added.
  const orbitFirst = apply(getFLStylePanMatrix(50), 2, 3);
  const wrongOrder = apply(getFLStylePanMatrix(-50), orbitFirst.left, orbitFirst.right);
  assert.notDeepEqual(final, wrongOrder);

  const hardPlanetLeft = apply(getFLStylePanMatrix(-100), 2, 3);
  assert.deepEqual(apply(getFLStylePanMatrix(100), hardPlanetLeft.left, hardPlanetLeft.right), { left: 0, right: 5 });
});
