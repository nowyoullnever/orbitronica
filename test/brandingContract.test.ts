import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("all user-facing application identity surfaces say Orbitronica", () => {
  const packageJson = JSON.parse(read("package.json")) as { build: { appId: string; productName: string } };
  const index = read("index.html");
  const electron = read("src/main/electron.ts");
  const app = read("src/renderer/App.tsx");
  const serializer = read("src/renderer/project/projectSerializer.ts");

  assert.equal(packageJson.build.appId, "com.orbitronica.app");
  assert.equal(packageJson.build.productName, "Orbitronica");
  assert.match(index, /<title>Orbitronica<\/title>/);
  assert.match(electron, /app\.setName\("Orbitronica"\)/);
  assert.ok(electron.indexOf('app.setName("Orbitronica")') < electron.indexOf("app.whenReady()"));
  assert.match(electron, /title: "Orbitronica"/);
  assert.match(electron, /Save Orbitronica Project/);
  assert.match(electron, /Open Orbitronica Project/);
  assert.match(app, />ORBITRONICA</);
  assert.match(serializer, /valid Orbitronica project/);
  assert.match(serializer, /Unsupported Orbitronica schema version/);
});

test("branding writes v6 Orbitronica while retaining legacy v5 and preload compatibility", () => {
  const serializer = read("src/renderer/project/projectSerializer.ts");
  const types = read("src/renderer/state/types.ts");
  const preload = read("src/main/preload.cts");
  const globals = read("src/renderer/global.d.ts");

  assert.match(serializer, /appName: "Orbitronica"/);
  assert.match(serializer, /raw\.appName !== "Orbitonic"/);
  assert.match(types, /appName: "Orbitronica"/);
  assert.match(preload, /exposeInMainWorld\("orbitonicAPI"/);
  assert.match(globals, /orbitonicAPI\?:/);
});
