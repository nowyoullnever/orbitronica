import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  collectProjectOrbits, describeProjectAssets, portableAudioPath,
  resolveProjectAssetPath, rewriteProjectAudioPaths
} from "../src/main/projectAssets.ts";

test("v5 traversal and rewrite cover every nested orbit without mutating other fields", () => {
  const project = {
    schemaVersion: 5,
    projectName: "Nested",
    scenes: [
      { id: "a", name: "A", untouched: { value: 1 }, orbits: [{ id: "one", audioName: "same.wav" }] },
      { id: "b", name: "B", orbits: [{ id: "two", audioName: "same.wav", audioPath: "old.wav" }] }
    ]
  };
  assert.deepEqual(collectProjectOrbits(project).map((orbit) => orbit.id), ["one", "two"]);
  const rewritten = rewriteProjectAudioPaths(project, new Map([
    ["one", "audio/001_same.wav"], ["two", "audio/002_same.wav"]
  ]));
  assert.notEqual(rewritten, project);
  assert.equal(project.scenes[0].orbits[0].audioPath, undefined);
  assert.equal(rewritten.scenes[0].orbits[0].audioPath, "audio/001_same.wav");
  assert.equal(rewritten.scenes[1].orbits[0].audioPath, "audio/002_same.wav");
  assert.deepEqual(rewritten.scenes[0].untouched, { value: 1 });
  assert.equal(rewritten.projectName, "Nested");
});

test("legacy top-level v4 and unversioned traversal remains compatible", () => {
  const project = { schemaVersion: 4, orbits: [{ id: "legacy", audioPath: "audio/legacy.wav" }] };
  assert.deepEqual(collectProjectOrbits(project).map((orbit) => orbit.id), ["legacy"]);
  const rewritten = rewriteProjectAudioPaths(project, { legacy: "audio/new.wav" });
  assert.equal(rewritten.orbits[0].audioPath, "audio/new.wav");
  assert.deepEqual(collectProjectOrbits({ orbits: [{ id: "unversioned" }] }).map((orbit) => orbit.id), ["unversioned"]);
});

test("asset descriptors preserve orbit identity across scenes and reject path escape", () => {
  const root = path.resolve("/tmp/orbitonic-project");
  const project = {
    scenes: [
      { orbits: [{ id: "one", audioPath: "audio/001_same.wav" }] },
      { orbits: [{ id: "two", audioPath: "audio/002_same.wav" }, { id: "missing" }] }
    ]
  };
  const descriptors = describeProjectAssets(project, root);
  assert.deepEqual(descriptors.map((item) => item.orbitId), ["one", "two", "missing"]);
  assert.equal(descriptors[0].absolutePath, path.join(root, "audio/001_same.wav"));
  assert.equal(descriptors[1].absolutePath, path.join(root, "audio/002_same.wav"));
  assert.equal(descriptors[2].error, "No audio path saved.");
  assert.equal(resolveProjectAssetPath(root, "../secret.wav"), null);
  assert.match(describeProjectAssets({ orbits: [{ id: "bad", audioPath: "../secret.wav" }] }, root)[0].error!, /Unsafe/);
});

test("portable paths and malformed or empty project inputs are deterministic", () => {
  assert.equal(portableAudioPath("001 kick.wav"), "audio/001 kick.wav");
  assert.deepEqual(collectProjectOrbits(null), []);
  assert.deepEqual(collectProjectOrbits({ scenes: [{ orbits: null }, null, { orbits: [{ nope: true }] }] }), []);
  assert.deepEqual(describeProjectAssets({ scenes: [] }, "/tmp/project"), []);
});

test("prototype-like orbit IDs use explicit map entries and never inherit object paths", () => {
  const project = { scenes: [{ orbits: [{ id: "__proto__" }, { id: "toString" }] }] };
  const rewritten = rewriteProjectAudioPaths(project, new Map([
    ["__proto__", "audio/proto.wav"], ["toString", "audio/string.wav"]
  ]));
  assert.deepEqual(rewritten.scenes[0].orbits.map((orbit) => orbit.audioPath), [
    "audio/proto.wav", "audio/string.wav"
  ]);
  assert.equal(rewriteProjectAudioPaths(project, {}).scenes[0].orbits[0].audioPath, undefined);
});
