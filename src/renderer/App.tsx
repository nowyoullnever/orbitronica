import { useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "./audio/audioEngine";
import { CanvasStage } from "./components/CanvasStage";
import { ContextMenu } from "./components/ContextMenu";
import { OrbitSettingsPanel } from "./components/OrbitSettingsPanel";
import { Toolbar } from "./components/Toolbar";
import { TransportControls } from "./components/TransportControls";
import type {
  ContextMenuState, HistorySnapshot, Orbit, OrbitMode, Planet, Selection, Tool, TriggerBar
} from "./state/types";
import {
  TAU, getSpeedBasedPlaybackRate, isFullLoopBar, orbitAngleAtPoint
} from "./utils/geometry";

const id = () => crypto.randomUUID();
const MAX_HISTORY = 100;
const DEFAULT_LOOP_BAR_LENGTH_RADIANS = Math.PI / 12;
const SEQUENCE_BAR_LENGTH_RADIANS = .04;
const MIN_BAR_LENGTH_RADIANS = .01;
const emptySelection: Selection = { orbitId: null, planetId: null, barId: null };
const supportedAudio = (file: File) => /\.(wav|mp3|ogg)$/i.test(file.name) ||
  ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg"].includes(file.type);

export default function App() {
  const [orbits, setOrbits] = useState<Orbit[]>([]);
  const [planets, setPlanets] = useState<Planet[]>([]);
  const [bars, setBars] = useState<TriggerBar[]>([]);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [selectedTool, setSelectedTool] = useState<Tool>("select");
  const [isPlaying, setIsPlaying] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lastLoopBarLengthRadians, setLastLoopBarLengthRadians] = useState(
    DEFAULT_LOOP_BAR_LENGTH_RADIANS
  );
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const uploadPoint = useRef({ x: 450, y: 350 });
  const fileInput = useRef<HTMLInputElement>(null);
  const history = useRef<HistorySnapshot[]>([]);
  const stateRef = useRef({ orbits, planets, bars, selection });
  stateRef.current = { orbits, planets, bars, selection };

  const selectedOrbit = useMemo(
    () => orbits.find((orbit) => orbit.id === selection.orbitId) ?? null,
    [orbits, selection.orbitId]
  );

  function snapshot(): HistorySnapshot {
    const state = stateRef.current;
    return {
      orbits: state.orbits.map((item) => ({ ...item })),
      planets: state.planets.map((item) => ({
        ...item,
        pendingPitchCents: undefined,
        isPitchProcessing: false,
        processingPitchCents: undefined,
        pitchProcessRequestId: undefined
      })),
      bars: state.bars.map((item) => ({ ...item })),
      selection: { ...state.selection }
    };
  }

  function pushHistory() {
    history.current.push(snapshot());
    if (history.current.length > MAX_HISTORY) history.current.shift();
  }

  function undo() {
    const previous = history.current.pop();
    if (!previous) return;
    const currentIds = new Set(stateRef.current.orbits.map((orbit) => orbit.id));
    const restoredIds = new Set(previous.orbits.map((orbit) => orbit.id));
    for (const orbitId of currentIds) if (!restoredIds.has(orbitId)) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    setOrbits(previous.orbits);
    setPlanets(previous.planets);
    setBars(previous.bars);
    setSelection(previous.selection);
    for (const orbit of previous.orbits) audioEngine.setVolume(orbit.id, orbit.volume);
    for (const orbit of previous.orbits) {
      if (orbit.isPaused) audioEngine.stopAllActivePlaybacksForOrbit(orbit.id);
    }
    setMessage("Undone.");
    window.setTimeout(() => setMessage(null), 1200);
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

  function deletePlanet(planetId: string) {
    pushHistory();
    audioEngine.stopAllActivePlaybacksForPlanet(planetId);
    setPlanets((current) => current.filter((planet) => planet.id !== planetId));
    setSelection((current) => current.planetId === planetId ? { ...current, planetId: null } : current);
  }

  function previewPlanetPitch(planetId: string, pendingPitchCents: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingPitchCents } : planet));
  }

  async function commitPlanetPitch(planetId: string, requestedPitch?: number) {
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const pitchCents = requestedPitch ?? planet.pendingPitchCents ?? planet.pitchCents;
    if (planet.isPitchProcessing && planet.processingPitchCents === pitchCents) return;
    if (pitchCents === planet.pitchCents && !planet.isPitchProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingPitchCents: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = id();
    const cached = audioEngine.hasPitchBuffer(planet.orbitId, planet.id, pitchCents);
    if (cached) {
      setPlanets((current) => current.map((item) => item.id === planetId ? {
        ...item,
        pitchCents,
        pendingPitchCents: undefined,
        isPitchProcessing: false,
        processingPitchCents: undefined,
        pitchProcessRequestId: undefined
      } : item));
      return;
    }
    setPlanets((current) => current.map((item) => item.id === planetId ? {
      ...item,
      pendingPitchCents: pitchCents,
      isPitchProcessing: true,
      processingPitchCents: pitchCents,
      pitchProcessRequestId: requestId
    } : item));
    try {
      await audioEngine.processPitchBuffer(planet.orbitId, planet.id, pitchCents);
      const latest = stateRef.current.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      setPlanets((current) => current.map((item) => item.id === planetId ? {
        ...item,
        pitchCents,
        pendingPitchCents: undefined,
        isPitchProcessing: false,
        processingPitchCents: undefined,
        pitchProcessRequestId: undefined
      } : item));
    } catch (error) {
      console.error(error);
      setPlanets((current) => current.map((item) => item.id === planetId ? {
        ...item,
        isPitchProcessing: false,
        processingPitchCents: undefined,
        pitchProcessRequestId: undefined
      } : item));
      setMessage("Pitch processing failed; the previous pitch remains active.");
    }
  }

  useEffect(() => {
    const dismiss = () => setMenu(null);
    const resume = () => void audioEngine.resume();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, select, textarea") || target.isContentEditable) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key.toLowerCase() === "s") {
        setSelectedTool("select");
      }
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", keydown);
    };
  }, []);

  async function createOrbitFromAudio(file: File, point: { x: number; y: number }, offset = 0) {
    if (!supportedAudio(file)) {
      setMessage("Please choose a WAV, MP3, or OGG audio file.");
      return;
    }
    const orbitId = id();
    try {
      await audioEngine.resume();
      const buffer = await audioEngine.decodeFile(orbitId, file);
      pushHistory();
      const radiusX = 145;
      const radiusY = 90;
      const orbit: Orbit = {
        id: orbitId,
        audioName: file.name,
        audioDuration: buffer.duration,
        x: Math.max(180, point.x + offset * 24),
        y: Math.max(150, point.y + offset * 20),
        radiusX, radiusY,
        initialRadiusX: radiusX,
        initialRadiusY: radiusY,
        mode: "loop",
        volume: 1,
        isPaused: false
      };
      setOrbits((current) => [...current, orbit]);
      setSelection({ orbitId, planetId: null, barId: null });
      setMessage(`${file.name} — ${buffer.duration.toFixed(1)}s timeline created.`);
      window.setTimeout(() => setMessage(null), 2400);
    } catch (error) {
      console.error(error);
      audioEngine.removeOrbit(orbitId);
      setMessage("That audio file could not be decoded.");
    }
  }

  async function handleFiles(files: File[], point: { x: number; y: number }) {
    const audioFiles = files.filter(supportedAudio);
    if (!audioFiles.length) {
      setMessage("Drop WAV, MP3, or OGG audio files.");
      return;
    }
    for (let index = 0; index < audioFiles.length; index++) {
      await createOrbitFromAudio(audioFiles[index], point, index);
    }
  }

  function updateSelectedOrbit(changes: Partial<Orbit>, addHistory = true) {
    if (!selection.orbitId) return;
    if (addHistory) pushHistory();
    setOrbits((current) => current.map((orbit) => orbit.id === selection.orbitId ? { ...orbit, ...changes } : orbit));
  }

  function setOrbitMode(orbitId: string, mode: OrbitMode) {
    pushHistory();
    audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
    setOrbits((current) => current.map((item) => item.id === orbitId ? { ...item, mode } : item));
    if (mode === "loop") {
      setBars((current) => current.map((bar) => bar.orbitId === orbitId ? { ...bar, kind: "play" } : bar));
    }
  }

  function toggleMenuMode() {
    const orbit = orbits.find((item) => item.id === menu?.orbitId);
    if (orbit) {
      setOrbitMode(orbit.id, orbit.mode === "loop" ? "sequence" : "loop");
    }
    setMenu(null);
  }

  function toggleOrbitPause() {
    const orbitId = menu?.orbitId;
    if (orbitId) {
      pushHistory();
      const orbit = orbits.find((item) => item.id === orbitId);
      if (orbit && !orbit.isPaused) audioEngine.stopAllActivePlaybacksForOrbit(orbitId);
      setOrbits((current) => current.map((item) => item.id === orbitId ? { ...item, isPaused: !item.isPaused } : item));
    }
    setMenu(null);
  }

  function addContextBar(kind: "play" | "stop") {
    const orbit = orbits.find((item) => item.id === menu?.orbitId);
    if (!orbit || !menu) return;
    pushHistory();
    const barId = id();
    const angle = orbitAngleAtPoint(orbit, menu.canvasX, menu.canvasY);
    setBars((current) => [...current, {
      id: barId,
      orbitId: orbit.id,
      angle,
      lengthRadians: SEQUENCE_BAR_LENGTH_RADIANS,
      startAngle: ((angle - SEQUENCE_BAR_LENGTH_RADIANS / 2) % TAU + TAU) % TAU,
      kind
    }]);
    setSelection({ orbitId: orbit.id, planetId: null, barId });
    setMenu(null);
  }

  return (
    <main className="app" onClick={() => setMenu(null)}>
      <header className="topline">
        <span>ORBITONIC</span>
        <small>LIVE SAMPLE INSTRUMENT / MVP</small>
        <i className={isPlaying ? "live" : ""}>{isPlaying ? "RUNNING" : "PAUSED"}</i>
      </header>
      <Toolbar selected={selectedTool} onSelect={setSelectedTool} />
      <section className={`canvas-shell ${isDragOver ? "receiving" : ""}`}>
        {orbits.length === 0 && (
          <div className="welcome">
            <div className="welcome-orbit"><i /></div>
            <h1>{isDragOver ? "Drop to make an orbit." : "Make sound move."}</h1>
            <p>Drop a sound here or right-click to upload,<br />then place planets and time regions on its orbit.</p>
            <button onClick={(event) => {
              event.stopPropagation();
              uploadPoint.current = { x: 520, y: 380 };
              fileInput.current?.click();
            }}>Upload your first sound</button>
          </div>
        )}
        <CanvasStage
          orbits={orbits} planets={planets} bars={bars}
          selection={selection} selectedTool={selectedTool}
          isPlaying={isPlaying} isDragOver={isDragOver}
          onSelect={setSelection}
          onBeginMutation={pushHistory}
          onAddPlanet={(orbitId, angle) => {
            pushHistory();
            const planetId = id();
            setPlanets((current) => [...current, {
              id: planetId,
              orbitId,
              angle,
              speed: 1,
              volume: 1,
              pitchCents: 0,
              isActive: true
            }]);
            setSelection({ orbitId, planetId, barId: null });
          }}
          onAddBar={(orbitId, angle) => {
            pushHistory();
            const barId = id();
            const orbit = orbits.find((item) => item.id === orbitId);
            const remembered = lastLoopBarLengthRadians >= TAU
              ? DEFAULT_LOOP_BAR_LENGTH_RADIANS
              : lastLoopBarLengthRadians;
            setBars((current) => [...current, {
              id: barId,
              orbitId,
              angle,
              lengthRadians: orbit?.mode === "sequence"
                ? SEQUENCE_BAR_LENGTH_RADIANS
                : Math.min(TAU, Math.max(MIN_BAR_LENGTH_RADIANS, remembered)),
              startAngle: ((angle - (orbit?.mode === "sequence"
                ? SEQUENCE_BAR_LENGTH_RADIANS
                : Math.min(TAU, Math.max(MIN_BAR_LENGTH_RADIANS, remembered))) / 2) % TAU + TAU) % TAU,
              kind: "play"
            }]);
            setSelection({ orbitId, planetId: null, barId });
          }}
          onMovePlanets={(updates) => setPlanets((current) => current.map((planet) => {
            const angle = updates.get(planet.id);
            return angle === undefined ? planet : { ...planet, angle };
          }))}
          onLoopFrame={(orbit, planet, bar, inside, angle) => {
            audioEngine.syncLoop(
              orbit.id, planet.id, bar.id, inside,
              angle / TAU * orbit.audioDuration,
              planet.volume,
              getSpeedBasedPlaybackRate(orbit, planet),
              planet.pitchCents
            );
          }}
          onSequencePlay={(orbit, planet, bar) =>
            audioEngine.triggerSequence(
              orbit.id, planet.id, bar.id, planet.volume,
              getSpeedBasedPlaybackRate(orbit, planet), planet.pitchCents
            )}
          onSequenceStop={(orbitId) => audioEngine.stopAllActivePlaybacksForOrbit(orbitId)}
          onResizeOrbit={(orbitId, radiusX, radiusY) => setOrbits((current) => current.map((orbit) => {
            if (orbit.id !== orbitId) return orbit;
            const resized = { ...orbit, radiusX, radiusY };
            for (const planet of stateRef.current.planets.filter((item) => item.orbitId === orbitId)) {
              audioEngine.setActivePlanetPlaybackRate(planet.id, getSpeedBasedPlaybackRate(resized, planet));
            }
            return resized;
          }))}
          onMoveOrbit={(orbitId, x, y) => setOrbits((current) => current.map((orbit) =>
            orbit.id === orbitId ? { ...orbit, x, y } : orbit))}
          onEditBar={(barId, angle, lengthRadians, startAngle) => setBars((current) => current.map((bar) =>
            bar.id === barId ? { ...bar, angle, lengthRadians, startAngle } : bar))}
          onBarLengthEditEnd={(barId, lengthRadians) => {
            const bar = stateRef.current.bars.find((item) => item.id === barId);
            const orbit = stateRef.current.orbits.find((item) => item.id === bar?.orbitId);
            if (!bar || !orbit || orbit.mode !== "loop" || bar.kind !== "play") return;
            if (isFullLoopBar({ ...bar, lengthRadians })) return;
            setLastLoopBarLengthRadians(
              Math.min(TAU - .0001, Math.max(MIN_BAR_LENGTH_RADIANS, lengthRadians))
            );
          }}
          onContextMenu={(nextMenu) => {
            setMenu(nextMenu);
            uploadPoint.current = { x: nextMenu.canvasX, y: nextMenu.canvasY };
          }}
          onDropFiles={(files, point) => void handleFiles(files, point)}
          onDragState={setIsDragOver}
        />
      </section>
      <OrbitSettingsPanel
        orbit={selectedOrbit} planets={planets}
        onMode={(mode: OrbitMode) => {
          if (selection.orbitId) setOrbitMode(selection.orbitId, mode);
        }}
        onVolume={(volume) => {
          updateSelectedOrbit({ volume });
          if (selection.orbitId) audioEngine.setVolume(selection.orbitId, volume);
        }}
        onPlanetSpeed={(planetId, speed) => {
          pushHistory();
          const planet = planets.find((item) => item.id === planetId);
          const orbit = orbits.find((item) => item.id === planet?.orbitId);
          if (planet && orbit) {
            audioEngine.setActivePlanetPlaybackRate(
              planetId, getSpeedBasedPlaybackRate(orbit, { ...planet, speed })
            );
          }
          setPlanets((current) => current.map((planet) =>
            planet.id === planetId ? { ...planet, speed } : planet));
        }}
        onPlanetVolume={(planetId, volume) => {
          pushHistory();
          audioEngine.setActivePlanetVolume(planetId, volume);
          setPlanets((current) => current.map((planet) =>
            planet.id === planetId ? { ...planet, volume } : planet));
        }}
        onPlanetPitchPreview={previewPlanetPitch}
        onPlanetPitchCommit={(planetId, pitchCents) => void commitPlanetPitch(planetId, pitchCents)}
        onDeletePlanet={deletePlanet}
      />
      <TransportControls
        isPlaying={isPlaying}
        onPlay={() => { void audioEngine.resume(); setIsPlaying(true); }}
        onPause={() => {
          audioEngine.stopAllActivePlaybacks();
          setIsPlaying(false);
        }}
        onStop={() => {
          audioEngine.stopAllActivePlaybacks();
          setIsPlaying(false);
          setPlanets((current) => current.map((planet) => ({ ...planet, angle: 0 })));
        }}
      />
      {menu && <ContextMenu
        menu={menu}
        sequenceMode={orbits.find((orbit) => orbit.id === menu.orbitId)?.mode === "sequence"}
        onUpload={() => { setMenu(null); fileInput.current?.click(); }}
        onToggleMode={toggleMenuMode}
        onTogglePause={toggleOrbitPause}
        onAddPlayBar={() => addContextBar("play")}
        onAddStopBar={() => addContextBar("stop")}
      />}
      <input
        ref={fileInput} className="hidden-input" type="file" multiple
        accept=".wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg"
        onChange={(event) => {
          void handleFiles(Array.from(event.target.files ?? []), uploadPoint.current);
          event.currentTarget.value = "";
        }}
      />
      {message && <div className="toast">{message}</div>}
      <footer>DROP AUDIO · DELETE SELECTION · CTRL+Z UNDO</footer>
    </main>
  );
}
