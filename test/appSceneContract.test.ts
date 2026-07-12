import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
const body = (name: string, nextName: string) => {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `could not locate ${name}`);
  return app.slice(start, end);
};

test("splice gesture frames publish without creating a second history boundary", () => {
  for (const source of [
    body("setOrbitSpliceCount", "setOrbitSpliceStart"),
    body("setOrbitSpliceStart", "duplicateOrbit")
  ]) {
    assert.match(source, /publishPreRecordedSceneEdit\(next\)/);
    assert.doesNotMatch(source, /commitSceneDocument\(next/);
    assert.doesNotMatch(source, /pushHistory\(/);
  }
  assert.match(app, /onBeginMutation=\{pushHistory\}/);
  assert.match(app, /pushParameterHistory\(\);\s*setOrbitSpliceCount/);
});

test("project open preflights and swaps a fresh allocator around the audio transaction", () => {
  const source = body("openProject", "toggleRecording");
  const preflight = source.indexOf("createProjectIdAllocatorForScenes(restoredScenes");
  const transaction = source.indexOf("runStagedDocumentTransaction");
  const audioReplace = source.indexOf("replaceProjectAudio");
  const swap = source.indexOf("projectIds.current = restoredProjectIds");
  assert.ok(preflight >= 0 && preflight < transaction && transaction < audioReplace && audioReplace < swap);
});
