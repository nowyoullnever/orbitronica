import { useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "./audio/audioEngine";
import { CanvasStage } from "./components/CanvasStage";
import { ContextMenu } from "./components/ContextMenu";
import { OrbitSettingsPanel } from "./components/OrbitSettingsPanel";
import { Toolbar } from "./components/Toolbar";
import { TransportControls } from "./components/TransportControls";
import { parseProject, serializeProject } from "./project/projectSerializer";
import type {
  ContextMenuState, HistorySnapshot, Orbit, OrbitMode, Planet, Selection,
  SequenceRetriggerMode, Tool, TriggerBar, ViewportState
} from "./state/types";
import {
  TAU, getOrbitTapeRate, getTapeStyleRuntimeRateOnly, isFullLoopBar, normalizeAngle, orbitAngleAtPoint,
  rateToCents, spliceBarSpecs
} from "./utils/geometry";

const id = () => crypto.randomUUID();
const MAX_HISTORY = 100;
const DEFAULT_LOOP_BAR_LENGTH_RADIANS = Math.PI / 12;
const SEQUENCE_BAR_LENGTH_RADIANS = .04;
const MIN_BAR_LENGTH_RADIANS = .01;
const MIN_DIRECT_RATE = .05;
const MAX_DIRECT_RATE = 8;
const MIN_DIRECT_ORBIT_RADIUS = 40;
const MAX_DIRECT_ORBIT_RADIUS = 1000;
const SPLICE_MAX_PIECES = 32;
const ORBIT_COLORS = ["#5b625d", "#a65f54", "#4f759b", "#7a6995", "#6e8b62", "#b17b45"];
const emptySelection: Selection = { orbitId: null, planetId: null, barId: null };
const defaultViewport: ViewportState = { zoom: 1, offsetX: 0, offsetY: 0 };
const supportedAudio = (file: File) => /\.(wav|mp3|ogg)$/i.test(file.name) ||
  ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg"].includes(file.type);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// Splice counts are signed even integers; magnitudes below 2 mean "no splice".
const clampSpliceCount = (count: number) => {
  const even = clamp(Math.round(count / 2) * 2, -SPLICE_MAX_PIECES, SPLICE_MAX_PIECES);
  return Math.abs(even) < 2 ? 0 : even;
};

type CopiedPlanetData = Pick<Planet, "speed" | "volume" | "pitchCents" | "direction" | "isActive">;
type AppClipboard = {
  type: "planet";
  sourceOrbitId: string;
  data: CopiedPlanetData;
} | null;

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
  const [orbits, setOrbits] = useState<Orbit[]>([]);
  const [planets, setPlanets] = useState<Planet[]>([]);
  const [bars, setBars] = useState<TriggerBar[]>([]);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [selectedTool, setSelectedTool] = useState<Tool>("select");
  const [isPlaying, setIsPlaying] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lastLoopBarLengthRadians, setLastLoopBarLengthRadians] = useState(DEFAULT_LOOP_BAR_LENGTH_RADIANS);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled Session");
  const [projectPath, setProjectPath] = useState<string>();
  const [isDirty, setIsDirty] = useState(false);
  const [cancelSignal, setCancelSignal] = useState(0);
  const [clipboard, setClipboard] = useState<AppClipboard>(null);
  const [viewport, setViewport] = useState<ViewportState>(defaultViewport);
  const uploadPoint = useRef({ x: 450, y: 350 });
  const fileInput = useRef<HTMLInputElement>(null);
  const undoStack = useRef<HistorySnapshot[]>([]);
  const redoStack = useRef<HistorySnapshot[]>([]);
  const parameterHistoryTimer = useRef<number>();
  const clipboardRef = useRef<AppClipboard>(null);
  const stateRef = useRef({ orbits, planets, bars, selection, lastLoopBarLengthRadians });
  stateRef.current = { orbits, planets, bars, selection, lastLoopBarLengthRadians };
  clipboardRef.current = clipboard;

  const selectedOrbit = useMemo(
    () => orbits.find((orbit) => orbit.id === selection.orbitId) ?? null,
    [orbits, selection.orbitId]
  );

  function snapshot(): HistorySnapshot {
    const state = stateRef.current;
    return {
      orbits: state.orbits.map((item) => ({ ...item })),
      planets: state.planets.map(cleanPlanet),
      bars: state.bars.map((item) => ({ ...item })),
      selection: { ...state.selection }
    };
  }

  function pushHistory() {
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setIsDirty(true);
  }

  function pushParameterHistory() {
    if (parameterHistoryTimer.current === undefined) pushHistory();
    window.clearTimeout(parameterHistoryTimer.current);
    parameterHistoryTimer.current = window.setTimeout(() => {
      parameterHistoryTimer.current = undefined;
    }, 350);
  }

  function restoreSnapshot(next: HistorySnapshot) {
    const currentIds = new Set(stateRef.current.orbits.map((orbit) => orbit.id));
    const nextIds = new Set(next.orbits.map((orbit) => orbit.id));
    const currentPlanetIds = new Set(stateRef.current.planets.map((planet) => planet.id));
    const nextPlanetIds = new Set(next.planets.map((planet) => planet.id));
    for (const orbitId of currentIds) if (!nextIds.has(orbitId)) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    for (const planetId of currentPlanetIds) {
      if (!nextPlanetIds.has(planetId)) audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    }
    setOrbits(next.orbits);
    setPlanets(next.planets);
    setBars(next.bars);
    setSelection(next.selection);
    for (const orbit of next.orbits) {
      audioEngine.setVolume(orbit.id, orbit.volume);
      if (orbit.isPaused || orbit.isMuted) audioEngine.stopAllActivePlaybacksForOrbit(orbit.id);
    }
  }

  function undo() {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(snapshot());
    restoreSnapshot(previous);
    setIsDirty(true);
    flash("Undone.");
  }

  function redo() {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(snapshot());
    restoreSnapshot(next);
    setIsDirty(true);
    flash("Redone.");
  }

  function flash(text: string, duration = 1800) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), duration);
  }

  function canOrbitSound(orbitId: string) {
    const state = stateRef.current;
    const orbit = state.orbits.find((item) => item.id === orbitId);
    if (!orbit || orbit.isPaused || orbit.isMuted || orbit.isMissingAudio) return false;
    const hasSolo = state.orbits.some((item) => item.isSolo);
    return !hasSolo || orbit.isSolo;
  }

  function deletePlanet(planetId: string) {
    pushHistory();
    audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    setPlanets((current) => current.filter((planet) => planet.id !== planetId));
    setSelection((current) => current.planetId === planetId ? { ...current, planetId: null } : current);
  }

  function deleteSelection() {
    const state = stateRef.current;
    if (state.selection.barId) {
      pushHistory();
      audioEngine.stopAllActivePlaybacksForBar(state.selection.barId);
      setBars((current) => current.filter((bar) => bar.id !== state.selection.barId));
      setSelection({ ...state.selection, barId: null });
    } else if (state.selection.planetId) {
      deletePlanet(state.selection.planetId);
    } else if (state.selection.orbitId) {
      const orbitId = state.selection.orbitId;
      pushHistory();
      audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
      setOrbits((current) => current.filter((orbit) => orbit.id !== orbitId));
      setPlanets((current) => current.filter((planet) => planet.orbitId !== orbitId));
      setBars((current) => current.filter((bar) => bar.orbitId !== orbitId));
      setSelection(emptySelection);
    }
  }

  // Rebuild an orbit's splice bars from a signed even count and start angle. Manual bars
  // are left untouched; only bars tagged source "splice" are replaced. History is pushed by
  // the caller (canvas drag start or the settings panel) so a whole gesture is one undo step.
  function regenerateSpliceBars(orbitId: string, count: number, startAngle: number) {
    // Old splice bars get fresh ids, so silence any loop still keyed to them first.
    for (const bar of stateRef.current.bars) {
      if (bar.orbitId === orbitId && bar.source === "splice") audioEngine.stopAllActivePlaybacksForBar(bar.id);
    }
    setBars((current) => {
      const kept = current.filter((bar) => !(bar.orbitId === orbitId && bar.source === "splice"));
      const generated: TriggerBar[] = spliceBarSpecs(count, startAngle).map((spec) => ({
        id: id(), orbitId, angle: spec.angle, lengthRadians: spec.lengthRadians,
        startAngle: spec.startAngle, kind: "play", source: "splice"
      }));
      return [...kept, ...generated];
    });
  }

  function setOrbitSpliceCount(orbitId: string, rawCount: number) {
    const count = clampSpliceCount(rawCount);
    const startAngle = stateRef.current.orbits.find((orbit) => orbit.id === orbitId)?.spliceStartAngle ?? 0;
    setOrbits((current) => current.map((orbit) =>
      orbit.id === orbitId ? { ...orbit, spliceCount: count } : orbit));
    regenerateSpliceBars(orbitId, count, startAngle);
  }

  function setOrbitSpliceStart(orbitId: string, rawAngle: number) {
    const orbit = stateRef.current.orbits.find((item) => item.id === orbitId);
    if (!orbit) return;
    const startAngle = normalizeAngle(rawAngle);
    setOrbits((current) => current.map((item) =>
      item.id === orbitId ? { ...item, spliceStartAngle: startAngle } : item));
    regenerateSpliceBars(orbitId, clampSpliceCount(orbit.spliceCount ?? 0), startAngle);
  }

  function duplicateOrbit(orbitId = stateRef.current.selection.orbitId) {
    if (!orbitId) return;
    const source = stateRef.current.orbits.find((orbit) => orbit.id === orbitId);
    if (!source) return;
    pushHistory();
    const newOrbitId = id();
    if (!audioEngine.duplicateOrbitAudio(source.id, newOrbitId, source.volume)) {
      flash("The orbit audio is unavailable.");
      return;
    }
    const duplicate: Orbit = {
      ...source, id: newOrbitId, name: `${source.name} Copy`, x: source.x + 40, y: source.y + 40,
      isMuted: false, isSolo: false
    };
    const planetIdMap = new Map<string, string>();
    const copiedPlanets = stateRef.current.planets.filter((planet) => planet.orbitId === source.id).map((planet) => {
      const newId = id();
      planetIdMap.set(planet.id, newId);
      return {
        ...cleanPlanet(planet), id: newId, orbitId: newOrbitId,
        collisionSpeedMultiplier: 1, collisionCooldownRemaining: 0, collisionFlashRemaining: 0
      };
    });
    const copiedBars = stateRef.current.bars.filter((bar) => bar.orbitId === source.id)
      .map((bar) => ({ ...bar, id: id(), orbitId: newOrbitId }));
    setOrbits((current) => [...current, duplicate]);
    setPlanets((current) => [...current, ...copiedPlanets]);
    setBars((current) => [...current, ...copiedBars]);
    setSelection({ orbitId: newOrbitId, planetId: null, barId: null });
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
    const planetId = id();
    const newPlanet: Planet = {
      id: planetId,
      orbitId: targetId,
      angle: requestedAngle ?? findAvailablePlanetAngle(targetId),
      speed: copied.speed,
      volume: copied.volume,
      pitchCents: copied.pitchCents,
      direction: copied.direction,
      isActive: copied.isActive,
      collisionSpeedMultiplier: 1,
      collisionCooldownRemaining: 0,
      collisionFlashRemaining: 0
    };
    pushHistory();
    setPlanets((current) => [...current, newPlanet]);
    setSelection({ orbitId: targetId, planetId, barId: null });
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
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const speed = requestedSpeed ?? planet.pendingSpeed ?? planet.speed;
    const pitchAtRequest = planet.pitchCents;
    if (planet.isSpeedProcessing && planet.processingSpeed === speed) return;
    if (Math.abs(speed - planet.speed) < .0001 && !planet.isSpeedProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingSpeed: undefined, speedProcessingError: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = id();
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
      let latest = stateRef.current.planets.find((item) => item.id === planetId);
      if (latest?.speedProcessRequestId !== requestId) return;
      if (latest.pitchCents !== pitchAtRequest) {
        await audioEngine.processPlanetBuffer(latest.orbitId, latest.id, speed, latest.pitchCents);
        latest = stateRef.current.planets.find((item) => item.id === planetId);
        if (latest?.speedProcessRequestId !== requestId) return;
      }
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearSpeedProcessing(item), speed, speedProcessingError: undefined } : item));
    } catch {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearSpeedProcessing(item), speedProcessingError: "Speed processing failed" } : item));
      flash("Speed processing failed; the previous speed remains active.");
    }
  }

  function previewPlanetPitch(planetId: string, pendingPitchCents: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingPitchCents } : planet));
  }

  async function commitPlanetPitch(planetId: string, requestedPitch?: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const pitchCents = requestedPitch ?? planet.pendingPitchCents ?? planet.pitchCents;
    const speedAtRequest = planet.speed;
    if (planet.isPitchProcessing && planet.processingPitchCents === pitchCents) return;
    if (pitchCents === planet.pitchCents && !planet.isPitchProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingPitchCents: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = id();
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
      let latest = stateRef.current.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      if (latest.speed !== speedAtRequest) {
        await audioEngine.processPlanetBuffer(latest.orbitId, latest.id, latest.speed, pitchCents);
        latest = stateRef.current.planets.find((item) => item.id === planetId);
        if (latest?.pitchProcessRequestId !== requestId) return;
      }
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearPitchProcessing(item), pitchCents } : item));
    } catch {
      setPlanets((current) => current.map((item) => item.id === planetId ? clearPitchProcessing(item) : item));
      flash("Pitch processing failed; the previous pitch remains active.");
    }
  }

  async function createOrbitFromAudio(file: File, point: { x: number; y: number }, offset = 0) {
    if (!supportedAudio(file)) return flash("Please choose a WAV, MP3, or OGG audio file.");
    const orbitId = id();
    try {
      await audioEngine.resume();
      const buffer = await audioEngine.decodeFile(orbitId, file);
      pushHistory();
      const radiusX = 145, radiusY = 90;
      const name = file.name.replace(/\.[^.]+$/, "");
      const orbit: Orbit = {
        id: orbitId, name, audioName: file.name, audioDuration: buffer.duration,
        x: Math.max(180, point.x + offset * 24), y: Math.max(150, point.y + offset * 20),
        radiusX, radiusY, initialRadiusX: radiusX, initialRadiusY: radiusY,
        mode: "loop", volume: 1, isPaused: false, isMuted: false, isSolo: false,
        color: ORBIT_COLORS[orbits.length % ORBIT_COLORS.length], sequenceRetriggerMode: "overlap"
      };
      setOrbits((current) => [...current, orbit]);
      setSelection({ orbitId, planetId: null, barId: null });
      flash(`${file.name} — ${buffer.duration.toFixed(1)}s timeline created.`);
    } catch {
      audioEngine.removeOrbit(orbitId);
      flash("That audio file could not be decoded.");
    }
  }

  async function handleFiles(files: File[], point: { x: number; y: number }) {
    const audioFiles = files.filter(supportedAudio);
    if (!audioFiles.length) return flash("Drop WAV, MP3, or OGG audio files.");
    for (let index = 0; index < audioFiles.length; index++) await createOrbitFromAudio(audioFiles[index], point, index);
  }

  async function saveProject() {
    if (!window.orbitonicAPI) return flash("Project saving is only available in the desktop app.");
    const project = serializeProject(
      projectName || "Untitled Session", orbits, planets, bars, lastLoopBarLengthRadians, selection
    );
    const assets = orbits.flatMap((orbit) => {
      const asset = audioEngine.getProjectAsset(orbit.id);
      return asset ? [{ orbitId: orbit.id, fileName: asset.fileName, bytes: asset.bytes }] : [];
    });
    const result = await window.orbitonicAPI.saveProject({ project, assets }, projectPath);
    if (result.ok) {
      setProjectPath(result.path);
      setIsDirty(false);
      flash("Project saved.");
    } else if (!result.canceled) flash(result.error ?? "Project could not be saved.");
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
      audioEngine.stopAllActivePlaybacks();
      for (const orbit of stateRef.current.orbits) audioEngine.removeOrbit(orbit.id);
      const project = parseProject(result.text);
      const assetMap = new Map((result.assets ?? []).map((asset) => [asset.orbitId, asset]));
      const restoredOrbits: Orbit[] = [];
      const missing: string[] = [];
      for (const raw of project.orbits) {
        const orbit: Orbit = {
          ...raw,
          name: raw.name ?? raw.audioName.replace(/\.[^.]+$/, ""),
          color: raw.color ?? "#5b625d",
          isMuted: raw.isMuted ?? false,
          isSolo: raw.isSolo ?? false,
          sequenceRetriggerMode: raw.sequenceRetriggerMode ?? "overlap"
        };
        const asset = assetMap.get(orbit.id);
        if (asset?.bytes) {
          const buffer = await audioEngine.decodeBytes(orbit.id, orbit.audioName, asset.bytes, orbit.volume);
          orbit.audioDuration = buffer.duration;
          orbit.isMissingAudio = false;
        } else {
          orbit.isMissingAudio = true;
          missing.push(asset?.error ?? orbit.audioPath ?? orbit.audioName);
        }
        restoredOrbits.push(orbit);
      }
      const restoredPlanets = project.planets.map((planet) => ({
        ...cleanPlanet(planet),
        speed: planet.speed ?? 1,
        volume: planet.volume ?? 1,
        pitchCents: planet.pitchCents ?? 0,
        direction: planet.direction ?? 1,
        collisionSpeedMultiplier: planet.collisionSpeedMultiplier ?? 1,
        collisionCooldownRemaining: 0,
        collisionFlashRemaining: 0
      }));
      setOrbits(restoredOrbits);
      setPlanets(restoredPlanets);
      setBars(project.bars);
      setSelection(project.ui ?? emptySelection);
      setLastLoopBarLengthRadians(project.lastLoopBarLengthRadians);
      setProjectName(project.projectName);
      setProjectPath(result.path);
      setIsPlaying(false);
      setViewport(defaultViewport);
      setIsDirty(false);
      undoStack.current = [];
      redoStack.current = [];
      if (missing.length) flash(`Project loaded with missing audio: ${missing.join(", ")}`, 5000);
      else flash("Project loaded.");
      for (const planet of restoredPlanets) {
        if (planet.speed !== 1 || planet.pitchCents) {
          void audioEngine.processPlanetBuffer(planet.orbitId, planet.id, planet.speed, planet.pitchCents);
        }
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : "Project could not be loaded.");
    }
  }

  async function toggleRecording() {
    try {
      if (!isRecording) {
        await audioEngine.resume();
        audioEngine.startRecording();
        setIsRecording(true);
        flash("Recording started.");
      } else {
        const blob = await audioEngine.stopRecording();
        setIsRecording(false);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const result = await window.orbitonicAPI?.saveRecording(bytes, `recording_${stamp}.webm`);
        if (result?.ok) flash("Recording saved.");
        else if (!result?.canceled) flash(result?.error ?? "Recording could not be saved.");
      }
    } catch (error) {
      setIsRecording(false);
      flash(error instanceof Error ? error.message : "Recording failed.");
    }
  }

  function updateOrbit(orbitId: string, changes: Partial<Orbit>) {
    pushHistory();
    setOrbits((current) => current.map((orbit) => orbit.id === orbitId ? { ...orbit, ...changes } : orbit));
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
    const nextPlanet = { ...planet, collisionSpeedMultiplier, collisionCooldownRemaining: 0 };
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
      id: id(), orbitId: orbit.id, angle, lengthRadians: SEQUENCE_BAR_LENGTH_RADIANS,
      startAngle: ((angle - SEQUENCE_BAR_LENGTH_RADIANS / 2) % TAU + TAU) % TAU, kind
    };
    setBars((current) => [...current, bar]);
    setSelection({ orbitId: orbit.id, planetId: null, barId: bar.id });
    setMenu(null);
  }

  useEffect(() => {
    const resume = () => void audioEngine.resume();
    window.addEventListener("pointerdown", resume, { once: true });
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.matches("input, select, textarea") || target.isContentEditable);
      if (typing && event.key !== "Escape") return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if (command && key === "z" && event.shiftKey) { event.preventDefault(); redo(); }
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
      else if (command && key === "s") { event.preventDefault(); void saveProject(); }
      else if (command && key === "o") { event.preventDefault(); void openProject(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); }
      else if (key === "s") setSelectedTool("select");
      else if (key === "p") setSelectedTool("planet");
      else if (key === "b") setSelectedTool("bar");
      else if (key === "r") void toggleRecording();
      else if (event.code === "Space") {
        event.preventDefault();
        if (isPlaying) { audioEngine.stopAllActivePlaybacks(); setIsPlaying(false); }
        else { void audioEngine.resume(); setIsPlaying(true); }
      } else if (event.key === "Escape") {
        setMenu(null); setSelection(emptySelection); setCancelSignal((value) => value + 1);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  return <main className="app" onClick={() => setMenu(null)}>
    <header className="topline">
      <span>ORBITONIC</span><small>{projectName.toUpperCase()} {isDirty ? "•" : ""}</small>
      <i className={isPlaying ? "live" : ""}>{isRecording ? "RECORDING" : isPlaying ? "RUNNING" : "PAUSED"}</i>
    </header>
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
        orbits={orbits} planets={planets} bars={bars} selection={selection}
        selectedTool={selectedTool} isPlaying={isPlaying} isDragOver={isDragOver}
        cancelSignal={cancelSignal} viewport={viewport} onViewportChange={setViewport}
        onSelect={setSelection} onBeginMutation={pushHistory}
        onAddPlanet={(orbitId, angle) => {
          pushHistory();
          const planetId = id();
          setPlanets((current) => [...current, {
            id: planetId, orbitId, angle, speed: 1, volume: 1, pitchCents: 0, isActive: true,
            direction: 1, collisionSpeedMultiplier: 1, collisionCooldownRemaining: 0,
            collisionFlashRemaining: 0
          }]);
          setSelection({ orbitId, planetId, barId: null });
        }}
        onAddBar={(orbitId, angle) => {
          pushHistory();
          const orbit = orbits.find((item) => item.id === orbitId);
          const remembered = lastLoopBarLengthRadians >= TAU ? DEFAULT_LOOP_BAR_LENGTH_RADIANS : lastLoopBarLengthRadians;
          const length = orbit?.mode === "sequence" ? SEQUENCE_BAR_LENGTH_RADIANS :
            Math.min(TAU, Math.max(MIN_BAR_LENGTH_RADIANS, remembered));
          const bar: TriggerBar = {
            id: id(), orbitId, angle, lengthRadians: length,
            startAngle: ((angle - length / 2) % TAU + TAU) % TAU, kind: "play"
          };
          setBars((current) => [...current, bar]);
          setSelection({ orbitId, planetId: null, barId: bar.id });
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
        onLoopFrame={(orbit, planet, bar, inside, angle) => {
          audioEngine.syncLoop(
            orbit.id, planet.id, bar.id, inside && canOrbitSound(orbit.id),
            angle / TAU * orbit.audioDuration, planet.volume,
            getTapeStyleRuntimeRateOnly(orbit, planet), planet.speed, planet.pitchCents, planet.direction === -1
          );
        }}
        onSequencePlay={(orbit, planet, bar) => {
          if (!canOrbitSound(orbit.id)) return;
          audioEngine.triggerSequence(
            orbit.id, planet.id, bar.id, planet.volume, 1, planet.pitchCents,
            planet.direction === -1, orbit.sequenceRetriggerMode
          );
        }}
        onSequenceStop={(orbitId) => audioEngine.stopActiveSequencePlaybacksForOrbit(orbitId)}
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
          current.map((bar) => bar.id === barId ? { ...bar, angle, lengthRadians, startAngle } : bar))}
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
      onPause={() => selectedOrbit && toggleOrbitPause(selectedOrbit.id)}
      onMute={(muted) => selectedOrbit && setOrbitMute(selectedOrbit.id, muted)}
      onSolo={(solo) => selectedOrbit && setOrbitSolo(selectedOrbit.id, solo)}
      onRetriggerMode={(sequenceRetriggerMode: SequenceRetriggerMode) =>
        selectedOrbit && updateOrbit(selectedOrbit.id, { sequenceRetriggerMode })}
      onDuplicate={() => selectedOrbit && duplicateOrbit(selectedOrbit.id)}
      onDeleteOrbit={deleteSelection}
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
    {message && <div className="toast">{message}</div>}
    <footer>S/P/B TOOLS · SPACE TRANSPORT · CTRL+S SAVE · R RECORD</footer>
  </main>;
}
