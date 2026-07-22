import { useEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { audioEngine, type DspRenderPriority, type ProjectAudioInput } from "./audio/audioEngine";
import { applyPlanetMotionUpdates, collectSceneAudioRequests, runSceneAudioReadinessTransition } from "./audio/sceneAudioReadiness";
import { collectRetainedPluginSlotIds } from "./audio/wamRack";
import { getWamCatalogEntry } from "./audio/wamCatalog";
import { encodeWav, type WavSampleFormat } from "./audio/wavEncoder";
import { CanvasStage } from "./components/CanvasStage";
import { ContextMenu } from "./components/ContextMenu";
import { MasterControls } from "./components/MasterControls";
import { OrbitSettingsPanel } from "./components/OrbitSettingsPanel";
import { PreferencesModal } from "./components/PreferencesModal";
import { SceneTabs } from "./components/SceneTabs";
import { Toolbar } from "./components/Toolbar";
import { TransportControls } from "./components/TransportControls";
import { useMenuActionDispatch } from "./hooks/useMenuActionDispatch";
import { useSpeedPitchProcessing } from "./hooks/useSpeedPitchProcessing";
import { parseProject, serializeProject } from "./project/projectSerializer";
import type {
  ContextMenuState, HistorySnapshot, MultiSelection, Orbit, OrbitMode, Planet, Scene, Selection,
  SequenceRetriggerMode, Tool, TriggerBar, ViewportState
} from "./state/types";
import {
  collectHistoryProjectIds, createEmptyScene,
  createHistorySnapshot, createProjectIdAllocatorForScenes, createSpliceBars, deleteScene,
  getRetainedAudioSets, impliedSpliceBarIds, nextDefaultSceneName, planSceneDuplicate, renameScene, reorderScenes,
  replaceOrbitSpliceSettings, reserveSceneProjectIds,
  reconcileSceneOrbitMix, runActiveSceneTransition, runStagedDocumentTransaction, stageSceneDuplicate,
  updateSceneById
} from "./state/scenes";
import type { RetainedAudioCache } from "./state/scenes";
import {
  TAU, getOrbitTapeRate, getSampleDuration, getSampleEnd, getSampleStart,
  getTapeStyleRuntimeRateOnly, isFullLoopBar, normalizeAngle, normalizeSpliceCount,
  orbitAngleAtPoint, rateToCents
} from "./utils/geometry";
import { normalizeSampleWindow } from "./utils/sampleTrim";
import {
  clearSelectionState, selectMultipleState, selectSingleState
} from "./utils/selection";

const randomId = () => crypto.randomUUID();
const MAX_HISTORY = 100;
const DEFAULT_LOOP_BAR_LENGTH_RADIANS = Math.PI / 12;
const SEQUENCE_BAR_LENGTH_RADIANS = .04;
const MIN_BAR_LENGTH_RADIANS = .01;
const MIN_DIRECT_RATE = .05;
const MAX_DIRECT_RATE = 8;
const MIN_DIRECT_ORBIT_RADIUS = 40;
const MAX_DIRECT_ORBIT_RADIUS = 1000;
const ORBIT_COLORS = ["#5b625d", "#a65f54", "#4f759b", "#7a6995", "#6e8b62", "#b17b45"];
const supportedAudio = (file: File) => /\.(wav|mp3|ogg)$/i.test(file.name) ||
  ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg"].includes(file.type);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
type CopiedPlanetData = Pick<Planet, "speed" | "volume" | "audioPan" | "pitchCents" | "direction" | "isActive">;
type AppClipboard = {
  type: "planet";
  sourceOrbitId: string;
  data: CopiedPlanetData;
} | null;
type RecordingPreferencesApi = {
  getPreferences?: () => Promise<{ export: { sampleFormat: WavSampleFormat } }>;
};

const cleanPlanet = (planet: Planet): Planet => ({
  ...planet,
  pendingSpeed: undefined,
  isSpeedProcessing: false,
  processingSpeed: undefined,
  speedProcessRequestId: undefined,
  speedProcessingError: undefined,
  pendingPitchCents: undefined,
  isPitchProcessing: false,
  processingPitchCents: undefined,
  pitchProcessRequestId: undefined
});

export default function App() {
  const [scenes, setScenes] = useState<Scene[]>(() => [createEmptyScene("Scene 1", randomId)]);
  const [activeSceneId, setActiveSceneId] = useState(() => scenes[0].id);
  const activeScene = scenes.find((scene) => scene.id === activeSceneId) ?? scenes[0];
  const { orbits, planets, bars, selection, multiSelection, viewport } = activeScene;
  const [selectedTool, setSelectedTool] = useState<Tool>("select");
  const [isPlaying, setIsPlaying] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingPhase, setRecordingPhase] = useState<"idle" | "starting" | "recording" | "encoding" | "saving">("idle");
  const [recordingSampleFormat, setRecordingSampleFormat] = useState<WavSampleFormat>("pcm16");
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1);
  const [masterPan, setMasterPan] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lastLoopBarLengthRadians, setLastLoopBarLengthRadians] = useState(DEFAULT_LOOP_BAR_LENGTH_RADIANS);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled Session");
  const [projectPath, setProjectPath] = useState<string>();
  const [isDirty, setIsDirty] = useState(false);
  const [cancelSignal, setCancelSignal] = useState(0);
  const [clipboard, setClipboard] = useState<AppClipboard>(null);
  const [isDuplicatingScene, setIsDuplicatingScene] = useState(false);
  const [waveformPeaksByOrbit, setWaveformPeaksByOrbit] = useState<Map<string, Float32Array>>(() => new Map());
  const [, setPluginRuntimeRevision] = useState(0);
  const uploadPoint = useRef({ x: 450, y: 350 });
  const fileInput = useRef<HTMLInputElement>(null);
  const undoStack = useRef<HistorySnapshot[]>([]);
  const redoStack = useRef<HistorySnapshot[]>([]);
  // Bumped whenever undoStack/redoStack contents change (push, cap-overflow shift, undo,
  // redo, clear) so pruneUnreferencedAudio can cache its retained-set walk per revision.
  const historyRevision = useRef(0);
  const retainedAudioCache = useRef<RetainedAudioCache>(null);
  const [initialProjectIds] = useState(() => createProjectIdAllocatorForScenes(scenes, randomId));
  const projectIds = useRef(initialProjectIds);
  const parameterHistoryTimer = useRef<number>();
  // Updated synchronously at the transition boundary so stale Canvas callbacks cannot revive old audio.
  const audibleSceneId = useRef<string | null>(activeSceneId);
  const playbackEpoch = useRef(0);
  const playbackRenderController = useRef(new AbortController());
  // Separate from playbackEpoch: this cancels stale WAM hydration, not Canvas callbacks.
  const sceneTransitionEpoch = useRef(0);
  const sceneTransitionController = useRef<AbortController | null>(null);
  const permanentSceneResidencyOwner = useRef("scene:audible");
  const clipboardRef = useRef<AppClipboard>(null);
  const sceneDuplicationPending = useRef(false);
  const recordingInFlight = useRef(false);
  const renderControllers = useRef(new Map<string, AbortController>());
  const projectRenderEpoch = useRef(0);
  const stateRef = useRef({
    scenes, activeSceneId, orbits, planets, bars, selection, multiSelection,
    lastLoopBarLengthRadians, masterVolume, masterPan
  });
  stateRef.current = {
    scenes, activeSceneId, orbits, planets, bars, selection, multiSelection,
    lastLoopBarLengthRadians, masterVolume, masterPan
  };
  clipboardRef.current = clipboard;

  useEffect(() => {
    const preferencesApi = window.orbitonicAPI as (typeof window.orbitonicAPI & RecordingPreferencesApi) | undefined;
    void preferencesApi?.getPreferences?.().then((preferences) => {
      setRecordingSampleFormat(preferences.export.sampleFormat);
    }).catch(() => undefined);
  }, []);

  function reserveProjectIds() {
    reserveSceneProjectIds(projectIds.current, stateRef.current.scenes);
    undoStack.current.forEach((snapshot) => reserveSceneProjectIds(projectIds.current, snapshot.scenes));
    redoStack.current.forEach((snapshot) => reserveSceneProjectIds(projectIds.current, snapshot.scenes));
  }

  function projectId() {
    reserveProjectIds();
    return projectIds.current.next();
  }

  function projectOrbitId(spliceCount = 0) {
    reserveProjectIds();
    return projectIds.current.nextWithReservations((candidate) =>
      impliedSpliceBarIds({ id: candidate, spliceCount }));
  }

  const setActiveSceneField = <K extends keyof Scene>(key: K, action: SetStateAction<Scene[K]>) => {
    const targetSceneId = stateRef.current.activeSceneId;
    setScenes((current) => updateSceneById(current, targetSceneId, (scene) => {
      const previous = scene[key];
      const next = typeof action === "function"
        ? (action as (value: Scene[K]) => Scene[K])(previous)
        : action;
      return next === previous ? scene : { ...scene, [key]: next };
    }));
  };
  const setOrbits = (action: SetStateAction<Orbit[]>) => setActiveSceneField("orbits", action);
  const setPlanets = (action: SetStateAction<Planet[]>) => setActiveSceneField("planets", action);
  const setBars = (action: SetStateAction<TriggerBar[]>) => setActiveSceneField("bars", action);
  const setSelection = (action: SetStateAction<Selection>) => setActiveSceneField("selection", action);
  const setMultiSelection = (action: SetStateAction<MultiSelection>) => setActiveSceneField("multiSelection", action);
  const setViewport = (action: SetStateAction<ViewportState>) => setActiveSceneField("viewport", action);

  useEffect(() => { audioEngine.setMasterVolume(masterVolume); }, [masterVolume]);
  useEffect(() => { audioEngine.setMasterPan(masterPan); }, [masterPan]);

  useEffect(() => audioEngine.subscribeWaveformPeaks((orbitId, peaks) => {
    setWaveformPeaksByOrbit((current) => {
      const next = new Map(current);
      if (peaks) next.set(orbitId, peaks);
      else next.delete(orbitId);
      return next;
    });
  }), []);

  useEffect(() => () => {
    sceneTransitionController.current?.abort();
    sceneTransitionController.current = null;
    playbackRenderController.current.abort();
    audioEngine.replacePermanentResidency(permanentSceneResidencyOwner.current, []);
    for (const controller of renderControllers.current.values()) controller.abort();
    renderControllers.current.clear();
  }, []);

  const selectedOrbit = useMemo(
    () => orbits.find((orbit) => orbit.id === selection.orbitId) ?? null,
    [orbits, selection.orbitId]
  );

  function selectSingle(next: Selection) {
    const state = selectSingleState(next);
    setSelection(state.selection);
    setMultiSelection(state.multiSelection);
  }

  function selectMultiple(orbitIds: string[], planetIds: string[]) {
    const state = selectMultipleState(orbitIds, planetIds);
    setSelection(state.selection);
    setMultiSelection(state.multiSelection);
  }

  function clearSelection() {
    const state = clearSelectionState();
    setSelection(state.selection);
    setMultiSelection(state.multiSelection);
  }

  function snapshot(): HistorySnapshot {
    const state = stateRef.current;
    return createHistorySnapshot(
      state.scenes, state.activeSceneId,
      { volume: state.masterVolume, pan: state.masterPan }
    );
  }

  // undoStack/redoStack are mutated in place (push/pop/shift/clear); call this immediately
  // after any such mutation so cached retained-audio sets are recomputed on the next prune.
  function bumpHistoryRevision() {
    historyRevision.current += 1;
  }

  function pruneUnreferencedAudio(currentScenes = stateRef.current.scenes) {
    const { sets, cache } = getRetainedAudioSets(
      currentScenes, undoStack.current, redoStack.current,
      historyRevision.current, retainedAudioCache.current, collectRetainedPluginSlotIds
    );
    retainedAudioCache.current = cache;
    audioEngine.pruneOrbits(sets.orbitIds);
    audioEngine.prunePluginStateSlots(sets.pluginSlotIds);
  }

  function pushHistory() {
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    bumpHistoryRevision();
    pruneUnreferencedAudio();
    setIsDirty(true);
  }

  function pushParameterHistory() {
    if (parameterHistoryTimer.current === undefined) pushHistory();
    window.clearTimeout(parameterHistoryTimer.current);
    parameterHistoryTimer.current = window.setTimeout(() => {
      parameterHistoryTimer.current = undefined;
    }, 350);
  }

  function resetParameterHistoryWindow() {
    window.clearTimeout(parameterHistoryTimer.current);
    parameterHistoryTimer.current = undefined;
  }

  function changeMasterVolume(value: number) {
    const next = clamp(value, 0, 1);
    if (next === stateRef.current.masterVolume) return;
    pushParameterHistory();
    setMasterVolume(next);
  }

  function changeMasterPan(value: number) {
    const next = clamp(value, -1, 1);
    if (next === stateRef.current.masterPan) return;
    pushParameterHistory();
    setMasterPan(next);
  }

  function prepareActiveSceneTransition(nextSceneId: string, force = false) {
    return runActiveSceneTransition(stateRef.current.activeSceneId, nextSceneId, {
      designateAudibleScene: () => {
        audibleSceneId.current = null;
        playbackEpoch.current += 1;
        resetPlaybackRenderScope();
      },
      stopActivePlaybacks: () => audioEngine.stopAllActivePlaybacks(),
      closeTransientUi: () => setMenu(null),
      cancelInteractions: () => setCancelSignal((value) => value + 1)
    }, force);
  }

  function sameSceneAudioRequirements(previous: Scene | undefined, next: Scene | undefined) {
    if (!previous || !next) return previous === next;
    const describe = (scene: Scene) => collectSceneAudioRequests(scene)
      .map((request) => [
        request.orbitId, request.planetId, request.speed, request.pitchCents,
        request.sampleStart, request.sampleEnd, request.direction
      ].join("|"))
      .sort();
    const before = describe(previous);
    const after = describe(next);
    return before.length === after.length && before.every((value, index) => value === after[index]);
  }

  // In-scene edits (deleting one planet, toggling reverse, a speed/pitch commit, a trim)
  // must not cut every currently-sounding planet in the scene -- only a genuine scene
  // identity change (switching tabs, undo/redo across scenes, project load) warrants the
  // full stop-everything-and-rehydrate-the-WAM-rack transition below. Same-scene audio
  // requirement changes instead update residency and prewarm in the background while
  // whatever is already audible keeps playing; callers that need a specific planet/orbit
  // silenced already do that themselves (e.g. deletePlanet calls stopAllActivePlaybacksForPlanet).
  function scheduleSameSceneAudioPrewarm(target: Scene | undefined, afterAudioReady?: () => void) {
    if (!target) return;
    const requests = collectSceneAudioRequests(target);
    audioEngine.replacePermanentResidency(permanentSceneResidencyOwner.current, requests);
    const ownerId = `same-scene-audio:${target.id}`;
    const controller = startRenderOwner(ownerId);
    void Promise.allSettled(requests.map((request, index) => audioEngine.ensureProcessedBuffer(request, {
      ownerId: `${ownerId}:${index}:${request.orbitId}:${request.planetId}`,
      priority: "selected",
      signal: controller.signal
    }))).then((results) => {
      if (controller.signal.aborted) return;
      const failed = results.some((result) =>
        result.status === "rejected" && !isExpectedDspAbort(result.reason));
      if (failed) flash("Some planet audio is not ready; it will retry on the next trigger.");
      afterAudioReady?.();
    }).finally(() => releaseRenderOwner(ownerId, controller));
  }

  function refreshCommittedSceneReadiness(
    nextScenes: Scene[], nextActiveSceneId: string, afterAudioReady?: () => void
  ) {
    const current = stateRef.current;
    const previous = current.scenes.find((scene) => scene.id === current.activeSceneId);
    const target = nextScenes.find((scene) => scene.id === nextActiveSceneId);
    const changedScene = previous?.id !== target?.id || previous?.orbits !== target?.orbits;
    if (!changedScene && sameSceneAudioRequirements(previous, target)) return;
    if (!changedScene) {
      scheduleSameSceneAudioPrewarm(target, afterAudioReady);
      return;
    }
    prepareActiveSceneTransition(nextActiveSceneId, true);
    scheduleScenePluginTransition(previous?.orbits ?? [], target, nextActiveSceneId, afterAudioReady);
  }

  function scheduleScenePluginTransition(
    previous: readonly Orbit[], target: Scene | undefined, targetSceneId: string, afterAudioReady?: () => void
  ) {
    const epoch = ++sceneTransitionEpoch.current;
    sceneTransitionController.current?.abort();
    const controller = new AbortController();
    sceneTransitionController.current = controller;
    audibleSceneId.current = null;
    const requests = target ? collectSceneAudioRequests(target) : [];
    const ownerPrefix = `scene-prewarm:${epoch}`;
    void runSceneAudioReadinessTransition({
      requests,
      signal: controller.signal,
      isCurrent: () => sceneTransitionEpoch.current === epoch,
      acquire: () => audioEngine.acquireResidency(`scene:provisional:${epoch}`, requests),
      prewarm: (request, index) => audioEngine.ensureProcessedBuffer(request, {
        ownerId: `${ownerPrefix}:${index}:${request.orbitId}:${request.planetId}`,
        priority: "playback",
        signal: controller.signal
      }),
      hydrate: () => audioEngine.transitionScenePluginRacks(previous, target?.orbits ?? [], epoch, targetSceneId),
      publish: () => {
        audioEngine.replacePermanentResidency(permanentSceneResidencyOwner.current, requests);
        audibleSceneId.current = targetSceneId;
        afterAudioReady?.();
      },
      reportAudioFailure: (error) => {
        controller.abort();
        flash(error instanceof Error ? `Scene audio is not ready: ${error.message}` : "Scene audio is not ready.");
      },
      // A partial failure still publishes (see runSceneAudioReadinessTransition): the
      // scene becomes audible, and any planet missing its artifact self-heals via the
      // ordinary miss path on its next trigger. This just surfaces that it's retrying.
      reportPartialAudioFailure: (failedRequests) => {
        flash(`${failedRequests.length} planet${failedRequests.length === 1 ? "" : "s"} audio not ready; retrying on trigger.`);
      }
    }).finally(() => {
      if (sceneTransitionController.current === controller) sceneTransitionController.current = null;
    });
  }

  function activateScene(nextSceneId: string) {
    if (!stateRef.current.scenes.some((scene) => scene.id === nextSceneId)) return;
    const changed = prepareActiveSceneTransition(nextSceneId);
    if (!changed && audibleSceneId.current === nextSceneId) return;
    if (!changed) prepareActiveSceneTransition(nextSceneId, true);
    resetParameterHistoryWindow();
    if (changed) setActiveSceneId(nextSceneId);
    // Publishing the target selection stays synchronous for the existing tab
    // contract. Audio remains gated until the newest hydration transaction settles.
    const previous = stateRef.current.scenes.find((scene) => scene.id === stateRef.current.activeSceneId);
    const target = stateRef.current.scenes.find((scene) => scene.id === nextSceneId);
    scheduleScenePluginTransition(previous?.orbits ?? [], target, nextSceneId);
  }

  function commitSceneDocument(nextScenes: Scene[], nextActiveSceneId: string) {
    resetParameterHistoryWindow();
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    bumpHistoryRevision();
    refreshCommittedSceneReadiness(nextScenes, nextActiveSceneId);
    setScenes(nextScenes);
    setActiveSceneId(nextActiveSceneId);
    pruneUnreferencedAudio(nextScenes);
    setIsDirty(true);
  }

  function commitActiveSceneMutation(update: (scene: Scene) => Scene, markDirty = true) {
    resetPlaybackRenderScope();
    const current = stateRef.current;
    const nextScenes = updateSceneById(current.scenes, current.activeSceneId, update);
    refreshCommittedSceneReadiness(nextScenes, current.activeSceneId);
    setScenes(nextScenes);
    if (markDirty) setIsDirty(true);
    return nextScenes;
  }

  // Dedicated path for the physics loop's angle/collision commits (onMovePlanets), which
  // land up to 100Hz while collisions settle and every ANGLE_SYNC_INTERVAL_SECONDS while
  // playing. Unlike commitActiveSceneMutation this must NEVER call resetPlaybackRenderScope:
  // that would abort in-flight playback-priority self-heal renders every cycle, so a render
  // taking longer than the sync interval could never complete while the transport runs.
  // It also skips refreshCommittedSceneReadiness's requirement diff (sameSceneAudioRequirements
  // allocates two collected+sorted request lists) for the common case, since motion updates
  // only ever touch angle/collisionSpeedMultiplier/collisionFlashRemaining/direction -- and
  // only a direction flip (a collision reversing a planet) changes what audio is required.
  function commitMotionSceneMutation(updates: ReadonlyMap<string, Partial<Planet>>) {
    const current = stateRef.current;
    const nextScenes = updateSceneById(current.scenes, current.activeSceneId,
      (scene) => applyPlanetMotionUpdates(scene, updates));
    setScenes(nextScenes);
    let directionChanged = false;
    for (const update of updates.values()) {
      if ("direction" in update) { directionChanged = true; break; }
    }
    if (!directionChanged) return nextScenes;
    const target = nextScenes.find((scene) => scene.id === current.activeSceneId);
    if (!target) return nextScenes;
    // A direction flip changes which processed artifact a planet needs (forward vs.
    // reverse variant). Recompute residency so the cache doesn't evict the newly-required
    // artifact, and kick a prewarm to accelerate the miss self-heal -- but still without
    // touching resetPlaybackRenderScope or stopping anything currently playing.
    const requests = collectSceneAudioRequests(target);
    audioEngine.replacePermanentResidency(permanentSceneResidencyOwner.current, requests);
    const requestByPlanetId = new Map(requests.map((request) => [request.planetId, request]));
    for (const planetId of updates.keys()) {
      if (!("direction" in (updates.get(planetId) ?? {}))) continue;
      const request = requestByPlanetId.get(planetId);
      if (!request) continue;
      void requestProcessedPlanet(
        request.orbitId, request.planetId, request.speed, request.pitchCents,
        request.sampleStart, request.sampleEnd,
        `motion:${current.activeSceneId}:${request.orbitId}:${request.planetId}`, "playback", request.direction
      );
    }
    return nextScenes;
  }

  // Gesture owners (Canvas onBeginMutation / settings pushParameterHistory) already
  // captured the single undo boundary; publishing subsequent frames must not add another.
  function publishPreRecordedSceneEdit(nextScenes: Scene[]) {
    setScenes(nextScenes);
    setIsDirty(true);
  }

  function addScene() {
    const current = stateRef.current;
    const nextScene = createEmptyScene(nextDefaultSceneName(current.scenes), projectId);
    commitSceneDocument([...current.scenes, nextScene], nextScene.id);
  }

  function removeActiveScene() {
    const current = stateRef.current;
    const next = deleteScene(current.scenes, current.activeSceneId, current.activeSceneId);
    if (next.scenes === current.scenes) return;
    abortRenderOwners((ownerId) => ownerId.startsWith(`edit:${current.activeSceneId}:`));
    commitSceneDocument(next.scenes, next.activeSceneId);
  }

  function commitSceneRename(sceneId: string, rawName: string) {
    const current = stateRef.current;
    const next = renameScene(current.scenes, sceneId, rawName);
    if (next === current.scenes) return;
    commitSceneDocument(next, current.activeSceneId);
  }

  function commitSceneReorder(draggedSceneId: string, targetSceneId: string) {
    const current = stateRef.current;
    const next = reorderScenes(current.scenes, draggedSceneId, targetSceneId);
    if (next === current.scenes) return;
    commitSceneDocument(next, current.activeSceneId);
  }

  async function duplicateActiveScene() {
    if (sceneDuplicationPending.current) return;
    const baseScenes = stateRef.current.scenes;
    const source = baseScenes.find((scene) => scene.id === stateRef.current.activeSceneId);
    if (!source) return;
    let plan: ReturnType<typeof planSceneDuplicate>;
    try {
      plan = planSceneDuplicate(source, {
        name: `${source.name} Copy`,
        createId: projectId,
        createOrbitId: (orbit) => projectOrbitId(orbit.spliceCount),
        createPluginSlotId: () => projectId(),
        occupiedIds: collectHistoryProjectIds(baseScenes, undoStack.current, redoStack.current)
      });
    } catch (error) {
      flash(error instanceof Error ? error.message : "Scene could not be duplicated.");
      return;
    }
    sceneDuplicationPending.current = true;
    setIsDuplicatingScene(true);
    let copiedPluginStateIds: readonly string[] = [];
    try {
      const duplicate = await stageSceneDuplicate(source, plan, {
        stage: (sourceOrbitId, targetOrbitId) => {
          const sourceOrbit = source.orbits.find((orbit) => orbit.id === sourceOrbitId);
          if (!sourceOrbit || !audioEngine.duplicateOrbitAudio(sourceOrbitId, targetOrbitId, sourceOrbit.volume)) {
            throw new Error(`Audio for orbit "${sourceOrbit?.name ?? sourceOrbitId}" is unavailable.`);
          }
          audioEngine.setOrbitAudioPan(targetOrbitId, sourceOrbit.audioPan);
        },
        rollback: (targetOrbitId) => audioEngine.removeOrbit(targetOrbitId)
      });
      // External state is copied only after every target audio runtime staged.
      copiedPluginStateIds = audioEngine.copyPluginStatesBySlotMap(plan.pluginSlotIdMap);
      if (stateRef.current.scenes !== baseScenes) {
        for (const targetOrbitId of plan.orbitIdMap.values()) audioEngine.removeOrbit(targetOrbitId);
        audioEngine.removePluginSlotStates(copiedPluginStateIds);
        flash("Scene changed while duplication was in progress; duplication was canceled.");
        return;
      }
      const sourceIndex = baseScenes.findIndex((scene) => scene.id === source.id);
      const next = baseScenes.slice();
      next.splice(sourceIndex + 1, 0, duplicate);
      try { commitSceneDocument(next, duplicate.id); }
      catch (error) {
        for (const targetOrbitId of plan.orbitIdMap.values()) audioEngine.removeOrbit(targetOrbitId);
        audioEngine.removePluginSlotStates(copiedPluginStateIds);
        throw error;
      }
      for (const planet of duplicate.planets) {
        if (planet.speed !== 1 || planet.pitchCents) {
          const orbit = duplicate.orbits.find((item) => item.id === planet.orbitId);
          void requestProcessedPlanet(
            planet.orbitId, planet.id, planet.speed, planet.pitchCents,
            orbit ? getSampleStart(orbit) : 0, orbit ? getSampleEnd(orbit) : Infinity,
            `duplicate-scene:${duplicate.id}:${planet.orbitId}:${planet.id}`, "background"
          );
        }
      }
    } catch (error) {
      // stageSceneDuplicate rolls back partial audio itself; this additionally
      // covers a later state-copy or document-publication failure.
      for (const targetOrbitId of plan.orbitIdMap.values()) audioEngine.removeOrbit(targetOrbitId);
      audioEngine.removePluginSlotStates(copiedPluginStateIds);
      flash(error instanceof Error ? error.message : "Scene could not be duplicated.");
    } finally {
      sceneDuplicationPending.current = false;
      setIsDuplicatingScene(false);
    }
  }

  function restoreSnapshot(next: HistorySnapshot) {
    // Undo/redo is a runtime boundary even when the owning scene ID is unchanged.
    abortRenderOwners((ownerId) => ownerId.startsWith("edit:"));
    refreshCommittedSceneReadiness(next.scenes, next.activeSceneId);
    setScenes(next.scenes);
    setActiveSceneId(next.activeSceneId);
    setMasterVolume(next.master.volume);
    setMasterPan(next.master.pan);
    reconcileSceneOrbitMix(next.scenes, (orbitId, volume, pan) => {
      audioEngine.setVolume(orbitId, volume);
      audioEngine.setOrbitAudioPan(orbitId, pan);
    });
  }

  function undo() {
    resetParameterHistoryWindow();
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(snapshot());
    bumpHistoryRevision();
    restoreSnapshot(previous);
    pruneUnreferencedAudio(previous.scenes);
    setIsDirty(true);
    flash("Undone.");
  }

  function redo() {
    resetParameterHistoryWindow();
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(snapshot());
    bumpHistoryRevision();
    restoreSnapshot(next);
    pruneUnreferencedAudio(next.scenes);
    setIsDirty(true);
    flash("Redone.");
  }

  function flash(text: string, duration = 1800) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), duration);
  }

  function isExpectedDspAbort(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
  }

  function abortRenderOwners(matches: (ownerId: string) => boolean) {
    for (const [ownerId, controller] of renderControllers.current) {
      if (!matches(ownerId)) continue;
      controller.abort();
      renderControllers.current.delete(ownerId);
    }
  }

  function startRenderOwner(ownerId: string) {
    renderControllers.current.get(ownerId)?.abort();
    const controller = new AbortController();
    renderControllers.current.set(ownerId, controller);
    return controller;
  }

  function releaseRenderOwner(ownerId: string, controller: AbortController) {
    if (renderControllers.current.get(ownerId) === controller) renderControllers.current.delete(ownerId);
  }

  function requestProcessedPlanet(
    orbitId: string, planetId: string, speed: number, pitchCents: number,
    sampleStart: number, sampleEnd: number, ownerId: string, priority: DspRenderPriority,
    direction: "forward" | "reverse" = "forward"
  ) {
    const controller = startRenderOwner(ownerId);
    const promise = audioEngine.ensureProcessedBuffer({
      orbitId, planetId, speed, pitchCents, sampleStart, sampleEnd, direction
    }, { ownerId, priority, signal: controller.signal });
    void promise.catch((error: unknown) => {
      if (!isExpectedDspAbort(error)) flash("Audio processing failed.");
    }).finally(() => {
      releaseRenderOwner(ownerId, controller);
    });
    return promise;
  }

  async function prewarmAndCommitSceneMutation(
    nextScenes: Scene[], nextSceneId: string, ownerId: string, priority: DspRenderPriority, publish: () => void
  ) {
    const target = nextScenes.find((scene) => scene.id === nextSceneId);
    const requests = target ? collectSceneAudioRequests(target) : [];
    const controller = startRenderOwner(ownerId);
    const release = audioEngine.acquireResidency(`scene:staged:${ownerId}`, requests);
    try {
      await Promise.all(requests.map((request, index) => audioEngine.ensureProcessedBuffer(request, {
        ownerId: `${ownerId}:${index}:${request.orbitId}:${request.planetId}`,
        priority,
        signal: controller.signal
      })));
      if (controller.signal.aborted) return;
      publish();
    } finally {
      release();
      releaseRenderOwner(ownerId, controller);
    }
  }

  function canOrbitSound(orbitId: string) {
    const state = stateRef.current;
    const audibleScene = state.scenes.find((scene) => scene.id === audibleSceneId.current);
    const orbit = audibleScene?.orbits.find((item) => item.id === orbitId);
    if (!orbit || orbit.isPaused || orbit.isMuted || orbit.isMissingAudio) return false;
    const hasSolo = audibleScene?.orbits.some((item) => item.isSolo) ?? false;
    return !hasSolo || orbit.isSolo;
  }

  function isCurrentPlaybackCallback(sceneId: string, epoch: number) {
    return sceneId === audibleSceneId.current && epoch === playbackEpoch.current;
  }

  function resetPlaybackRenderScope() {
    playbackRenderController.current.abort();
    playbackRenderController.current = new AbortController();
  }

  function playbackRenderScope(sceneId: string, epoch: number, kind: "loop" | "sequence", planetId: string, barId: string) {
    return {
      ownerId: `playback:${sceneId}:${epoch}:${kind}:${planetId}:${barId}`,
      signal: playbackRenderController.current.signal
    };
  }

  function deletePlanet(planetId: string) {
    pushHistory();
    abortRenderOwners((ownerId) => ownerId.endsWith(`:${planetId}`));
    audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    commitActiveSceneMutation((scene) => ({
      ...scene,
      planets: scene.planets.filter((planet) => planet.id !== planetId)
    }));
    if (stateRef.current.selection.planetId === planetId) {
      selectSingle({ ...stateRef.current.selection, planetId: null });
    }
  }

  function deleteSelection() {
    const state = stateRef.current;
    if (state.selection.barId) {
      const selectedBar = state.bars.find((bar) => bar.id === state.selection.barId);
      if (selectedBar?.source === "splice") {
        selectSingle({ ...state.selection, barId: null });
        return;
      }
      pushHistory();
      audioEngine.stopAllActivePlaybacksForBar(state.selection.barId);
      setBars((current) => current.filter((bar) => bar.id !== state.selection.barId));
      selectSingle({ ...state.selection, barId: null });
    } else if (state.selection.planetId) {
      deletePlanet(state.selection.planetId);
    } else if (state.selection.orbitId) {
      const orbitId = state.selection.orbitId;
      pushHistory();
      abortRenderOwners((ownerId) => ownerId.includes(`:${orbitId}:`));
      audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
      commitActiveSceneMutation((scene) => ({
        ...scene,
        orbits: scene.orbits.filter((orbit) => orbit.id !== orbitId),
        planets: scene.planets.filter((planet) => planet.orbitId !== orbitId),
        bars: scene.bars.filter((bar) => bar.orbitId !== orbitId)
      }));
      clearSelection();
    }
  }

  // Remove everything captured by a marquee box selection at once. Deleting an orbit
  // takes its planets and bars with it; loose planets are removed on their own.
  function deleteMultiSelection() {
    const state = stateRef.current;
    const orbitIds = new Set(state.multiSelection.orbitIds);
    const planetIds = new Set(state.multiSelection.planetIds);
    if (!orbitIds.size && !planetIds.size) return;
    pushHistory();
    for (const orbitId of orbitIds) abortRenderOwners((ownerId) => ownerId.includes(`:${orbitId}:`));
    for (const planetId of planetIds) abortRenderOwners((ownerId) => ownerId.endsWith(`:${planetId}`));
    for (const orbitId of orbitIds) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    for (const planetId of planetIds) audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    commitActiveSceneMutation((scene) => ({
      ...scene,
      orbits: scene.orbits.filter((orbit) => !orbitIds.has(orbit.id)),
      planets: scene.planets.filter((planet) => !planetIds.has(planet.id) && !orbitIds.has(planet.orbitId)),
      bars: scene.bars.filter((bar) => !orbitIds.has(bar.orbitId))
    }));
    clearSelection();
  }

  function setOrbitSpliceCount(orbitId: string, rawCount: number) {
    const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
    if (!orbit || orbit.mode !== "loop") return;
    const count = normalizeSpliceCount(rawCount);
    if (count === normalizeSpliceCount(orbit.spliceCount ?? 0)) return;
    const startAngle = orbit.spliceStartAngle ?? 0;
    try {
      const next = replaceOrbitSpliceSettings(
        stateRef.current.scenes, stateRef.current.activeSceneId, orbitId, count, startAngle
      );
      projectIds.current.reserveDerived(orbitId, impliedSpliceBarIds({ id: orbitId, spliceCount: count }));
      const nextScene = next.find((scene) => scene.id === stateRef.current.activeSceneId);
      const nextIds = new Set(nextScene?.bars.map((bar) => bar.id));
      for (const bar of stateRef.current.bars) {
        if (bar.orbitId === orbitId && bar.source === "splice" && !nextIds.has(bar.id)) {
          audioEngine.stopAllActivePlaybacksForBar(bar.id);
        }
      }
      publishPreRecordedSceneEdit(next);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Splice settings conflict with another project ID.");
    }
  }

  function setOrbitSpliceStart(orbitId: string, rawAngle: number) {
    const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
    if (!orbit || orbit.mode !== "loop") return;
    const count = normalizeSpliceCount(orbit.spliceCount ?? 0);
    const startAngle = normalizeAngle(rawAngle);
    if (Math.abs(startAngle - (orbit.spliceStartAngle ?? 0)) < .0001) return;
    try {
      const next = replaceOrbitSpliceSettings(
        stateRef.current.scenes, stateRef.current.activeSceneId, orbitId, count, startAngle
      );
      projectIds.current.reserveDerived(orbitId, impliedSpliceBarIds({ id: orbitId, spliceCount: count }));
      publishPreRecordedSceneEdit(next);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Splice settings conflict with another project ID.");
    }
  }

  function duplicateOrbit(orbitId = stateRef.current.selection.orbitId) {
    if (!orbitId) return;
    const source = stateRef.current.orbits.find((orbit) => orbit.id === orbitId);
    if (!source) return;
    const newOrbitId = projectOrbitId(source.spliceCount);
    const duplicate: Orbit = {
      ...source, id: newOrbitId, name: `${source.name} Copy`, x: source.x + 40, y: source.y + 40,
      isMuted: false, isSolo: false,
      plugins: source.plugins?.map((slot) => ({ ...slot, id: projectId() }))
    };
    const copiedPlanets = stateRef.current.planets.filter((planet) => planet.orbitId === source.id).map((planet) => {
      const newId = projectId();
      return {
        ...cleanPlanet(planet), id: newId, orbitId: newOrbitId,
        collisionSpeedMultiplier: 1, collisionFlashRemaining: 0
      };
    });
    const copiedBars = stateRef.current.bars.filter((bar) => bar.orbitId === source.id && bar.source !== "splice")
      .map((bar) => ({ ...bar, id: projectId(), orbitId: newOrbitId }));
    const current = stateRef.current;
    const nextScenes = updateSceneById(current.scenes, current.activeSceneId, (scene) => ({
      ...scene,
      orbits: [...scene.orbits, duplicate],
      planets: [...scene.planets, ...copiedPlanets],
      bars: [...scene.bars, ...copiedBars, ...createSpliceBars({
        id: newOrbitId,
        spliceCount: normalizeSpliceCount(source.spliceCount ?? 0),
        spliceStartAngle: source.spliceStartAngle ?? 0
      })],
      selection: { orbitId: newOrbitId, planetId: null, barId: null },
      multiSelection: { orbitIds: [], planetIds: [] }
    }));
    if (!audioEngine.duplicateOrbitAudio(source.id, newOrbitId, source.volume)) {
      flash("The orbit audio is unavailable.");
      return;
    }
    audioEngine.copyPluginSlotStates(source.plugins, duplicate.plugins);
    audioEngine.setOrbitAudioPan(newOrbitId, duplicate.audioPan);
    try {
      commitSceneDocument(nextScenes, current.activeSceneId);
    } catch (error) {
      audioEngine.removeOrbit(newOrbitId);
      flash(error instanceof Error ? error.message : "The orbit could not be duplicated.");
      return;
    }
    // Duplicates receive new slot IDs synchronously; runtime creation stays lazy.
    reconcileOrbitPlugins(duplicate);
    for (const planet of copiedPlanets) {
      if (planet.speed !== 1 || planet.pitchCents) {
        void requestProcessedPlanet(
          newOrbitId, planet.id, planet.speed, planet.pitchCents,
          getSampleStart(duplicate), getSampleEnd(duplicate),
          `duplicate-orbit:${newOrbitId}:${planet.id}`, "background"
        );
      }
    }
  }

  function copyPlanet(planetId = stateRef.current.selection.planetId) {
    if (!planetId) return;
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    setClipboard({
      type: "planet",
      sourceOrbitId: planet.orbitId,
      data: {
        speed: planet.speed,
        volume: planet.volume,
        audioPan: planet.audioPan,
        pitchCents: planet.pitchCents,
        direction: planet.direction,
        isActive: planet.isActive
      }
    });
    flash("Planet copied.");
  }

  function findAvailablePlanetAngle(orbitId: string) {
    const existingCount = stateRef.current.planets.filter((planet) => planet.orbitId === orbitId).length;
    return ((existingCount * Math.PI) / 6) % TAU;
  }

  function pastePlanet(targetOrbitId?: string | null, requestedAngle?: number) {
    const currentClipboard = clipboardRef.current;
    if (currentClipboard?.type !== "planet") return;
    const state = stateRef.current;
    const targetId = targetOrbitId ??
      state.selection.orbitId ??
      (state.orbits.some((orbit) => orbit.id === currentClipboard.sourceOrbitId)
        ? currentClipboard.sourceOrbitId : null);
    if (!targetId || !state.orbits.some((orbit) => orbit.id === targetId)) {
      flash("Select an orbit to paste the planet.");
      return;
    }
    const copied = currentClipboard.data;
    const planetId = projectId();
    const newPlanet: Planet = {
      id: planetId,
      orbitId: targetId,
      angle: requestedAngle ?? findAvailablePlanetAngle(targetId),
      speed: copied.speed,
      volume: copied.volume,
      audioPan: copied.audioPan,
      pitchCents: copied.pitchCents,
      direction: copied.direction,
      isActive: copied.isActive,
      collisionSpeedMultiplier: 1,
      collisionFlashRemaining: 0
    };
    pushHistory();
    commitActiveSceneMutation((scene) => ({ ...scene, planets: [...scene.planets, newPlanet] }));
    selectSingle({ orbitId: targetId, planetId, barId: null });
    if (newPlanet.speed !== 1 || newPlanet.pitchCents) {
      const targetOrbit = stateRef.current.orbits.find((orbit) => orbit.id === newPlanet.orbitId);
      void requestProcessedPlanet(
        newPlanet.orbitId, newPlanet.id, newPlanet.speed, newPlanet.pitchCents,
        targetOrbit ? getSampleStart(targetOrbit) : 0, targetOrbit ? getSampleEnd(targetOrbit) : Infinity,
        `paste:${newPlanet.orbitId}:${newPlanet.id}`, "selected"
      );
    }
    flash("Planet pasted.");
  }

  function pastePlanetToSelectedOrbit() {
    pastePlanet(stateRef.current.selection.orbitId);
  }

  function pastePlanetAtMenu() {
    if (!menu?.orbitId) return pastePlanetToSelectedOrbit();
    const orbit = stateRef.current.orbits.find((item) => item.id === menu.orbitId);
    if (!orbit) return;
    pastePlanet(orbit.id, orbitAngleAtPoint(orbit, menu.canvasX, menu.canvasY));
    setMenu(null);
  }

  const { previewPlanetSpeed, commitPlanetSpeed, previewPlanetPitch, commitPlanetPitch } = useSpeedPitchProcessing({
    stateRef, setPlanets, setScenes, pushHistory, flash, audioEngine,
    randomId, clamp, minDirectRate: MIN_DIRECT_RATE, maxDirectRate: MAX_DIRECT_RATE,
    startRenderOwner, releaseRenderOwner, refreshCommittedScene: refreshCommittedSceneReadiness
  });

  async function createOrbitFromAudio(
    file: File, point: { x: number; y: number }, offset = 0, targetSceneId = stateRef.current.activeSceneId
  ) {
    if (!supportedAudio(file)) return flash("Please choose a WAV, MP3, or OGG audio file.");
    const sceneId = targetSceneId;
    const sourceScene = stateRef.current.scenes.find((scene) => scene.id === sceneId);
    if (!sourceScene) return;
    const orbitId = projectOrbitId(0);
    try {
      await audioEngine.resume();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let nextScenes: Scene[] | null = null;
      let activeAtCommit = sceneId;
      let duration = 0;
      await runStagedDocumentTransaction({
        stage: async () => (await audioEngine.stageProjectAudio([{
          orbitId, fileName: file.name, bytes, volume: 1, pan: 0
        }]))[0],
        commit: (staged) => {
          const current = stateRef.current;
          const currentTarget = current.scenes.find((scene) => scene.id === sceneId);
          if (!currentTarget) {
            throw new Error("The scene changed while audio was decoding; import was canceled.");
          }
          if (current.scenes.some((scene) => scene.id === orbitId || scene.orbits.some((orbit) =>
            orbit.id === orbitId || impliedSpliceBarIds(orbit).includes(orbitId)) ||
            scene.planets.some((planet) => planet.id === orbitId) || scene.bars.some((bar) => bar.id === orbitId))) {
            throw new Error("The imported orbit ID conflicts with the current project; import was canceled.");
          }
          duration = staged.buffer.duration;
          const radiusX = 145, radiusY = 90;
          const name = file.name.replace(/\.[^.]+$/, "");
          const orbit: Orbit = {
            id: orbitId, name, audioName: file.name, audioDuration: duration,
            x: Math.max(180, point.x + offset * 24), y: Math.max(150, point.y + offset * 20),
            radiusX, radiusY, initialRadiusX: radiusX, initialRadiusY: radiusY,
            mode: "loop", volume: 1, audioPan: 0, isPaused: false, isMuted: false, isSolo: false,
            color: ORBIT_COLORS[currentTarget.orbits.length % ORBIT_COLORS.length],
            sequenceRetriggerMode: "overlap"
          };
          nextScenes = updateSceneById(current.scenes, sceneId, (scene) => ({
            ...scene,
            orbits: [...scene.orbits, orbit],
            selection: { orbitId, planetId: null, barId: null },
            multiSelection: { orbitIds: [], planetIds: [] }
          }));
          activeAtCommit = current.activeSceneId;
          audioEngine.installStagedOrbitAudio(staged);
        },
        publish: () => {
          if (!nextScenes) throw new Error("Audio import transaction produced no document.");
          commitSceneDocument(nextScenes, activeAtCommit);
        },
        rollback: () => audioEngine.removeOrbit(orbitId)
      });
      flash(`${file.name} — ${duration.toFixed(1)}s timeline created.`);
    } catch (error) {
      audioEngine.removeOrbit(orbitId);
      flash(error instanceof Error && error.message.includes("scene changed")
        ? error.message : "That audio file could not be decoded.");
    }
  }

  async function handleFiles(files: File[], point: { x: number; y: number }) {
    const audioFiles = files.filter(supportedAudio);
    if (!audioFiles.length) return flash("Drop WAV, MP3, or OGG audio files.");
    const batchSceneId = stateRef.current.activeSceneId;
    for (let index = 0; index < audioFiles.length; index++) {
      await createOrbitFromAudio(audioFiles[index], point, index, batchSceneId);
    }
  }

  async function performProjectSave(currentPath?: string) {
    if (!window.orbitonicAPI) return flash("Project saving is only available in the desktop app.");
    // This is a save barrier, not dirty tracking: every live WAM is sampled on
    // every save. The serializer only reads the committed store after the barrier.
    try {
      await audioEngine.snapshotOrbitPluginStates();
      const project = serializeProject(
        projectName || "Untitled Session", scenes, activeSceneId, lastLoopBarLengthRadians,
        { volume: masterVolume, pan: masterPan }, audioEngine.getPluginStateStore()
      );
      const assets = scenes.flatMap((scene) => scene.orbits).flatMap((orbit) => {
        const asset = audioEngine.getProjectAsset(orbit.id);
        return asset ? [{ orbitId: orbit.id, fileName: asset.fileName, bytes: asset.bytes }] : [];
      });
      const result = await window.orbitonicAPI.saveProject({ project, assets }, currentPath);
      if (result.ok) {
        setProjectPath(result.path);
        setIsDirty(false);
        flash("Project saved.");
      } else if (!result.canceled) flash(result.error ?? "Project could not be saved.");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Project could not be saved.");
    }
  }

  async function saveProject() {
    await performProjectSave(projectPath);
  }

  async function saveProjectAs() {
    await performProjectSave(undefined);
  }

  async function openProject() {
    if (!window.orbitonicAPI) return flash("Project loading is only available in the desktop app.");
    if (isDirty && !window.confirm("You have unsaved changes. Open another project anyway?")) return;
    const result = await window.orbitonicAPI.openProject();
    if (!result.ok || !result.text) {
      if (!result.canceled) flash(result.error ?? "Project could not be opened.");
      return;
    }
    const projectRenderOwnerEpoch = ++projectRenderEpoch.current;
    abortRenderOwners(() => true);
    resetPlaybackRenderScope();
    try {
      const project = parseProject(result.text);
      // Parsing has already validated JSON shape/limits. Keep the restored store
      // frozen until the active-scene transition hydrates its slots.
      const restoredPluginStates = new Map(Object.entries(project.pluginStates));
      const assetMap = new Map((result.assets ?? []).map((asset) => [asset.orbitId, asset]));
      const missing: string[] = [];
      const restoredScenes: Scene[] = [];
      const audioInputs: ProjectAudioInput[] = [];
      for (const rawScene of project.scenes) {
        const restoredOrbits: Orbit[] = [];
        for (const raw of rawScene.orbits) {
          const orbit: Orbit = {
            ...raw,
            name: raw.name ?? raw.audioName.replace(/\.[^.]+$/, ""),
            color: raw.color ?? "#5b625d",
            isMuted: raw.isMuted ?? false,
            isSolo: raw.isSolo ?? false,
            audioPan: raw.audioPan ?? 0,
            sequenceRetriggerMode: raw.sequenceRetriggerMode ?? "overlap",
            spliceCount: normalizeSpliceCount(raw.spliceCount ?? 0),
            spliceStartAngle: normalizeAngle(raw.spliceStartAngle ?? 0)
          };
          const asset = assetMap.get(orbit.id);
          if (asset?.bytes) {
            orbit.isMissingAudio = false;
            audioInputs.push({
              orbitId: orbit.id, fileName: orbit.audioName, bytes: asset.bytes,
              volume: orbit.volume, pan: orbit.audioPan
            });
          } else {
            orbit.isMissingAudio = true;
            missing.push(asset?.error ?? orbit.audioPath ?? orbit.audioName);
          }
          restoredOrbits.push(orbit);
        }
        restoredScenes.push({ ...rawScene, orbits: restoredOrbits });
      }
      // Preflight a brand-new ID session before decoding or mutating the live audio graph.
      // Assignment in publish is infallible; opened projects never inherit old tombstones.
      const restoredProjectIds = createProjectIdAllocatorForScenes(restoredScenes, randomId);
      await runStagedDocumentTransaction({
        // Decode everything before touching the current document or live audio graph.
        stage: () => audioEngine.stageProjectAudio(audioInputs),
        commit: (stagedAudio) => {
          const durations = new Map(stagedAudio.map((item) => [item.orbitId, item.buffer.duration]));
          for (const scene of restoredScenes) for (const orbit of scene.orbits) {
            const duration = durations.get(orbit.id);
            if (duration !== undefined) orbit.audioDuration = duration;
          }
          // This method owns live-graph rollback if installation fails.
          audioEngine.replaceProjectAudio(stagedAudio);
        },
        publish: () => {
          resetParameterHistoryWindow();
          projectIds.current = restoredProjectIds;
          audioEngine.replacePluginStateStore(restoredPluginStates);
          setScenes(restoredScenes);
          setActiveSceneId(project.activeSceneId);
          setMasterVolume(project.master.volume);
          setMasterPan(project.master.pan);
          setLastLoopBarLengthRadians(project.lastLoopBarLengthRadians);
          setProjectName(project.projectName);
          setProjectPath(result.path);
          setIsPlaying(false);
          setIsDirty(false);
          undoStack.current = [];
          redoStack.current = [];
          bumpHistoryRevision();
          refreshCommittedSceneReadiness(restoredScenes, project.activeSceneId, () => {
            for (const scene of restoredScenes) {
              if (scene.id === project.activeSceneId) continue;
              for (const request of collectSceneAudioRequests(scene)) {
                void requestProcessedPlanet(
                  request.orbitId, request.planetId, request.speed, request.pitchCents,
                  request.sampleStart, request.sampleEnd,
                  `project-open:${projectRenderOwnerEpoch}:${scene.id}:${request.orbitId}:${request.planetId}`,
                  "background", request.direction
                );
              }
            }
          });
          if (missing.length) flash(`Project loaded with missing audio: ${missing.join(", ")}`, 5000);
          else flash("Project loaded.");
        }
      });
    } catch (error) {
      flash(error instanceof Error ? error.message : "Project could not be loaded.");
    }
  }

  async function toggleRecording() {
    if (recordingInFlight.current) return;
    if (recordingPhase !== "idle" && recordingPhase !== "recording") return;
    recordingInFlight.current = true;
    let recordingStarted = false;
    try {
      if (recordingPhase === "idle") {
        setRecordingPhase("starting");
        await audioEngine.resume();
        await audioEngine.startRecording();
        setIsRecording(true);
        setRecordingPhase("recording");
        recordingStarted = true;
        flash("Recording started.");
      } else {
        const recording = await audioEngine.stopRecording();
        setIsRecording(false);
        setRecordingPhase("encoding");
        const bytes = encodeWav(recording.channels, recording.sampleRate, recordingSampleFormat);
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        setRecordingPhase("saving");
        const result = await window.orbitonicAPI?.saveRecording(bytes, `recording_${stamp}.wav`);
        if (result?.ok) flash("Recording saved.");
        else if (!result?.canceled) flash(result?.error ?? "Recording could not be saved.");
      }
    } catch (error) {
      setIsRecording(false);
      flash(error instanceof Error ? error.message : "Recording failed.");
    } finally {
      if (!recordingStarted) setRecordingPhase("idle");
      recordingInFlight.current = false;
    }
  }

  async function savePreferences(sampleFormat: WavSampleFormat) {
    if (!window.orbitonicAPI) throw new Error("Preferences are only available in the desktop app.");
    const preferences = await window.orbitonicAPI.setPreferences({ export: { sampleFormat } });
    setRecordingSampleFormat(preferences.export.sampleFormat);
    flash("Preferences saved.");
  }

  function updateOrbit(orbitId: string, changes: Partial<Orbit>) {
    pushHistory();
    setOrbits((current) => current.map((orbit) => orbit.id === orbitId ? { ...orbit, ...changes } : orbit));
  }

  function reconcileOrbitPlugins(orbit: Orbit) {
    setPluginRuntimeRevision((revision) => revision + 1);
    void audioEngine.reconcileOrbitPluginRack(orbit.id, orbit.plugins ?? []).catch(() => {
      // The rack publishes an unavailable/dry placeholder rather than breaking
      // the native orbit path. UI status is refreshed in either outcome.
    }).finally(() => setPluginRuntimeRevision((revision) => revision + 1));
  }

  function changeOrbitPlugins(orbitId: string, transform: (plugins: NonNullable<Orbit["plugins"]>) => NonNullable<Orbit["plugins"]>) {
    const current = stateRef.current.orbits.find((orbit) => orbit.id === orbitId);
    if (!current) return;
    const plugins = transform([...(current.plugins ?? [])]);
    pushHistory();
    const nextOrbit = { ...current, plugins };
    setOrbits((orbits) => orbits.map((orbit) => orbit.id === orbitId ? nextOrbit : orbit));
    reconcileOrbitPlugins(nextOrbit);
  }

  function setOrbitMode(orbitId: string, mode: OrbitMode) {
    audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    pushHistory();
    commitActiveSceneMutation((scene) => ({
      ...scene,
      orbits: scene.orbits.map((orbit) => orbit.id === orbitId ? { ...orbit, mode } : orbit),
      bars: mode === "loop"
        ? scene.bars.map((bar) => bar.orbitId === orbitId ? { ...bar, kind: "play" } : bar)
        : scene.bars
    }));
  }

  function toggleOrbitPause(orbitId = menu?.orbitId) {
    if (!orbitId) return;
    const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
    if (!orbit) return;
    if (!orbit.isPaused) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    updateOrbit(orbitId, { isPaused: !orbit.isPaused });
    setMenu(null);
  }

  function setOrbitMute(orbitId: string, muted: boolean) {
    if (muted) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    updateOrbit(orbitId, { isMuted: muted });
  }

  function setOrbitSolo(orbitId: string, solo: boolean) {
    const next = stateRef.current.orbits.map((orbit) => orbit.id === orbitId ? { ...orbit, isSolo: solo } : orbit);
    pushHistory();
    setOrbits(next);
    const hasSolo = next.some((orbit) => orbit.isSolo);
    for (const orbit of next) {
      if (orbit.isMuted || (hasSolo && !orbit.isSolo)) audioEngine.stopAllActivePlaybacksForOrbit(orbit.id);
    }
  }

  function applyOrbitTapeRate(orbitId: string, requestedRate: number) {
    const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
    if (!orbit) return;
    if (orbit.mode === "sequence") {
      flash("Sequence mode keeps orbit tape at 1.00x.");
      return;
    }
    const rate = clamp(requestedRate, MIN_DIRECT_RATE, MAX_DIRECT_RATE);
    const initialAverage = (orbit.initialRadiusX + orbit.initialRadiusY) / 2;
    const currentAverage = (orbit.radiusX + orbit.radiusY) / 2;
    if (initialAverage <= 0 || currentAverage <= 0) return;
    const targetAverage = initialAverage / rate;
    const scale = targetAverage / currentAverage;
    const resized: Orbit = {
      ...orbit,
      radiusX: clamp(orbit.radiusX * scale, MIN_DIRECT_ORBIT_RADIUS, MAX_DIRECT_ORBIT_RADIUS),
      radiusY: clamp(orbit.radiusY * scale, MIN_DIRECT_ORBIT_RADIUS, MAX_DIRECT_ORBIT_RADIUS)
    };
    pushHistory();
    setOrbits((current) => current.map((item) => item.id === orbitId ? resized : item));
    for (const planet of stateRef.current.planets.filter((item) => item.orbitId === orbitId)) {
      audioEngine.setActivePlanetTapeRate(planet.id, getTapeStyleRuntimeRateOnly(resized, planet));
    }
  }

  function applyPlanetCollisionTape(planetId: string, requestedRate: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    const orbit = stateRef.current.orbits.find((item) => item.id === planet?.orbitId);
    if (!planet || !orbit) return;
    if (orbit.mode === "sequence") {
      flash("Sequence mode runtime tape stays at 1.00x.");
      return;
    }
    const collisionSpeedMultiplier = clamp(requestedRate, MIN_DIRECT_RATE, MAX_DIRECT_RATE);
    const nextPlanet = { ...planet, collisionSpeedMultiplier };
    pushHistory();
    setPlanets((current) => current.map((item) => item.id === planetId ? nextPlanet : item));
    audioEngine.setActivePlanetTapeRate(planetId, getTapeStyleRuntimeRateOnly(orbit, nextPlanet));
  }

  function applyPlanetRuntimeTape(planetId: string, requestedRate: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    const orbit = stateRef.current.orbits.find((item) => item.id === planet?.orbitId);
    if (!planet || !orbit) return;
    if (orbit.mode === "sequence") {
      flash("Sequence mode runtime tape stays at 1.00x.");
      return;
    }
    const orbitTapeRate = getOrbitTapeRate(orbit);
    if (orbitTapeRate <= 0) return;
    applyPlanetCollisionTape(planetId, requestedRate / orbitTapeRate);
  }

  function applyPlanetFinalMovement(planetId: string, requestedRate: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    const orbit = stateRef.current.orbits.find((item) => item.id === planet?.orbitId);
    if (!planet || !orbit) return;
    const finalMovement = Math.max(MIN_DIRECT_RATE, requestedRate);
    const runtimeTapeRate = getTapeStyleRuntimeRateOnly(orbit, planet);
    const nextSpeed = orbit.mode === "sequence"
      ? finalMovement
      : runtimeTapeRate > 0 ? finalMovement / runtimeTapeRate : planet.speed;
    void commitPlanetSpeed(planetId, clamp(nextSpeed, MIN_DIRECT_RATE, MAX_DIRECT_RATE));
  }

  function applyPlanetFinalPitch(planetId: string, requestedCents: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    const orbit = stateRef.current.orbits.find((item) => item.id === planet?.orbitId);
    if (!planet || !orbit) return;
    const runtimeTapeRate = getTapeStyleRuntimeRateOnly(orbit, planet);
    const nextPitch = Math.round(requestedCents - rateToCents(runtimeTapeRate));
    void commitPlanetPitch(planetId, clamp(nextPitch, -3600, 3600));
  }

  function addContextBar(kind: "play" | "stop") {
    const orbit = orbits.find((item) => item.id === menu?.orbitId);
    if (!orbit || !menu) return;
    pushHistory();
    const angle = orbitAngleAtPoint(orbit, menu.canvasX, menu.canvasY);
    const bar: TriggerBar = {
      id: projectId(), orbitId: orbit.id, angle, lengthRadians: SEQUENCE_BAR_LENGTH_RADIANS,
      startAngle: ((angle - SEQUENCE_BAR_LENGTH_RADIANS / 2) % TAU + TAU) % TAU, kind
    };
    setBars((current) => [...current, bar]);
    selectSingle({ orbitId: orbit.id, planetId: null, barId: bar.id });
    setMenu(null);
  }

  useEffect(() => {
    const resume = () => void audioEngine.resume();
    window.addEventListener("pointerdown", resume, { once: true });
  }, []);

  useMenuActionDispatch({
    "open-project": openProject,
    "save-project": saveProject,
    "save-project-as": saveProjectAs,
    preferences: () => setIsPreferencesOpen(true)
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.matches("input, select, textarea") || target.isContentEditable);
      if (typing && event.key !== "Escape") return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      // Electron's native File menu owns these accelerators and emits one IPC
      // action. Keep this renderer fallback only for a non-desktop preview so a
      // single Cmd/Ctrl+S or Cmd/Ctrl+O cannot run both paths.
      const nativeMenuHandlesFileShortcuts = !!window.orbitonicAPI?.onMenuAction;
      if (command && /^[1-9]$/.test(key)) {
        const targetScene = stateRef.current.scenes[Number(key) - 1];
        if (targetScene) { event.preventDefault(); activateScene(targetScene.id); }
      }
      else if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        const current = stateRef.current;
        const activeIndex = current.scenes.findIndex((scene) => scene.id === current.activeSceneId);
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (activeIndex + direction + current.scenes.length) % current.scenes.length;
        activateScene(current.scenes[nextIndex].id);
      }
      else if (command && key === "z" && event.shiftKey) { event.preventDefault(); redo(); }
      else if ((command && key === "y")) { event.preventDefault(); redo(); }
      else if (command && key === "z") { event.preventDefault(); undo(); }
      else if (command && key === "c" && stateRef.current.selection.planetId) {
        event.preventDefault();
        copyPlanet(stateRef.current.selection.planetId);
      }
      else if (command && key === "v" && clipboardRef.current?.type === "planet") {
        event.preventDefault();
        pastePlanet();
      }
      else if (command && key === "d") { event.preventDefault(); duplicateOrbit(); }
      else if (command && key === "s" && !nativeMenuHandlesFileShortcuts) { event.preventDefault(); void saveProject(); }
      else if (command && key === "o" && !nativeMenuHandlesFileShortcuts) { event.preventDefault(); void openProject(); }
      else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        const multi = stateRef.current.multiSelection;
        if (multi.orbitIds.length || multi.planetIds.length) deleteMultiSelection();
        else deleteSelection();
      }
      else if (!command && key === "s") setSelectedTool("select");
      else if (!command && key === "p") setSelectedTool("planet");
      else if (!command && key === "b") setSelectedTool("bar");
      else if (!command && key === "r") void toggleRecording();
      else if (event.code === "Space") {
        event.preventDefault();
        if (isPlaying) { audioEngine.stopAllActivePlaybacks(); setIsPlaying(false); }
        else { void audioEngine.resume(); setIsPlaying(true); }
      } else if (event.key === "Escape") {
        setMenu(null); clearSelection();
        setCancelSignal((value) => value + 1);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  return <main className="app" onClick={() => setMenu(null)}>
    <header className="topline">
      <span>ORBITRONICA</span><small>{projectName.toUpperCase()} {isDirty ? "•" : ""}</small>
      <i className={`topline-status ${isRecording ? "recording" : isPlaying ? "live" : ""}`}>
        {isRecording ? "RECORDING" : isPlaying ? "RUNNING" : "PAUSED"}
      </i>
      <MasterControls
        volume={masterVolume} pan={masterPan}
        isActive={(isPlaying && orbits.length > 0) || isRecording}
        onVolume={changeMasterVolume} onPan={changeMasterPan} />
    </header>
    <SceneTabs
      scenes={scenes}
      activeSceneId={activeSceneId}
      onActivate={activateScene}
      onAdd={addScene}
      onDelete={removeActiveScene}
      onDuplicate={() => void duplicateActiveScene()}
      duplicateDisabled={isDuplicatingScene}
      onRename={commitSceneRename}
      onReorder={commitSceneReorder}
    />
    <Toolbar selected={selectedTool} onSelect={setSelectedTool} />
    <section className={`canvas-shell ${isDragOver ? "receiving" : ""}`}>
      {!orbits.length && <div className="welcome">
        <div className="welcome-orbit"><i /></div><h1>Make sound move.</h1>
        <p>Drop a sound here or right-click to upload,<br />then place planets and time regions on its orbit.</p>
        <button onClick={(event) => {
          event.stopPropagation(); uploadPoint.current = { x: 520, y: 380 }; fileInput.current?.click();
        }}>Upload your first sound</button>
      </div>}
      <CanvasStage
        orbits={orbits} planets={planets} bars={bars} waveformPeaksByOrbit={waveformPeaksByOrbit} selection={selection}
        multiSelection={multiSelection}
        selectedTool={selectedTool} isPlaying={isPlaying} isDragOver={isDragOver}
        cancelSignal={cancelSignal} viewport={viewport} onViewportChange={setViewport}
        onSelect={selectSingle}
        onMarqueeSelect={selectMultiple}
        onBeginMutation={pushHistory}
        onAddPlanet={(orbitId, angle) => {
          pushHistory();
          const planetId = projectId();
          const planet: Planet = {
            id: planetId, orbitId, angle, speed: 1, volume: 1, audioPan: 0, pitchCents: 0, isActive: true,
            direction: 1, collisionSpeedMultiplier: 1,
            collisionFlashRemaining: 0
          };
          commitActiveSceneMutation((scene) => ({ ...scene, planets: [...scene.planets, planet] }));
          selectSingle({ orbitId, planetId, barId: null });
        }}
        onAddBar={(orbitId, angle) => {
          pushHistory();
          const orbit = orbits.find((item) => item.id === orbitId);
          const remembered = lastLoopBarLengthRadians >= TAU ? DEFAULT_LOOP_BAR_LENGTH_RADIANS : lastLoopBarLengthRadians;
          const length = orbit?.mode === "sequence" ? SEQUENCE_BAR_LENGTH_RADIANS :
            Math.min(TAU, Math.max(MIN_BAR_LENGTH_RADIANS, remembered));
          const bar: TriggerBar = {
            id: projectId(), orbitId, angle, lengthRadians: length,
            startAngle: ((angle - length / 2) % TAU + TAU) % TAU, kind: "play"
          };
          setBars((current) => [...current, bar]);
          selectSingle({ orbitId, planetId: null, barId: bar.id });
        }}
        onMovePlanets={(updates) => {
          for (const planet of stateRef.current.planets) {
            const changes = updates.get(planet.id);
            if (!changes || changes.collisionSpeedMultiplier === undefined ||
              changes.collisionSpeedMultiplier === planet.collisionSpeedMultiplier) continue;
            const orbit = stateRef.current.orbits.find((item) => item.id === planet.orbitId);
            if (orbit?.mode === "loop") {
              audioEngine.setActivePlanetTapeRate(
                planet.id, getTapeStyleRuntimeRateOnly(orbit, { ...planet, ...changes })
              );
            }
          }
          commitMotionSceneMutation(updates);
        }}
        sceneId={activeSceneId}
        playbackEpoch={playbackEpoch.current}
        onLoopFrame={(orbit, planet, bar, inside, angle, callback) => {
          if (!isCurrentPlaybackCallback(callback.sceneId, callback.epoch) || !canOrbitSound(orbit.id)) return;
          audioEngine.syncLoop(
            orbit.id, planet.id, bar.id, inside,
            getSampleStart(orbit) + angle / TAU * getSampleDuration(orbit), planet.volume,
            planet.audioPan,
            getTapeStyleRuntimeRateOnly(orbit, planet), planet.speed, planet.pitchCents,
            planet.direction === -1, getSampleStart(orbit), getSampleEnd(orbit),
            playbackRenderScope(callback.sceneId, callback.epoch, "loop", planet.id, bar.id)
          );
        }}
        onSequencePlay={(orbit, planet, bar, callback) => {
          if (!isCurrentPlaybackCallback(callback.sceneId, callback.epoch) || !canOrbitSound(orbit.id)) return;
          audioEngine.triggerSequence(
            orbit.id, planet.id, bar.id, planet.volume, planet.audioPan, 1, planet.pitchCents,
            planet.direction === -1, orbit.sequenceRetriggerMode,
            getSampleStart(orbit), getSampleEnd(orbit),
            playbackRenderScope(callback.sceneId, callback.epoch, "sequence", planet.id, bar.id)
          );
        }}
        onSequenceStop={(orbitId, callback) => {
          if (!isCurrentPlaybackCallback(callback.sceneId, callback.epoch)) return;
          audioEngine.stopActiveSequencePlaybacksForOrbit(orbitId);
        }}
        onResizeOrbit={(orbitId, radiusX, radiusY) => setOrbits((current) =>
          current.map((orbit) => {
            if (orbit.id !== orbitId) return orbit;
            const resized = { ...orbit, radiusX, radiusY };
            for (const planet of stateRef.current.planets.filter((item) => item.orbitId === orbitId)) {
              audioEngine.setActivePlanetTapeRate(planet.id, getTapeStyleRuntimeRateOnly(resized, planet));
            }
            return resized;
          }))}
        onMoveOrbit={(orbitId, x, y) => setOrbits((current) =>
          current.map((orbit) => orbit.id === orbitId ? { ...orbit, x, y } : orbit))}
        onEditBar={(barId, angle, lengthRadians, startAngle) => setBars((current) =>
          current.map((bar) => bar.id === barId && bar.source !== "splice"
            ? { ...bar, angle, lengthRadians, startAngle }
            : bar))}
        onBarLengthEditEnd={(barId, lengthRadians) => {
          const bar = stateRef.current.bars.find((item) => item.id === barId);
          const orbit = stateRef.current.orbits.find((item) => item.id === bar?.orbitId);
          if (bar && orbit?.mode === "loop" && bar.kind === "play" &&
            !isFullLoopBar({ ...bar, lengthRadians })) {
            setLastLoopBarLengthRadians(Math.min(TAU - .0001, Math.max(MIN_BAR_LENGTH_RADIANS, lengthRadians)));
          }
        }}
        onSetSpliceCount={setOrbitSpliceCount}
        onSetSpliceStart={setOrbitSpliceStart}
        onContextMenu={(next) => { setMenu(next); uploadPoint.current = { x: next.canvasX, y: next.canvasY }; }}
        onDropFiles={(files, point) => void handleFiles(files, point)} onDragState={setIsDragOver}
      />
    </section>

    <OrbitSettingsPanel
      orbit={selectedOrbit} planets={planets} projectName={projectName} isDirty={isDirty}
      waveformPeaks={selectedOrbit ? waveformPeaksByOrbit.get(selectedOrbit.id) : undefined}
      onSampleTrim={(orbitId, start, end) => {
        const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
        if (!orbit) return;
        const window = normalizeSampleWindow(orbit.audioDuration, start, end);
        const audioDurationAtRequest = orbit.audioDuration;
        const sceneIdAtRequest = stateRef.current.activeSceneId;
        const currentScenes = stateRef.current.scenes;
        const applyWindow = (scenes: Scene[]) => updateSceneById(scenes, sceneIdAtRequest, (scene) => ({
          ...scene,
          orbits: scene.orbits.map((item) => item.id === orbitId
            ? { ...item, sampleStart: window.start, sampleEnd: window.end }
            : item)
        }));
        const nextScenes = applyWindow(currentScenes);
        const trimOwnerEpoch = projectRenderEpoch.current;
        void prewarmAndCommitSceneMutation(
          nextScenes, sceneIdAtRequest, `trim:${trimOwnerEpoch}:${orbitId}`, "selected", () => {
          // While playing, motion commits replace the scenes array up to every 250ms, so a
          // whole-array identity guard here would almost always silently drop this publish.
          // Rebase onto whatever is current instead: only bail if the orbit itself is gone
          // or its audio was replaced (a concurrent replacement bumps the source generation,
          // which would make the prewarmed artifacts above stale).
          const rebaseOrbit = stateRef.current.scenes
            .find((scene) => scene.id === sceneIdAtRequest)?.orbits.find((item) => item.id === orbitId);
          if (!rebaseOrbit || rebaseOrbit.audioDuration !== audioDurationAtRequest) return;
          const rebased = applyWindow(stateRef.current.scenes);
          pushParameterHistory();
          refreshCommittedSceneReadiness(rebased, sceneIdAtRequest);
          setScenes(rebased);
          audioEngine.stopActiveLoopPlaybacksForOrbit(orbitId);
        }).catch((error: unknown) => {
          if (!isExpectedDspAbort(error)) flash("Trim processing failed; the previous sample window remains active.");
        });
      }}
      hasPlanetClipboard={clipboard?.type === "planet"}
      onProjectName={(name) => { setProjectName(name); setIsDirty(true); }}
      onSave={() => void saveProject()} onOpen={() => void openProject()}
      onMode={(mode) => selectedOrbit && setOrbitMode(selectedOrbit.id, mode)}
      onSpliceCount={(count) => {
        if (!selectedOrbit) return;
        pushParameterHistory();
        setOrbitSpliceCount(selectedOrbit.id, count);
      }}
      onName={(name) => selectedOrbit && updateOrbit(selectedOrbit.id, { name })}
      onColor={(color) => {
        if (!selectedOrbit) return;
        pushParameterHistory();
        setOrbits((current) => current.map((orbit) =>
          orbit.id === selectedOrbit.id ? { ...orbit, color } : orbit));
      }}
      onVolume={(volume) => {
        if (!selectedOrbit) return;
        pushParameterHistory();
        setOrbits((current) => current.map((orbit) =>
          orbit.id === selectedOrbit.id ? { ...orbit, volume } : orbit));
        audioEngine.setVolume(selectedOrbit.id, volume);
      }}
      onOrbitAudioPan={(audioPan) => {
        if (!selectedOrbit) return;
        pushParameterHistory();
        audioEngine.setOrbitAudioPan(selectedOrbit.id, audioPan);
        setOrbits((current) => current.map((orbit) =>
          orbit.id === selectedOrbit.id ? { ...orbit, audioPan } : orbit));
      }}
      onPause={() => selectedOrbit && toggleOrbitPause(selectedOrbit.id)}
      onMute={(muted) => selectedOrbit && setOrbitMute(selectedOrbit.id, muted)}
      onSolo={(solo) => selectedOrbit && setOrbitSolo(selectedOrbit.id, solo)}
      onToggleWaveform={(show) => selectedOrbit && updateOrbit(selectedOrbit.id, { showWaveform: show })}
      onRetriggerMode={(sequenceRetriggerMode: SequenceRetriggerMode) =>
        selectedOrbit && updateOrbit(selectedOrbit.id, { sequenceRetriggerMode })}
      onDuplicate={() => selectedOrbit && duplicateOrbit(selectedOrbit.id)}
      onDeleteOrbit={deleteSelection}
      onAddPlugin={(orbitId, catalogId) => {
        const entry = getWamCatalogEntry(catalogId);
        if (!entry) return;
        changeOrbitPlugins(orbitId, (plugins) => [...plugins, {
          id: projectId(), catalogId: entry.id, pluginVersion: entry.pluginVersion, bypassed: false
        }]);
      }}
      onMovePlugin={(slotId, direction) => {
        if (!selectedOrbit) return;
        changeOrbitPlugins(selectedOrbit.id, (plugins) => {
          const index = plugins.findIndex((slot) => slot.id === slotId);
          const next = index + direction;
          if (index < 0 || next < 0 || next >= plugins.length) return plugins;
          [plugins[index], plugins[next]] = [plugins[next], plugins[index]];
          return plugins;
        });
      }}
      onBypassPlugin={(slotId, bypassed) => selectedOrbit && changeOrbitPlugins(selectedOrbit.id,
        (plugins) => plugins.map((slot) => slot.id === slotId ? { ...slot, bypassed } : slot))}
      onRemovePlugin={(slotId) => selectedOrbit && changeOrbitPlugins(selectedOrbit.id,
        (plugins) => plugins.filter((slot) => slot.id !== slotId))}
      pluginStatus={(slotId) => selectedOrbit ? audioEngine.getOrbitPluginStatus(selectedOrbit.id, slotId) : "idle"}
      onMountPluginGui={(slotId, container) => selectedOrbit
        ? audioEngine.mountOrbitPluginGui(selectedOrbit.id, slotId, container)
        : Promise.resolve()}
      onUnmountPluginGui={(slotId) => selectedOrbit
        ? audioEngine.unmountOrbitPluginGui(selectedOrbit.id, slotId)
        : Promise.resolve()}
      onPlanetSpeedPreview={previewPlanetSpeed}
      onPlanetSpeedCommit={(planetId, speed) => void commitPlanetSpeed(planetId, speed)}
      onOrbitTapeRateApply={applyOrbitTapeRate}
      onPlanetCollisionTapeApply={applyPlanetCollisionTape}
      onPlanetRuntimeTapeApply={applyPlanetRuntimeTape}
      onPlanetFinalMovementApply={applyPlanetFinalMovement}
      onPlanetFinalPitchApply={applyPlanetFinalPitch}
      onPlanetVolume={(planetId, volume) => {
        pushParameterHistory(); audioEngine.setActivePlanetVolume(planetId, volume);
        setPlanets((current) => current.map((planet) => planet.id === planetId ? { ...planet, volume } : planet));
      }}
      onPlanetAudioPan={(planetId, audioPan) => {
        pushParameterHistory();
        audioEngine.setActivePlanetAudioPan(planetId, audioPan);
        setPlanets((current) => current.map((planet) =>
          planet.id === planetId ? { ...planet, audioPan } : planet));
      }}
      onPlanetPitchPreview={previewPlanetPitch}
      onPlanetPitchCommit={(planetId, cents) => void commitPlanetPitch(planetId, cents)}
      onPlanetReverse={(planetId, reverse) => {
        pushHistory();
        audioEngine.stopAllActivePlaybacksForPlanet(planetId);
        commitActiveSceneMutation((scene) => ({
          ...scene,
          planets: scene.planets.map((planet) =>
            planet.id === planetId ? { ...planet, direction: reverse ? -1 : 1 } : planet)
        }));
      }}
      onCopyPlanet={copyPlanet}
      onPastePlanetToOrbit={(orbitId) => pastePlanet(orbitId)}
      onDeletePlanet={deletePlanet}
    />
    <TransportControls isPlaying={isPlaying} isRecording={isRecording}
      onPlay={() => { void audioEngine.resume(); setIsPlaying(true); }}
      onPause={() => { audioEngine.stopAllActivePlaybacks(); setIsPlaying(false); }}
      onStop={() => {
        audioEngine.stopAllActivePlaybacks(); setIsPlaying(false);
        setPlanets((current) => current.map((planet) => ({ ...planet, angle: 0 })));
      }}
      onRecord={() => void toggleRecording()} />
    {menu && <ContextMenu menu={menu}
      sequenceMode={orbits.find((orbit) => orbit.id === menu.orbitId)?.mode === "sequence"}
      hasPlanetClipboard={clipboard?.type === "planet"}
      onClose={() => setMenu(null)}
      onUpload={() => { setMenu(null); fileInput.current?.click(); }}
      onToggleMode={() => {
        const orbit = orbits.find((item) => item.id === menu.orbitId);
        if (orbit) setOrbitMode(orbit.id, orbit.mode === "loop" ? "sequence" : "loop");
        setMenu(null);
      }}
      onTogglePause={() => toggleOrbitPause()}
      onDuplicate={() => { duplicateOrbit(menu.orbitId); setMenu(null); }}
      onCopyPlanet={() => {
        if (menu.planetId) copyPlanet(menu.planetId);
        setMenu(null);
      }}
      onPastePlanetHere={pastePlanetAtMenu}
      onAddPlayBar={() => addContextBar("play")} onAddStopBar={() => addContextBar("stop")} />}
    <input ref={fileInput} className="hidden-input" type="file" multiple
      accept=".wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg"
      onChange={(event) => {
        void handleFiles(Array.from(event.target.files ?? []), uploadPoint.current);
        event.currentTarget.value = "";
      }} />
    {isPreferencesOpen && <PreferencesModal
      sampleFormat={recordingSampleFormat}
      onClose={() => setIsPreferencesOpen(false)}
      onSave={savePreferences}
    />}
    {message && <div className="toast">{message}</div>}
    <footer>S/P/B TOOLS · SPACE TRANSPORT · CTRL+S SAVE · R RECORD</footer>
  </main>;
}
