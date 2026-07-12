import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const artifact = path.resolve("dist-electron/preload.cjs");
assert.ok(fs.existsSync(artifact), `Missing CommonJS preload artifact: ${artifact}`);
const source = fs.readFileSync(artifact, "utf8");
assert.match(source, /require\(["']electron["']\)/, "Preload must load Electron through CommonJS require().");
assert.doesNotMatch(source, /^\s*import\s/m, "Preload artifact must not contain ESM imports.");
assert.match(source, /exposeInMainWorld\(["']orbitonicAPI["']/, "Preload must expose orbitonicAPI.");
for (const channel of ["project:save", "project:open", "recording:save", "preferences:get", "preferences:set", "menu:action"]) {
  assert.ok(source.includes(channel), `Preload is missing IPC channel ${channel}.`);
}
console.log(`Verified CommonJS preload: ${artifact}`);
