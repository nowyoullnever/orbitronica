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
  assert.match(record, /Burns Simple EQ/);
  assert.match(record, /Orbitronica Overdrive/);
  assert.match(record, /Burns Distortion is not bundled/);
  assert.match(record, /burns-audio-wam@0\.2\.54/);
  assert.match(record, /03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d/);
  assert.match(record, /file:\/\//);
  assert.match(record, /nine hash-locked effects/i);
  assert.match(record, /isolated temporary builds/i);
  assert.match(record, /25 repeated rack lifecycle cycles/i);
  assert.match(record, /queue.*circuit-breaker/is);
  assert.match(packageJson, /"@webaudiomodules\/sdk": "0\.0\.12"/);
  assert.match(packageJson, /"smoke:packaged-wam"/);

  assert.match(record, /PDC.*getCompensationDelay.*excluded/is);
  assert.match(record, /inter-orbit drift/i);

  assert.deepEqual(Object.keys(manifest.assets).sort(), ["NOTICE.txt", "descriptor.json", "index.js", "screenshot.png"]);
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
  assert.match(rendererSmoke, /paramMgr\.setState\(probe\)/);
  assert.match(rendererSmoke, /minimal-wamprocessor-packaged-proof/);
  assert.match(rendererSmoke, /proveMinimalWamProcessor/);
  assert.match(harness, /rackRemovalCompleted/);
  assert.match(harness, /cleanupDidNotBlockHost/);
  assert.match(main, /wam-smoke\.html/);
  assert.equal(path.basename(new URL("public/wam/burns-simple-delay/index.js", root).pathname), "index.js");
});

test("first-party effects are cataloged with byte-copied, hash-locked manifests", () => {
  const catalog = read("src/renderer/audio/wamCatalogData.ts");
  for (const id of ["orbitronica-filter", "orbitronica-compressor", "orbitronica-bitcrusher", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"]) {
    const sourceManifest = read(`plugins/src/${id}/manifest.json`);
    const publicManifest = read(`public/wam/${id}/manifest.json`);
    const manifest = JSON.parse(publicManifest) as { assets: Record<string, string>; origin: string; sourcePath: string; buildTool: string };
    assert.match(catalog, new RegExp(`id: "${id}"`));
    assert.match(catalog, new RegExp(`entry: "wam/${id}/index\\.js"`));
    assert.equal(manifest.origin, "first-party");
    assert.equal(manifest.sourcePath, `plugins/src/${id}`);
    assert.equal(manifest.buildTool, "esbuild@0.25.12");
    assert.equal(publicManifest, sourceManifest, "public manifest is copied byte-for-byte from canonical source");
    assert.deepEqual(Object.keys(manifest.assets).sort(), ["NOTICE.txt", "descriptor.json", "index.js"]);
    for (const [file, expectedHash] of Object.entries(manifest.assets)) {
      const actualHash = createHash("sha256").update(fs.readFileSync(new URL(`public/wam/${id}/${file}`, root))).digest("hex");
      assert.equal(actualHash, expectedHash, `${id}/${file} must match the first-party manifest`);
    }
  }
});

test("Phase 1 vendored EQ retains pinned provenance and the documented fallback is packaged", () => {
  const eqManifest = JSON.parse(read("public/wam/burns-simple-eq/manifest.json")) as { origin: string; packageSha256: string; npmIntegrity: string; gitHead: string; assets: Record<string, string> };
  assert.equal(eqManifest.origin, "vendored");
  assert.equal(eqManifest.packageSha256, "03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d");
  assert.match(eqManifest.npmIntegrity, /^sha512-/); assert.equal(eqManifest.gitHead, "30869512b1efe5743576cb43e124f62c14b43018");
  assert.deepEqual(Object.keys(eqManifest.assets).sort(), ["NOTICE.txt", "descriptor.json", "index.js", "screenshot.png"]);
  for (const [file, expected] of Object.entries(eqManifest.assets)) assert.equal(createHash("sha256").update(fs.readFileSync(new URL(`public/wam/burns-simple-eq/${file}`, root))).digest("hex"), expected);
  const fallbackSource = read("plugins/src/orbitronica-overdrive/index.ts"), fallbackManifest = JSON.parse(read("public/wam/orbitronica-overdrive/manifest.json")) as { origin: string; assets: Record<string, string> };
  assert.match(fallbackSource, /documented Burns Distortion fallback|OrbitronicaOverdrive/); assert.equal(fallbackManifest.origin, "first-party");
  assert.deepEqual(Object.keys(fallbackManifest.assets).sort(), ["NOTICE.txt", "descriptor.json", "index.js"]);
  assert.match(read("plugins/src/orbitronica-overdrive/NOTICE.txt"), /fallback/i);
});

test("first-party build ownership cannot rewrite immutable Burns payloads", () => {
  const builder = read("scripts/build-plugins.mjs");
  assert.match(builder, /firstPartyIds = \["orbitronica-filter", "orbitronica-overdrive", "orbitronica-compressor", "orbitronica-bitcrusher", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"\]/);
  assert.doesNotMatch(builder, /burns-simple-eq|burns-distortion/);
  const eq = JSON.parse(read("public/wam/burns-simple-eq/manifest.json")) as { origin: string; assets: Record<string, string> };
  assert.equal(eq.origin, "vendored");
  for (const [file, expected] of Object.entries(eq.assets)) assert.equal(createHash("sha256").update(fs.readFileSync(new URL(`public/wam/burns-simple-eq/${file}`, root))).digest("hex"), expected);
});

test("compressor DSP acceptance runs in packaged Chromium with native-reference metrics", () => {
  const packageJson = read("package.json");
  const harness = read("scripts/wam-dsp-test.mjs");
  const renderer = read("src/renderer/wamDspTest.ts");
  const main = read("src/main/electron.ts");
  assert.match(packageJson, /"test:wam-dsp"/);
  assert.match(harness, /--wam-dsp-test/);
  assert.match(harness, /ORBITRONICA_WAM_DSP/);
  assert.match(renderer, /OfflineAudioContext/);
  assert.match(renderer, /DynamicsCompressor/);
  for (const parameter of ["threshold", "knee", "ratio", "attack", "release", "makeupGain"]) assert.match(renderer, new RegExp(`check\\("${parameter}"`));
  assert.match(renderer, /44_100/); assert.match(renderer, /48_000/);
  assert.match(renderer, /finite-bounded-stereo-extremes/);
  assert.match(main, /wam-dsp-test\.html/);
});

test("bitcrusher DSP acceptance is packaged, quantitative, and precedes DSP with a WamProcessor proof", () => {
  const renderer = read("src/renderer/wamDspTest.ts");
  assert.match(renderer, /proveMinimalWamProcessor/);
  assert.match(renderer, /quantized-levels-and-error/);
  assert.match(renderer, /exact-independent-stereo-holds/);
  assert.match(renderer, /equal-power-projection/);
  assert.match(renderer, /orbitronica-bitcrusher/);
  assert.match(renderer, /44_100/); assert.match(renderer, /48_000/);
});


test("Phase 4 flanger/phaser retain bounded fixed-graph topology and packaged DSP coverage", () => {
  const flanger = read("plugins/src/orbitronica-flanger/index.ts"), phaser = read("plugins/src/orbitronica-phaser/index.ts"), harness = read("src/renderer/wamDspTest.ts");
  for (const parameter of ["rate", "depth", "feedback", "mix"]) assert.match(flanger, new RegExp(parameter));
  assert.match(flanger, /lfo\.start\(\)/); assert.match(flanger, /lfo\.stop\(\)/);
  assert.match(phaser, /for \(let i = 0; i < 8; i\+\+\)/); assert.match(phaser, /cycleBreak\.delayTime\.value = 1 \/ context\.sampleRate/);
  assert.match(phaser, /wetBus\.connect\(this\.feedbackGain\)/); assert.match(phaser, /feedbackGain\.connect\(this\.limiter\)/); assert.match(phaser, /limiter\.connect\(this\.cycleBreak\)/); assert.match(phaser, /cycleBreak\.connect\(this\.stages\[0\]\)/);
  assert.match(harness, /phase4Metrics/); assert.match(harness, /orbitronica-phaser/); assert.match(harness, /orbitronica-flanger/);
});

test("Phase 5 reverb is a clean-room, rate-scaled stereo comb/allpass graph with packaged acceptance", () => {
  const reverb = read("plugins/src/orbitronica-reverb/index.ts"), evidence = read("plugins/src/orbitronica-reverb/clean-room-evidence.md"), notice = read("plugins/src/orbitronica-reverb/NOTICE.txt"), harness = read("src/renderer/wamDspTest.ts");
  assert.match(evidence, /85fd86a014b40219a63ae1016955f87c37a27b5d/); assert.match(evidence, /a7c89f728a4e7a1fa6403c178d8d04f5616e12ef93ffea9ecdc432ca91641851/); assert.match(evidence, /reviewer sign-off/i);
  assert.match(reverb, /COMB_REFERENCE_FRAMES/); assert.match(reverb, /ALLPASS_REFERENCE_FRAMES/); assert.match(reverb, /scaledDelay/); assert.match(reverb, /for \(const frames of COMB_REFERENCE_FRAMES\[side\]\)/); assert.match(reverb, /for \(const frames of ALLPASS_REFERENCE_FRAMES\[side\]\)/);
  for (const parameter of ["roomSize", "damping", "width", "mix"]) assert.match(reverb, new RegExp(parameter));
  assert.match(reverb, /schemaVersion !== 0/); assert.match(reverb, /invalid-reverb-state/); assert.match(reverb, /unsupported-reverb-state/);
  assert.match(notice, /Jezar at Dreampoint/); assert.match(notice, /GPL\/LGPL-derived port code/);
  assert.match(read("scripts/verify-reverb-clean-room.mjs"), /prohibited derivative material/); assert.match(read("package.json"), /verify:reverb-clean-room/);
  for (const metric of ["impulse-tail-length", "high-frequency-tail-reduction", "stereo-decorrelation", "scaled-tuning", "strict-round-trip-and-v0-migration"]) assert.match(harness, new RegExp(metric));
  assert.match(harness, /phase5Metrics/); assert.match(harness, /orbitronica-reverb/);
});
