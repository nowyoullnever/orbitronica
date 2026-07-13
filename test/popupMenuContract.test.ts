import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  clampPopupPosition,
  navigateMenuIndex
} from "../src/renderer/components/popupMenuModel.ts";

const popup = fs.readFileSync(new URL("../src/renderer/components/PopupMenu.tsx", import.meta.url), "utf8");
const contextMenu = fs.readFileSync(new URL("../src/renderer/components/ContextMenu.tsx", import.meta.url), "utf8");
const orbitSettings = fs.readFileSync(new URL("../src/renderer/components/OrbitSettingsPanel.tsx", import.meta.url), "utf8");

test("clampPopupPosition keeps ordinary and oversized menus inside the safety margin", () => {
  const popupSize = { width: 100, height: 80 };
  const viewportSize = { width: 400, height: 300 };

  assert.deepEqual(clampPopupPosition({ x: 20, y: 30 }, popupSize, viewportSize), { x: 20, y: 30 });
  assert.deepEqual(clampPopupPosition({ x: -20, y: -30 }, popupSize, viewportSize), { x: 8, y: 8 });
  assert.deepEqual(clampPopupPosition({ x: 390, y: 290 }, popupSize, viewportSize), { x: 292, y: 212 });
  assert.deepEqual(
    clampPopupPosition({ x: 200, y: 150 }, { width: 500, height: 400 }, viewportSize),
    { x: 8, y: 8 },
    "a menu larger than its viewport has a deterministic top-left fallback"
  );
});

test("navigateMenuIndex wraps, jumps to boundaries, and handles an empty menu", () => {
  assert.equal(navigateMenuIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(navigateMenuIndex(2, 3, "ArrowDown"), 0);
  assert.equal(navigateMenuIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(navigateMenuIndex(0, 3, "ArrowUp"), 2);
  assert.equal(navigateMenuIndex(1, 3, "Home"), 0);
  assert.equal(navigateMenuIndex(1, 3, "End"), 2);
  assert.equal(navigateMenuIndex(0, 0, "ArrowDown"), -1);
  assert.equal(navigateMenuIndex(0, 0, "Home"), -1);
});

test("PopupMenu owns typed, idempotent first-close-wins dismissal", () => {
  for (const reason of [
    "selection", "escape", "outside-pointer", "resize", "scroll", "owner-change", "focus-leave"
  ]) assert.match(popup, new RegExp(`\\"${reason}\\"`));
  assert.match(popup, /close(?:d|Requested|Reason)?Ref/,
    "a synchronous ref must arbitrate overlapping dismissal signals");
  assert.match(popup, /if \([^)]*\.current\) return/,
    "later close requests must be ignored");
  assert.match(popup, /\.current\s*=\s*true/,
    "the first close request must win before invoking the owner");
});

test("PopupMenu installs and cleans complete dismissal listeners", () => {
  assert.match(popup, /addEventListener\("pointerdown",[^]*true\)/);
  assert.match(popup, /addEventListener\("resize"/);
  assert.match(popup, /addEventListener\("scroll",[^]*true\)/);
  assert.match(popup, /removeEventListener\("pointerdown"/);
  assert.match(popup, /removeEventListener\("resize"/);
  assert.match(popup, /removeEventListener\("scroll"/);
  assert.match(popup, /focus-leave/);
});

test("PopupMenu isolates focused keyboard commands without trapping Tab", () => {
  assert.match(popup, /role="menu"/);
  assert.match(popup, /role="menuitem"/);
  assert.match(popup, /preventDefault\(\)/);
  assert.match(popup, /stopPropagation\(\)/);
  for (const key of ["Enter", " ", "Delete", "Backspace"]) assert.match(popup, new RegExp(`\\"${key}\\"`));
  assert.match(popup, /event\.key\.length\s*===\s*1/,
    "unmodified printable keys must not leak to App shortcuts");
  assert.match(popup, /event\.key\s*===\s*"Tab"/);
  assert.doesNotMatch(popup, /event\.key\s*===\s*"Tab"[^]{0,160}preventDefault/,
    "Tab must remain non-trapping");
  assert.match(popup, /querySelectorAll[^]*(?:disabled|aria-disabled)/,
    "initial focus and navigation must consider enabled rows only");
  assert.match(popup, /tabIndex=\{-1\}/,
    "an empty menu needs a focusable root so Escape remains locally owned");
  assert.match(popup, /(?:firstItem|enabledMenuItems\(menu\)\[0\])[^]{0,120}\?\?\s*menu/,
    "initial focus must fall back to the menu root when there are no enabled rows");
});

test("OrbitSettingsPanel routes owner changes through PopupMenu's close arbiter", () => {
  assert.match(popup, /ownerKey\??:/, "PopupMenu must expose a domain-neutral owner identity");
  assert.match(popup, /requestClose\("owner-change"\)/,
    "owner changes must use the same typed first-close-wins path as other dismissal signals");
  assert.match(orbitSettings, /ownerKey=\{orbit\.id\}/,
    "the rack selector must wire its orbit identity into PopupMenu");
  assert.doesNotMatch(orbitSettings, /useEffect\(\(\) => setSelectorPosition\(null\), \[orbit\.id\]\)/,
    "the owner must not bypass PopupMenu's synchronous dismissal arbiter");
});

test("ContextMenu renders its unchanged commands through PopupMenu", () => {
  assert.match(contextMenu, /import \{[^}]*PopupMenu[^}]*\} from "\.\/PopupMenu"/);
  assert.match(contextMenu, /<PopupMenu/);
  for (const command of [
    "Copy Planet", "Paste Planet Here", "Add Play Bar", "Add Stop Bar",
    "Toggle Loop / Sequence", "Pause / Resume Orbit", "Duplicate Orbit", "Upload Audio"
  ]) assert.match(contextMenu, new RegExp(command));
  assert.match(contextMenu, /propagateEscape/,
    "canvas ContextMenu must preserve App-level Escape effects explicitly");
});
