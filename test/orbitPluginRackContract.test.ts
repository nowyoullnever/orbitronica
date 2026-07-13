import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/renderer/components/OrbitSettingsPanel.tsx", import.meta.url), "utf8");
const rack = fs.readFileSync(new URL("../src/renderer/audio/wamRack.ts", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");

test("plugin rack exposes a generic catalog-driven Add selector", () => {
  assert.match(panel, />Add<\/button>/);
  assert.match(panel, /Object\.values\(WAM_CATALOG\)/);
  assert.match(panel, /entry\.displayName/);
  assert.match(panel, /onAddPlugin\(orbit\.id, entry\.id\)/);
  assert.match(panel, /onAddPlugin: \(orbitId: string, catalogId: WamCatalogId\) => void/);
  assert.match(panel, /aria-haspopup="menu"/);
  assert.match(panel, /aria-expanded=/);
  assert.match(panel, /aria-controls=/);
  assert.doesNotMatch(panel, /Add Burns Simple Delay/);
  assert.doesNotMatch(panel, /catalog\?\.id === "burns-simple-delay"/);
  assert.match(panel, /onMovePlugin/);
  assert.match(panel, /onBypassPlugin/);
  assert.match(panel, /onRemovePlugin/);
  assert.match(panel, /Plugin unavailable; its saved state is retained/);
});

test("plugin rack headers derive from catalog display names with a stale-id fallback", () => {
  assert.match(panel, /getWamCatalogEntry\(slot\.catalogId\)\?\.displayName\s*\?\?\s*"Unavailable plugin"/);
});

test("App resolves catalog identity before allocation or mutation and permits duplicates", () => {
  assert.match(app, /onAddPlugin=\{\(orbitId, catalogId\) => \{/);
  const handlerStart = app.indexOf("onAddPlugin={(orbitId, catalogId) => {");
  assert.notEqual(handlerStart, -1);
  const handler = app.slice(handlerStart, app.indexOf("onMovePlugin=", handlerStart));
  const lookup = handler.indexOf("getWamCatalogEntry(catalogId)");
  const allocation = handler.indexOf("projectId()");
  const mutation = handler.indexOf("changeOrbitPlugins(");
  assert.ok(lookup >= 0, "App must perform the runtime catalog lookup");
  assert.ok(allocation > lookup, "catalog lookup must precede ID allocation");
  assert.ok(mutation > lookup, "catalog lookup must precede history/document/runtime mutation");
  assert.match(handler, /if \(!entry\) return/);
  assert.match(handler, /catalogId: entry\.id/);
  assert.match(handler, /pluginVersion: entry\.pluginVersion/);
  assert.doesNotMatch(handler, /plugins\.(?:some|find)\([^)]*catalogId/,
    "duplicate instances must not be rejected");
});

test("plugin GUI lifecycle awaits creation and cleans late or StrictMode-unmounted GUI", () => {
  assert.match(panel, /void onMount\(slot\.id, container\)/);
  assert.match(panel, /void onUnmount\(slot\.id\)/);
  assert.match(rack, /const gui = await createGui\(\)/);
  assert.match(rack, /this\.startGuiCleanup\(instance, gui, slotId\)/);
  assert.match(rack, /ownedGui\.gui\.remove\(\)/);
});
