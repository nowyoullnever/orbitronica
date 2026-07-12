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
  assert.doesNotMatch(source, /customEdit\([^\n]+accelerator/);
});
