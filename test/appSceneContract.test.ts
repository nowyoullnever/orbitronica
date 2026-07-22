import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
const speedPitch = fs.readFileSync(new URL("../src/renderer/hooks/useSpeedPitchProcessing.ts", import.meta.url), "utf8");
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

test("render producers use owner-scoped scheduler lifetimes instead of immortal cache-key requests", () => {
  assert.doesNotMatch(app, /processPlanetBuffer\(/);
  assert.doesNotMatch(speedPitch, /processPlanetBuffer\(/);
  assert.match(app, /ensureProcessedBuffer\([\s\S]*ownerId, priority, signal: controller\.signal/);
  assert.match(app, /duplicate-scene:\$\{duplicate\.id\}/);
  assert.match(app, /duplicate-orbit:\$\{newOrbitId\}/);
  assert.match(app, /paste:\$\{newPlanet\.orbitId\}/);
  assert.match(app, /project-open:\$\{projectRenderOwnerEpoch\}/);
  assert.match(app, /trim:\$\{trimOwnerEpoch\}/);
  assert.match(app, /abortRenderOwners/);
  assert.match(app, /startRenderOwner/);
  assert.match(app, /releaseRenderOwner/);
  assert.match(app, /abortRenderOwners\(\(ownerId\) => ownerId\.startsWith\("edit:"\)\)/);
  assert.match(app, /abortRenderOwners\(\(ownerId\) => ownerId\.startsWith\(`edit:\$\{current\.activeSceneId\}:`\)\)/);
  assert.match(app, /abortRenderOwners\(\(\) => true\)/);
  assert.match(speedPitch, /edit:\$\{sceneId\}:\$\{orbitId\}:\$\{planetId\}/);
  assert.match(speedPitch, /startRenderOwner\(ownerId\)/);
  assert.match(speedPitch, /releaseRenderOwner\(ownerId, controller\)/);
  assert.match(speedPitch, /priority: "selected", signal/);
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
  assert.match(undoRedo, /refreshCommittedSceneReadiness/);
  assert.match(duplicate, /reconcileOrbitPlugins\(duplicate\)/);
  assert.match(open, /refreshCommittedSceneReadiness\(restoredScenes, project\.activeSceneId/);
});

test("scene duplication maps plugin slots after audio staging and uses the normal gate-first transition", () => {
  const duplicate = body("duplicateActiveScene", "restoreSnapshot");
  const commit = body("commitSceneDocument", "publishPreRecordedSceneEdit");
  assert.ok(duplicate.indexOf("stageSceneDuplicate") < duplicate.indexOf("copyPluginStatesBySlotMap"));
  assert.match(duplicate, /createPluginSlotId: \(\) => projectId\(\)/);
  assert.match(duplicate, /removePluginSlotStates\(copiedPluginStateIds\)/);
  assert.match(commit, /refreshCommittedSceneReadiness\(nextScenes, nextActiveSceneId\)/);
});

test("metadata-only scene commits do not tear down an unchanged active WAM rack", () => {
  const commit = body("commitSceneDocument", "publishPreRecordedSceneEdit");
  const refresh = body("refreshCommittedSceneReadiness", "scheduleScenePluginTransition");
  assert.match(commit, /refreshCommittedSceneReadiness\(nextScenes, nextActiveSceneId\)/);
  assert.match(refresh, /changedScene/);
  assert.match(refresh, /sameSceneAudioRequirements/);
  assert.match(refresh, /if \(!changedScene && sameSceneAudioRequirements/);
});

test("same-scene audio requirement changes prewarm in the background instead of stopping active playback", () => {
  const refresh = body("refreshCommittedSceneReadiness", "scheduleScenePluginTransition");
  const prewarm = body("scheduleSameSceneAudioPrewarm", "refreshCommittedSceneReadiness");
  // The changed-requirements-but-same-scene branch must route to the background prewarm
  // helper, never to prepareActiveSceneTransition/stopAllActivePlaybacks (that would cut
  // every currently-sounding planet for an edit that only touches one of them).
  assert.match(refresh, /if \(!changedScene\) \{\s*scheduleSameSceneAudioPrewarm\(target, afterAudioReady\);\s*return;\s*\}/);
  // The same-scene early return must precede the full-transition call, so a same-scene
  // requirement change can never fall through into prepareActiveSceneTransition.
  assert.ok(refresh.indexOf("scheduleSameSceneAudioPrewarm(target") < refresh.indexOf("prepareActiveSceneTransition(nextActiveSceneId, true)"));
  assert.match(prewarm, /replacePermanentResidency\(permanentSceneResidencyOwner\.current, requests\)/);
  assert.match(prewarm, /ensureProcessedBuffer\(/);
  assert.match(prewarm, /priority: "selected"/);
  assert.match(prewarm, /startRenderOwner\(ownerId\)/);
  assert.match(prewarm, /releaseRenderOwner\(ownerId, controller\)/);
  assert.doesNotMatch(prewarm, /prepareActiveSceneTransition|stopAllActivePlaybacks/);
});

test("scene audibility waits for the latest audio and WAM readiness transaction", () => {
  const transition = body("scheduleScenePluginTransition", "activateScene");
  const activate = body("activateScene", "commitSceneDocument");
  const commit = body("commitSceneDocument", "publishPreRecordedSceneEdit");
  assert.match(app, /collectSceneAudioRequests/);
  assert.match(transition, /sceneTransitionController\.current\?\.abort\(\)/);
  assert.match(transition, /audioEngine\.acquireResidency/);
  assert.match(transition, /ensureProcessedBuffer/);
  assert.match(transition, /priority: "playback"/);
  assert.match(transition, /runSceneAudioReadinessTransition/);
  assert.match(transition, /replacePermanentResidency/);
  assert.match(transition, /sceneTransitionEpoch\.current === epoch/);
  // A partial prewarm failure must not abort the transition or block publish -- only
  // reportAudioFailure (full/WAM failure) aborts the controller.
  assert.match(transition, /reportPartialAudioFailure: \(failedRequests\) => \{/);
  assert.doesNotMatch(
    transition.slice(transition.indexOf("reportPartialAudioFailure:")),
    /controller\.abort\(\)/
  );
  assert.match(activate, /prepareActiveSceneTransition\(nextSceneId, true\)/);
  assert.match(activate, /if \(changed\) setActiveSceneId\(nextSceneId\)/);
  assert.match(commit, /refreshCommittedSceneReadiness\(nextScenes, nextActiveSceneId\)/);
});

test("committed audio mutations derive the next immutable scene before refreshing residency", () => {
  const trim = app.slice(app.indexOf("onSampleTrim={"), app.indexOf("hasPlanetClipboard=", app.indexOf("onSampleTrim={")));
  const projectOpen = body("openProject", "toggleRecording");
  const staged = body("prewarmAndCommitSceneMutation", "canOrbitSound");
  assert.match(app, /function commitActiveSceneMutation/);
  assert.match(app, /onPlanetReverse=.*commitActiveSceneMutation/s);
  assert.match(app, /function setOrbitMode[\s\S]*commitActiveSceneMutation/);
  // Trim publishes rebase onto the current document (not a captured `nextScenes`) so a
  // motion commit landing mid-render can't make the publish silently no-op (see the
  // dedicated rebase test below for the full contract).
  assert.match(trim, /const applyWindow = \(scenes: Scene\[\]\) => updateSceneById/);
  assert.match(trim, /const nextScenes = applyWindow\(currentScenes\)/);
  assert.match(trim, /prewarmAndCommitSceneMutation\(/);
  assert.match(staged, /audioEngine\.acquireResidency/);
  assert.match(trim, /const rebased = applyWindow\(stateRef\.current\.scenes\)/);
  assert.match(trim, /refreshCommittedSceneReadiness\(rebased, sceneIdAtRequest\)/);
  assert.match(projectOpen, /refreshCommittedSceneReadiness\(restoredScenes, project\.activeSceneId/);
  assert.match(projectOpen, /if \(scene\.id === project\.activeSceneId\) continue/);
  assert.match(app, /sceneTransitionController\.current\?\.abort\(\)/);
  assert.match(app, /replacePermanentResidency\(permanentSceneResidencyOwner\.current, \[\]\)/);
  // The physics loop's angle/collision commits (onMovePlanets) go through a dedicated
  // motion-commit path, not the general commitActiveSceneMutation -- see the livelock
  // test below for why (resetPlaybackRenderScope must never run on this hot path).
  assert.match(app, /onMovePlanets=\{\(updates\) => \{[\s\S]*commitMotionSceneMutation\(updates\)/);
  assert.doesNotMatch(
    app.slice(app.indexOf("onMovePlanets={"), app.indexOf("sceneId={activeSceneId}")),
    /commitActiveSceneMutation/
  );
});

test("motion commits never abort in-flight playback renders and only redo audio requirements on a direction flip", () => {
  const motion = body("commitMotionSceneMutation", "publishPreRecordedSceneEdit");
  // The whole point of this dedicated path: it must never call resetPlaybackRenderScope
  // (that would abort in-flight playback-priority self-heal renders every physics tick,
  // livelocking any render slower than the angle-sync interval) and must never run the
  // general readiness refresh (which allocates two collected+sorted request lists) on
  // every motion commit -- only the direction-flip subcase does any requirement work.
  assert.doesNotMatch(motion, /resetPlaybackRenderScope\(\)/);
  assert.doesNotMatch(motion, /refreshCommittedSceneReadiness\(/);
  assert.match(motion, /"direction" in update/);
  assert.match(motion, /collectSceneAudioRequests\(target\)/);
  assert.match(motion, /replacePermanentResidency\(permanentSceneResidencyOwner\.current, requests\)/);
  assert.match(motion, /requestProcessedPlanet\(/);
  assert.match(motion, /"playback"/);
});

test("project save keeps every failure in the save barrier and never reports a failed serialize as success", () => {
  const save = body("performProjectSave", "saveProject");
  const tryStart = save.indexOf("try {");
  const serialize = save.indexOf("serializeProject(");
  const ipc = save.indexOf("window.orbitonicAPI.saveProject");
  const catchStart = save.indexOf("} catch (error)");
  assert.ok(tryStart >= 0 && tryStart < serialize && serialize < ipc && ipc < catchStart);
  assert.match(save, /setIsDirty\(false\);\s*flash\("Project saved\."\);/);
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
