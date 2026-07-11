import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpliceCount, spliceBarSpecs, TAU } from "../src/renderer/utils/geometry.ts";

test("normalizes splice counts to bounded signed even values", () => {
  assert.equal(normalizeSpliceCount(1), 0);
  assert.equal(normalizeSpliceCount(3), 4);
  assert.equal(normalizeSpliceCount(-33), -32);
  assert.equal(normalizeSpliceCount(100), 32);
});

test("builds alternating positive and negative splice phases", () => {
  const positive = spliceBarSpecs(4);
  const negative = spliceBarSpecs(-4);

  assert.deepEqual(positive.map((bar) => bar.startAngle), [0, Math.PI]);
  assert.deepEqual(negative.map((bar) => bar.startAngle), [Math.PI / 2, Math.PI * 1.5]);
  assert.ok(positive.every((bar) => bar.lengthRadians === TAU / 4));
});

test("rotates every splice region by the supplied start angle", () => {
  const [first] = spliceBarSpecs(2, Math.PI / 3);
  assert.ok(Math.abs(first.startAngle - Math.PI / 3) < 1e-12);
  assert.ok(Math.abs(first.angle - (Math.PI / 3 + Math.PI / 2)) < 1e-12);
});
