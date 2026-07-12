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

test("scene transitions advance playback epochs and reject stale Canvas callback payloads", () => {
  const activate = body("activateScene", "commitSceneDocument");
  const transition = body("prepareActiveSceneTransition", "activateScene");
  const soundGate = body("canOrbitSound", "deletePlanet");
  assert.match(activate, /resetParameterHistoryWindow\(\)/);
  assert.match(activate, /scheduleScenePluginTransition/);
  assert.match(transition, /designateAudibleScene/);
  assert.match(transition, /playbackEpoch\.current \+= 1/);
  assert.match(soundGate, /audibleSceneId\.current/);
  assert.match(soundGate, /epoch === playbackEpoch\.current/);
  assert.match(app, /playbackEpoch=\{playbackEpoch\.current\}/);
  assert.match(app, /onLoopFrame=\{\(orbit, planet, bar, inside, angle, callback\)/);
  assert.match(app, /onSequencePlay=\{\(orbit, planet, bar, callback\)/);
  assert.match(app, /onSequenceStop=\{\(orbitId, callback\)/);
  assert.match(app, /!isCurrentPlaybackCallback\(callback\.sceneId, callback\.epoch\)/);
});

test("all document replacement paths reconcile the active WAM scene", () => {
  const undoRedo = body("restoreSnapshot", "undo");
  const duplicate = body("duplicateOrbit", "copyPlanet");
  const open = body("openProject", "toggleRecording");
  assert.match(undoRedo, /scheduleScenePluginTransition/);
  assert.match(duplicate, /reconcileOrbitPlugins\(duplicate\)/);
  assert.match(open, /restoredActiveOrbits/);
  assert.match(open, /scheduleScenePluginTransition\(previousOrbits, restoredActiveOrbits/);
});

test("multi-file imports pin their starting scene but allow unrelated target edits after decode", () => {
  const imports = body("handleFiles", "saveProject");
  const createOrbit = body("createOrbitFromAudio", "handleFiles");
  const publish = body("publishPreRecordedSceneEdit", "addScene");
  assert.match(imports, /const batchSceneId = stateRef\.current\.activeSceneId/);
  assert.match(imports, /createOrbitFromAudio\(audioFiles\[index\], point, index, batchSceneId\)/);
  assert.match(createOrbit, /if \(!currentTarget\)/);
  assert.match(createOrbit, /impliedSpliceBarIds\(orbit\)\.includes\(orbitId\)/);
  assert.doesNotMatch(createOrbit, /durableSceneStructureToken/);
  assert.doesNotMatch(publish, /pruneUnreferencedAudio/);
});

test("splice reservations occur only after the replacement has been validated and computed", () => {
  for (const source of [
    body("setOrbitSpliceCount", "setOrbitSpliceStart"),
    body("setOrbitSpliceStart", "duplicateOrbit")
  ]) {
    const replacement = source.indexOf("const next = replaceOrbitSpliceSettings");
    const reserve = source.indexOf("projectIds.current.reserveDerived");
    assert.ok(replacement >= 0 && reserve > replacement);
  }
});
