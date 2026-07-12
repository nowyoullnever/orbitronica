import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("packaged WAM gate remains disabled until a licensed file-origin smoke exists", () => {
  const record = read("docs/packaged-wam-compatibility.md");
  const packageJson = read("package.json");
  assert.match(record, /Status: disabled/i);
  assert.match(record, /No exact trusted-effect candidate is selected/);
  assert.match(record, /file:\/\//);
  assert.match(record, /timeout, queue\/backpressure, and retry\/circuit-breaker/i);
  assert.match(packageJson, /"@webaudiomodules\/sdk": "0\.0\.12"/);
  assert.match(packageJson, /"electron-builder": "\^25\.1\.8"/);
});
