import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("recording saves are constrained to WAV and renderer recording is reentrancy guarded", () => {
  const main = fs.readFileSync(new URL("src/main/electron.ts", root), "utf8");
  const app = fs.readFileSync(new URL("src/renderer/App.tsx", root), "utf8");

  assert.match(main, /name: "WAV Audio", extensions: \["wav"\]/);
  assert.match(main, /\/\\\.wav\$\/i\.test\(result\.filePath\)/);
  assert.match(main, /\$\{result\.filePath\}\.wav/);
  assert.match(app, /const recordingInFlight = useRef\(false\)/);
  assert.match(app, /if \(recordingInFlight\.current\) return;/);
  assert.match(app, /recordingInFlight\.current = false;/);
});
