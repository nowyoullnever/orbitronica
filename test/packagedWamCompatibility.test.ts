import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("packaged WAM gate remains disabled until a licensed file-origin smoke exists", () => {
  const record = read("docs/packaged-wam-compatibility.md");
  const packageJson = read("package.json");
  assert.match(record, /Status: disabled/i);
  assert.match(record, /Burns Simple Delay/);
  assert.match(record, /burns-audio-wam@0\.2\.54/);
  assert.match(record, /03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d/);
  assert.match(record, /file:\/\//);
  assert.match(record, /queue\/backpressure/i);
  assert.match(record, /circuit-breaker/i);
  assert.match(packageJson, /"@webaudiomodules\/sdk": "0\.0\.12"/);
  assert.match(packageJson, /"electron-builder": "\^25\.1\.8"/);
});
