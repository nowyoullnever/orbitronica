import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file: string) => fs.readFileSync(new URL(file, root), "utf8");
const assetPath = (file: string) => new URL(`public/wam/burns-simple-delay/${file}`, root);

test("frozen trusted WAM payload is hash-locked and packaged file smoke is required", () => {
  const record = read("docs/packaged-wam-compatibility.md");
  const packageJson = read("package.json");
  const manifest = JSON.parse(read("public/wam/burns-simple-delay/manifest.json")) as {
    assets: Record<string, string>;
  };

  assert.match(record, /Status: enabled-file/i);
  assert.match(record, /Burns Simple Delay/);
  assert.match(record, /burns-audio-wam@0\.2\.54/);
  assert.match(record, /03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d/);
  assert.match(record, /file:\/\//);
  assert.match(record, /sharedArrayBuffer: false/);
  assert.match(record, /queue.*circuit-breaker/is);
  assert.match(packageJson, /"@webaudiomodules\/sdk": "0\.0\.12"/);
  assert.match(packageJson, /"smoke:packaged-wam"/);

  assert.match(record, /PDC.*getCompensationDelay.*excluded/is);
  assert.match(record, /inter-orbit drift/i);

  assert.deepEqual(Object.keys(manifest.assets).sort(), ["descriptor.json", "index.js", "screenshot.png"]);
  for (const [file, expectedHash] of Object.entries(manifest.assets)) {
    const actualHash = createHash("sha256").update(fs.readFileSync(assetPath(file))).digest("hex");
    assert.equal(actualHash, expectedHash, `${file} must match the frozen manifest`);
  }
});

test("packaged smoke uses the real production Electron entry rather than the dev server", () => {
  const harness = read("scripts/packaged-wam-smoke.mjs");
  const rendererSmoke = read("src/renderer/wamPackagedSmoke.ts");
  const main = read("src/main/electron.ts");

  assert.match(harness, /--wam-smoke/);
  assert.match(harness, /readdirSync\(wamRoot/);
  assert.match(harness, /pluginCount \* 10_000/);
  assert.match(rendererSmoke, /initializeWamHost/);
  assert.match(rendererSmoke, /orbitronica-pcm-capture/);
  assert.match(rendererSmoke, /Object\.entries\(WAM_CATALOG\)/);
  assert.match(rendererSmoke, /asset-fetch-import/);
  assert.match(rendererSmoke, /rack\.reconcile\(\[\]\)/);
  assert.match(harness, /rackRemovalCompleted/);
  assert.match(harness, /cleanupDidNotBlockHost/);
  assert.match(main, /wam-smoke\.html/);
  assert.equal(path.basename(new URL("public/wam/burns-simple-delay/index.js", root).pathname), "index.js");
});

test("first-party filter is cataloged with a byte-copied, hash-locked manifest", () => {
  const catalog = read("src/renderer/audio/wamCatalogData.ts");
  const sourceManifest = read("plugins/src/orbitronica-filter/manifest.json");
  const publicManifest = read("public/wam/orbitronica-filter/manifest.json");
  const manifest = JSON.parse(publicManifest) as { assets: Record<string, string>; origin: string; sourcePath: string; buildTool: string };
  assert.match(catalog, /id: "orbitronica-filter"/);
  assert.match(catalog, /entry: "wam\/orbitronica-filter\/index\.js"/);
  assert.equal(manifest.origin, "first-party");
  assert.equal(manifest.sourcePath, "plugins/src/orbitronica-filter");
  assert.equal(manifest.buildTool, "esbuild@0.25.12");
  assert.equal(publicManifest, sourceManifest, "public manifest is copied byte-for-byte from canonical source");
  assert.deepEqual(Object.keys(manifest.assets).sort(), ["NOTICE.txt", "descriptor.json", "index.js"]);
  for (const [file, expectedHash] of Object.entries(manifest.assets)) {
    const actualHash = createHash("sha256").update(fs.readFileSync(new URL(`public/wam/orbitronica-filter/${file}`, root))).digest("hex");
    assert.equal(actualHash, expectedHash, `${file} must match the first-party manifest`);
  }
});
