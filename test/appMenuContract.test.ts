import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("native menu routes focused-window actions without stealing canvas keyboard shortcuts", () => {
  const source = fs.readFileSync(new URL("../src/main/appMenu.ts", import.meta.url), "utf8");
  for (const action of ["open-project", "save-project", "save-project-as", "preferences"]) assert.ok(source.includes(action));
  assert.match(source, /BrowserWindow\.getFocusedWindow\(\)/);
  assert.match(source, /webContents\.send\("menu:action", action\)/);
  assert.match(source, /customEdit\("Undo", "undo"\)/);
  assert.match(source, /customEdit\("Redo", "redo"\)/);
  assert.match(source, /label: "Open…", accelerator: "CmdOrCtrl\+O"/);
  assert.match(source, /label: "Save", accelerator: "CmdOrCtrl\+S"/);
  assert.match(source, /label: "Save As…", accelerator: "CmdOrCtrl\+Shift\+S"/);
  assert.match(source, /label: "Preferences…",\s*accelerator: "CmdOrCtrl\+,"/);
  assert.doesNotMatch(source, /customEdit\([^\n]+accelerator/);
});

test("renderer leaves native File accelerators to their one IPC dispatch path", () => {
  const source = fs.readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const nativeMenuHandlesFileShortcuts = !!window\.orbitonicAPI\?\.onMenuAction/);
  assert.match(source, /command && key === "s" && !nativeMenuHandlesFileShortcuts/);
  assert.match(source, /command && key === "o" && !nativeMenuHandlesFileShortcuts/);
});
