import assert from "node:assert/strict";
import test from "node:test";
import { newProjectPath, projectDialogExtensions } from "../src/main/projectPaths.ts";

test("new project paths use .orb while preserving an existing .orb suffix case-insensitively", () => {
  assert.equal(newProjectPath("Session"), "Session.orb");
  assert.equal(newProjectPath("Session.orb"), "Session.orb");
  assert.equal(newProjectPath("Session.ORB"), "Session.ORB");
});

test("new project paths replace legacy and unrelated suffixes", () => {
  assert.equal(newProjectPath("Session.orbitonic"), "Session.orb");
  assert.equal(newProjectPath("Session.wav"), "Session.orb");
  assert.equal(newProjectPath("folder.with.dot/Session.txt"), "folder.with.dot/Session.orb");
});

test("open filters retain both new and legacy project extensions", () => {
  assert.deepEqual(projectDialogExtensions, ["orb", "orbitonic"]);
});
