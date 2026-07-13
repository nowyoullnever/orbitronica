import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/renderer/components/OrbitSettingsPanel.tsx", import.meta.url), "utf8");
const rack = fs.readFileSync(new URL("../src/renderer/audio/wamRack.ts", import.meta.url), "utf8");

test("plugin rack exposes only the trusted catalog add action and structural controls", () => {
  assert.match(panel, /Add Burns Simple Delay/);
  assert.match(panel, /onMovePlugin/);
  assert.match(panel, /onBypassPlugin/);
  assert.match(panel, /onRemovePlugin/);
  assert.match(panel, /Plugin unavailable; its saved state is retained/);
});

test("plugin GUI lifecycle awaits creation and cleans late or StrictMode-unmounted GUI", () => {
  assert.match(panel, /void onMount\(slot\.id, container\)/);
  assert.match(panel, /void onUnmount\(slot\.id\)/);
  assert.match(rack, /const gui = await createGui\(\)/);
  assert.match(rack, /await this\.unmountGui\(runtime\.slotId, runtime\)/);
});
