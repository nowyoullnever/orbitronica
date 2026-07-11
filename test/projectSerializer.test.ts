import assert from "node:assert/strict";
import test from "node:test";
import { serializeProject } from "../src/renderer/project/projectSerializer.ts";

test("persists only manual bars because splice bars are derived", () => {
  const project = serializeProject("test", [], [], [
    { id: "manual", orbitId: "orbit", angle: 0, lengthRadians: 1, startAngle: 0, kind: "play" },
    { id: "splice", orbitId: "orbit", angle: 1, lengthRadians: 1, startAngle: 1, kind: "play", source: "splice" }
  ], 1, { orbitId: null, planetId: null, barId: null });

  assert.deepEqual(project.bars.map((bar) => bar.id), ["manual"]);
});
