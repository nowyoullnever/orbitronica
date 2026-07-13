import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_PAYLOAD_LIMITS, validateProjectSavePayload } from "../src/main/projectPayload.ts";

const valid = () => ({
  project: { schemaVersion: 6, appName: "Orbitronica", pluginStates: {} },
  assets: [{ orbitId: "orbit", fileName: "tone.wav", bytes: new Uint8Array([1, 2]) }]
});

test("project save payload boundary accepts bounded structured clone data", () => {
  assert.doesNotThrow(() => validateProjectSavePayload(valid()));
});

test("project save payload boundary rejects malformed, duplicate, and oversized renderer input", () => {
  assert.throws(() => validateProjectSavePayload({}), /malformed/);
  const duplicate = valid();
  duplicate.assets.push({ orbitId: "orbit", fileName: "other.wav", bytes: new Uint8Array() });
  assert.throws(() => validateProjectSavePayload(duplicate), /duplicate/);
  const tooMany = valid();
  tooMany.assets = Array.from({ length: PROJECT_PAYLOAD_LIMITS.maxAssets + 1 }, (_, index) => ({
    orbitId: String(index), fileName: "a.wav", bytes: new Uint8Array()
  }));
  assert.throws(() => validateProjectSavePayload(tooMany), /too many/);
  const oversized = valid();
  oversized.assets[0].bytes = new Uint8Array(PROJECT_PAYLOAD_LIMITS.maxAssetBytes + 1);
  assert.throws(() => validateProjectSavePayload(oversized), /size limit/);
});
