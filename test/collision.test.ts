import assert from "node:assert/strict";
import test from "node:test";
import {
  collisionPairKey, hasSweptCircleContact, isAngularlyApproaching
} from "../src/renderer/utils/collision.ts";

test("keeps collision pair keys order independent", () => {
  assert.equal(collisionPairKey("planet-a", "planet-b"), collisionPairKey("planet-b", "planet-a"));
});

test("detects a cross-orbit contact that passes closest approach during a tick", () => {
  assert.equal(hasSweptCircleContact(
    { x: -11, y: 0 }, { x: 11, y: 0 },
    { x: 0, y: 0 }, { x: 0, y: 0 },
    6
  ), true);
});

test("does not treat stationary or separating overlap as an approaching collision", () => {
  assert.equal(hasSweptCircleContact(
    { x: 11, y: 0 }, { x: 11, y: 0 },
    { x: 0, y: 0 }, { x: 0, y: 0 },
    6
  ), false);
  assert.equal(hasSweptCircleContact(
    { x: 11, y: 0 }, { x: 13, y: 0 },
    { x: 0, y: 0 }, { x: 0, y: 0 },
    6
  ), false);
});

test("uses unwrapped relative motion for same-orbit approach", () => {
  assert.equal(isAngularlyApproaching(0, 0.3, 0.2, 0.4), true);
  assert.equal(isAngularlyApproaching(0, 0.2, 0.2, 0.4), false);
});
