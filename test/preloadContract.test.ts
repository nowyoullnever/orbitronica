import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("sandboxed preload source and build contract require a CommonJS artifact", () => {
  const electron = read("src/main/electron.ts");
  const preload = read("src/main/preload.cts");
  const tsconfig = read("tsconfig.node.json");
  const packageJson = JSON.parse(read("package.json")) as { scripts: { build: string } };

  assert.match(electron, /preload:\s*path\.join\(__dirname,\s*["']preload\.cjs["']\)/);
  assert.match(electron, /sandbox:\s*true/);
  assert.match(electron, /contextIsolation:\s*true/);
  assert.match(electron, /nodeIntegration:\s*false/);
  assert.match(tsconfig, /src\/main\/preload\.cts/);
  assert.match(packageJson.scripts.build, /verify-preload\.mjs/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(["']orbitonicAPI["']/);
  for (const channel of ["project:save", "project:open", "recording:save"]) {
    assert.ok(preload.includes(channel));
  }
});
