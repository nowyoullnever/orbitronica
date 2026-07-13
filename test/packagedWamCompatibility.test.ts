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
  const operationalRecord = read(".omx/specs/wam-compatibility-and-limits.md");
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

  // This decision record is the operational contract for the enabled gate;
  // keep the limits that make the bundled allowlist safe from being silently
  // weakened while the user-facing packaging note evolves.
  for (const requirement of [
    /\*\*Status:\*\*\s*`enabled-file`/i,
    /@webaudiomodules\/sdk@0\.0\.12/,
    /burns-audio-wam@0\.2\.54/,
    /file:\/\//,
    /SharedArrayBuffer:false/,
    /5,000 ms deadline/,
    /Two failures open a catalog circuit for 15,000 ms/,
    /redacted fixed ring of 64 entries/,
    /256 slots; 1,000,000 bytes/,
    /save.*stages every live state and commits none if any read fails/is,
    /PDC.*getCompensationDelay.*excluded/is,
    /Re-run `npm run verify:wam-assets`, `npm run build`, and\n`npm run smoke:packaged-wam`/
  ]) assert.match(operationalRecord, requirement);

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
  assert.match(harness, /path\.join\(dist, "wam", "burns-simple-delay"/);
  assert.match(rendererSmoke, /initializeWamHost/);
  assert.match(rendererSmoke, /orbitronica-pcm-capture/);
  assert.match(rendererSmoke, /await rack\.mountGui\(slot\.id, document\.body\)/);
  assert.match(rendererSmoke, /await Promise\.race\(\[/);
  assert.match(rendererSmoke, /rack\.reconcile\(\[\]\)/);
  assert.match(harness, /rackRemovalCompleted/);
  assert.match(harness, /cleanupDidNotBlockHost/);
  assert.match(main, /wam-smoke\.html/);
  assert.equal(path.basename(new URL("public/wam/burns-simple-delay/index.js", root).pathname), "index.js");
});
