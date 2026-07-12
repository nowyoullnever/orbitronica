import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/renderer/components/PreferencesModal.tsx", import.meta.url), "utf8");

test("preferences modal moves focus into the dialog and restores its opener on unmount", () => {
  assert.match(source, /const previouslyFocused = document\.activeElement/);
  assert.match(source, /closeButton\.current\?\.focus\(\)/);
  assert.match(source, /previouslyFocused instanceof HTMLElement && previouslyFocused\.isConnected/);
  assert.match(source, /previouslyFocused\.focus\(\)/);
});

test("preferences modal retains dialog accessibility semantics", () => {
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /event\.key === "Escape"/);
});
