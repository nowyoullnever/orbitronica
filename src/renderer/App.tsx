import { useEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { audioEngine, type ProjectAudioInput } from "./audio/audioEngine";
import { collectRetainedPluginSlotIds } from "./audio/wamRack";
import { WAM_CATALOG } from "./audio/wamCatalog";
import { encodeWav, type WavSampleFormat } from "./audio/wavEncoder";
import { CanvasStage } from "./components/CanvasStage";
import { ContextMenu } from "./components/ContextMenu";
import { MasterControls } from "./components/MasterControls";
import { OrbitSettingsPanel } from "./components/OrbitSettingsPanel";
import { PreferencesModal } from "./components/PreferencesModal";
import { SceneTabs } from "./components/SceneTabs";
import { Toolbar } from "./components/Toolbar";
import { TransportControls } from "./components/TransportControls";
import { parseProject, serializeProject } from "./project/projectSerializer";
import type {
  ContextMenuState, HistorySnapshot, MultiSelection, Orbit, OrbitMode, Planet, Scene, Selection,
  SequenceRetriggerMode, Tool, TriggerBar, ViewportState
} from "./state/types";
import {
  collectHistoryProjectIds, collectRetainedOrbitIds, createEmptyScene,
  createHistorySnapshot, createProjectIdAllocatorForScenes, createSpliceBars, deleteScene,
  impliedSpliceBarIds, nextDefaultSceneName, planSceneDuplicate, renameScene, reorderScenes,
  replaceOrbitSpliceSettings, reserveSceneProjectIds,
  reconcileSceneOrbitMix, runActiveSceneTransition, runStagedDocumentTransaction, stageSceneDuplicate,
  updatePlanetForFreshRequest, updateSceneById
} from "./state/scenes";
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
type MenuAction = "open-project" | "save-project" | "save-project-as" | "preferences";

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

const clearSpeedProcessing = (planet: Planet): Planet => ({
  ...planet,
  pendingSpeed: undefined,
  isSpeedProcessing: false,
  processingSpeed: undefined,
  speedProcessRequestId: undefined
});

const clearPitchProcessing = (planet: Planet): Planet => ({
  ...planet,
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
  const [initialProjectIds] = useState(() => createProjectIdAllocatorForScenes(scenes, randomId));
  const projectIds = useRef(initialProjectIds);
  const parameterHistoryTimer = useRef<number>();
  // Updated synchronously at the transition boundary so stale Canvas callbacks cannot revive old audio.
  const audibleSceneId = useRef<string | null>(activeSceneId);
  const playbackEpoch = useRef(0);
  // Separate from playbackEpoch: this cancels stale WAM hydration, not Canvas callbacks.
  const sceneTransitionEpoch = useRef(0);
  const clipboardRef = useRef<AppClipboard>(null);
  const sceneDuplicationPending = useRef(false);
  const recordingInFlight = useRef(false);
  const actionsRef = useRef<Record<MenuAction, () => void | Promise<void>>>({
    "open-project": () => undefined,
    "save-project": () => undefined,
    "save-project-as": () => undefined,
    preferences: () => undefined
  });
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

  function pruneUnreferencedAudio(currentScenes = stateRef.current.scenes) {
    audioEngine.pruneOrbits(collectRetainedOrbitIds(currentScenes, undoStack.current, redoStack.current));
    const retainedScenes = [currentScenes, ...undoStack.current.map((item) => item.scenes), ...redoStack.current.map((item) => item.scenes)].flat();
    audioEngine.prunePluginStateSlots(collectRetainedPluginSlotIds(retainedScenes));
  }

  function pushHistory() {
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
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
        audibleSceneId.current = nextSceneId;
        playbackEpoch.current += 1;
      },
      stopActivePlaybacks: () => audioEngine.stopAllActivePlaybacks(),
      closeTransientUi: () => setMenu(null),
      cancelInteractions: () => setCancelSignal((value) => value + 1)
    }, force);
  }

  function activateScene(nextSceneId: string) {
    if (!stateRef.current.scenes.some((scene) => scene.id === nextSceneId)) return;
    if (!prepareActiveSceneTransition(nextSceneId)) return;
    resetParameterHistoryWindow();
    setActiveSceneId(nextSceneId);
    // Publishing the target selection stays synchronous for the existing tab
    // contract. Audio remains gated until the newest hydration transaction settles.
    const epoch = ++sceneTransitionEpoch.current;
    const previous = stateRef.current.scenes.find((scene) => scene.id === stateRef.current.activeSceneId);
    const target = stateRef.current.scenes.find((scene) => scene.id === nextSceneId);
    audibleSceneId.current = null;
    void audioEngine.transitionScenePluginRacks(previous?.orbits ?? [], target?.orbits ?? [], epoch).then(() => {
      if (sceneTransitionEpoch.current === epoch) audibleSceneId.current = nextSceneId;
    }).catch(() => {
      // Per-slot unavailable placeholders remain dry. A rack failure must not
      // restore stale scene audio or overwrite durable bypass metadata.
      if (sceneTransitionEpoch.current === epoch) audibleSceneId.current = nextSceneId;
    });
  }

  function commitSceneDocument(nextScenes: Scene[], nextActiveSceneId: string) {
    resetParameterHistoryWindow();
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    prepareActiveSceneTransition(nextActiveSceneId);
    setScenes(nextScenes);
    setActiveSceneId(nextActiveSceneId);
    pruneUnreferencedAudio(nextScenes);
    setIsDirty(true);
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
        occupiedIds: collectHistoryProjectIds(baseScenes, undoStack.current, redoStack.current)
      });
    } catch (error) {
      flash(error instanceof Error ? error.message : "Scene could not be duplicated.");
      return;
    }
    sceneDuplicationPending.current = true;
    setIsDuplicatingScene(true);
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
      if (stateRef.current.scenes !== baseScenes) {
        for (const targetOrbitId of plan.orbitIdMap.values()) audioEngine.removeOrbit(targetOrbitId);
        flash("Scene changed while duplication was in progress; duplication was canceled.");
        return;
      }
      const sourceIndex = baseScenes.findIndex((scene) => scene.id === source.id);
      const next = baseScenes.slice();
      next.splice(sourceIndex + 1, 0, duplicate);
      commitSceneDocument(next, duplicate.id);
      for (const planet of duplicate.planets) {
        if (planet.speed !== 1 || planet.pitchCents) {
          void audioEngine.processPlanetBuffer(planet.orbitId, planet.id, planet.speed, planet.pitchCents);
        }
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : "Scene could not be duplicated.");
    } finally {
      sceneDuplicationPending.current = false;
      setIsDuplicatingScene(false);
    }
  }

  function restoreSnapshot(next: HistorySnapshot) {
    // Undo/redo is a runtime boundary even when the owning scene ID is unchanged.
    prepareActiveSceneTransition(next.activeSceneId, true);
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
    restoreSnapshot(next);
    pruneUnreferencedAudio(next.scenes);
    setIsDirty(true);
    flash("Redone.");
  }

  function flash(text: string, duration = 1800) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), duration);
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

  function deletePlanet(planetId: string) {
    pushHistory();
    audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    setPlanets((current) => current.filter((planet) => planet.id !== planetId));
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
      audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
      setOrbits((current) => current.filter((orbit) => orbit.id !== orbitId));
      setPlanets((current) => current.filter((planet) => planet.orbitId !== orbitId));
      setBars((current) => current.filter((bar) => bar.orbitId !== orbitId));
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
    for (const orbitId of orbitIds) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    for (const planetId of planetIds) audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    setOrbits((current) => current.filter((orbit) => !orbitIds.has(orbit.id)));
    setPlanets((current) => current.filter((planet) =>
      !planetIds.has(planet.id) && !orbitIds.has(planet.orbitId)));
    setBars((current) => current.filter((bar) => !orbitIds.has(bar.orbitId)));
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
    for (const planet of copiedPlanets) {
      if (planet.speed !== 1 || planet.pitchCents) {
        void audioEngine.processPlanetBuffer(newOrbitId, planet.id, planet.speed, planet.pitchCents);
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
    setPlanets((current) => [...current, newPlanet]);
    selectSingle({ orbitId: targetId, planetId, barId: null });
    if (newPlanet.speed !== 1 || newPlanet.pitchCents) {
      void audioEngine.processPlanetBuffer(
        newPlanet.orbitId, newPlanet.id, newPlanet.speed, newPlanet.pitchCents
      ).catch(() => flash("Pasted planet audio processing failed."));
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

  function previewPlanetSpeed(planetId: string, pendingSpeed: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingSpeed, speedProcessingError: undefined } : planet));
  }

  async function commitPlanetSpeed(planetId: string, requestedSpeed?: number) {
    const sceneId = stateRef.current.activeSceneId;
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const speed = clamp(requestedSpeed ?? planet.pendingSpeed ?? planet.speed, MIN_DIRECT_RATE, MAX_DIRECT_RATE);
    const pitchAtRequest = planet.pitchCents;
    if (planet.isSpeedProcessing && planet.processingSpeed === speed) return;
    if (Math.abs(speed - planet.speed) < .0001 && !planet.isSpeedProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingSpeed: undefined, speedProcessingError: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = randomId();
    if (audioEngine.hasProcessedBuffer(planet.orbitId, planet.id, speed, planet.pitchCents)) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearSpeedProcessing(item), speed, speedProcessingError: undefined } : item));
      return;
    }
    setPlanets((current) => current.map((item) => item.id === planetId ? {
      ...item,
      pendingSpeed: speed,
      isSpeedProcessing: true,
      processingSpeed: speed,
      speedProcessRequestId: requestId,
      speedProcessingError: undefined
    } : item));
    try {
      await audioEngine.processPlanetBuffer(planet.orbitId, planet.id, speed, pitchAtRequest);
      let latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.speedProcessRequestId !== requestId) return;
      if (latest.pitchCents !== pitchAtRequest) {
        await audioEngine.processPlanetBuffer(latest.orbitId, latest.id, speed, latest.pitchCents);
        latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
          ?.planets.find((item) => item.id === planetId);
        if (latest?.speedProcessRequestId !== requestId) return;
      }
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "speed", requestId,
        (item) => ({ ...clearSpeedProcessing(item), speed, speedProcessingError: undefined })
      ));
    } catch {
      const latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.speedProcessRequestId !== requestId) return;
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "speed", requestId,
        (item) => ({ ...clearSpeedProcessing(item), speedProcessingError: "Speed processing failed" })
      ));
      flash("Speed processing failed; the previous speed remains active.");
    }
  }

  function previewPlanetPitch(planetId: string, pendingPitchCents: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingPitchCents } : planet));
  }

  async function commitPlanetPitch(planetId: string, requestedPitch?: number) {
    const sceneId = stateRef.current.activeSceneId;
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const pitchCents = clamp(requestedPitch ?? planet.pendingPitchCents ?? planet.pitchCents, -4800, 4800);
    const speedAtRequest = planet.speed;
    if (planet.isPitchProcessing && planet.processingPitchCents === pitchCents) return;
    if (pitchCents === planet.pitchCents && !planet.isPitchProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingPitchCents: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = randomId();
    if (audioEngine.hasProcessedBuffer(planet.orbitId, planet.id, planet.speed, pitchCents)) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearPitchProcessing(item), pitchCents } : item));
      return;
    }
    setPlanets((current) => current.map((item) => item.id === planetId ? {
      ...item, pendingPitchCents: pitchCents, isPitchProcessing: true,
      processingPitchCents: pitchCents, pitchProcessRequestId: requestId
    } : item));
    try {
      await audioEngine.processPlanetBuffer(planet.orbitId, planet.id, speedAtRequest, pitchCents);
      let latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      if (latest.speed !== speedAtRequest) {
        await audioEngine.processPlanetBuffer(latest.orbitId, latest.id, latest.speed, pitchCents);
        latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
          ?.planets.find((item) => item.id === planetId);
        if (latest?.pitchProcessRequestId !== requestId) return;
      }
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "pitch", requestId,
        (item) => ({ ...clearPitchProcessing(item), pitchCents })
      ));
    } catch {
      const latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "pitch", requestId, clearPitchProcessing
      ));
      flash("Pitch processing failed; the previous pitch remains active.");
    }
  }

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
    } catch (error) {
      flash(error instanceof Error ? error.message : "Plugin state could not be captured; project was not saved.");
      return;
    }
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
          prepareActiveSceneTransition(project.activeSceneId, true);
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
          if (missing.length) flash(`Project loaded with missing audio: ${missing.join(", ")}`, 5000);
          else flash("Project loaded.");
          for (const scene of restoredScenes) for (const planet of scene.planets) {
            if (planet.speed !== 1 || planet.pitchCents) {
              void audioEngine.processPlanetBuffer(planet.orbitId, planet.id, planet.speed, planet.pitchCents);
            }
          }
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
    updateOrbit(orbitId, { mode });
    if (mode === "loop") {
      setBars((current) => current.map((bar) => bar.orbitId === orbitId ? { ...bar, kind: "play" } : bar));
    }
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

  // Keep one IPC subscription while routing every menu action to the latest render's handlers.
  actionsRef.current = {
    "open-project": openProject,
    "save-project": saveProject,
    "save-project-as": saveProjectAs,
    preferences: () => setIsPreferencesOpen(true)
  };

  useEffect(() => {
    const api = window.orbitonicAPI;
    if (!api) return;
    return api.onMenuAction((action) => {
      void actionsRef.current[action]();
    });
  }, []);

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
          setPlanets((current) => [...current, {
            id: planetId, orbitId, angle, speed: 1, volume: 1, audioPan: 0, pitchCents: 0, isActive: true,
            direction: 1, collisionSpeedMultiplier: 1,
            collisionFlashRemaining: 0
          }]);
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
          setPlanets((current) => current.map((planet) => {
            const changes = updates.get(planet.id);
            return changes ? { ...planet, ...changes } : planet;
          }));
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
            planet.direction === -1, getSampleStart(orbit), getSampleEnd(orbit)
          );
        }}
        onSequencePlay={(orbit, planet, bar, callback) => {
          if (!isCurrentPlaybackCallback(callback.sceneId, callback.epoch) || !canOrbitSound(orbit.id)) return;
          audioEngine.triggerSequence(
            orbit.id, planet.id, bar.id, planet.volume, planet.audioPan, 1, planet.pitchCents,
            planet.direction === -1, orbit.sequenceRetriggerMode,
            getSampleStart(orbit), getSampleEnd(orbit)
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
        pushParameterHistory();
        setOrbits((current) => current.map((orbit) => {
          if (orbit.id !== orbitId) return orbit;
          const window = normalizeSampleWindow(orbit.audioDuration, start, end);
          return { ...orbit, sampleStart: window.start, sampleEnd: window.end };
        }));
        // Restart the loop so it reseeks into the new window and playback follows the
        // sample as the handle drags (syncLoop also restarts on the window change).
        audioEngine.stopActiveLoopPlaybacksForOrbit(orbitId);
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
      onAddPlugin={() => {
        if (!selectedOrbit) return;
        const entry = WAM_CATALOG["burns-simple-delay"];
        changeOrbitPlugins(selectedOrbit.id, (plugins) => [...plugins, {
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
        setPlanets((current) => current.map((planet) =>
          planet.id === planetId ? { ...planet, direction: reverse ? -1 : 1 } : planet));
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
