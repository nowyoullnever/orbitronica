import { useEffect, useRef, useState } from "react";
import type { Orbit, OrbitMode, Planet, PluginSlot, SequenceRetriggerMode } from "../state/types";
import { WAM_CATALOG } from "../audio/wamCatalog";
import {
  getOrbitTapeRate, getPlanetEffectiveSpeed, getSampleEnd, getSampleStart,
  getTapeStyleRuntimeRateOnly, rateToCents, SPLICE_MAX_PIECES
} from "../utils/geometry";
import { SampleTrimEditor } from "./SampleTrimEditor";
import { normalizeSampleWindow } from "../utils/sampleTrim";

type Props = {
  orbit: Orbit | null;
  planets: Planet[];
  waveformPeaks?: Float32Array;
  onSampleTrim: (orbitId: string, start: number, end: number) => void;
  projectName: string;
  isDirty: boolean;
  hasPlanetClipboard: boolean;
  onProjectName: (name: string) => void;
  onSave: () => void;
  onOpen: () => void;
  onMode: (mode: OrbitMode) => void;
  onSpliceCount: (count: number) => void;
  onName: (name: string) => void;
  onColor: (color: string) => void;
  onVolume: (volume: number) => void;
  onOrbitAudioPan: (audioPan: number) => void;
  onPause: () => void;
  onMute: (muted: boolean) => void;
  onSolo: (solo: boolean) => void;
  onToggleWaveform: (show: boolean) => void;
  onRetriggerMode: (mode: SequenceRetriggerMode) => void;
  onDuplicate: () => void;
  onDeleteOrbit: () => void;
  onPlanetSpeedPreview: (planetId: string, speed: number) => void;
  onPlanetSpeedCommit: (planetId: string, speed: number) => void;
  onOrbitTapeRateApply: (orbitId: string, rate: number) => void;
  onPlanetCollisionTapeApply: (planetId: string, rate: number) => void;
  onPlanetRuntimeTapeApply: (planetId: string, rate: number) => void;
  onPlanetFinalMovementApply: (planetId: string, rate: number) => void;
  onPlanetFinalPitchApply: (planetId: string, cents: number) => void;
  onPlanetVolume: (planetId: string, volume: number) => void;
  onPlanetAudioPan: (planetId: string, audioPan: number) => void;
  onPlanetPitchPreview: (planetId: string, pitchCents: number) => void;
  onPlanetPitchCommit: (planetId: string, pitchCents: number) => void;
  onPlanetReverse: (planetId: string, reverse: boolean) => void;
  onCopyPlanet: (planetId: string) => void;
  onPastePlanetToOrbit: (orbitId: string) => void;
  onDeletePlanet: (planetId: string) => void;
  onAddPlugin: () => void;
  onMovePlugin: (slotId: string, direction: -1 | 1) => void;
  onBypassPlugin: (slotId: string, bypassed: boolean) => void;
  onRemovePlugin: (slotId: string) => void;
  pluginStatus: (slotId: string) => "idle" | "loading" | "ready" | "unavailable";
  onMountPluginGui: (slotId: string, container: HTMLElement) => Promise<void>;
  onUnmountPluginGui: (slotId: string) => Promise<void>;
};

function PluginGui({ slot, status, onMount, onUnmount }: {
  slot: PluginSlot;
  status: "idle" | "loading" | "ready" | "unavailable";
  onMount: (slotId: string, container: HTMLElement) => Promise<void>;
  onUnmount: (slotId: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || status !== "ready") return;
    void onMount(slot.id, container);
    return () => { void onUnmount(slot.id); };
  }, [slot.id, status, onMount, onUnmount]);
  return <div className="wam-plugin-gui" ref={ref} aria-label="Plugin editor" />;
}

function PluginRack({ orbit, props }: { orbit: Orbit; props: Props }) {
  const slots = orbit.plugins ?? [];
  return <section className="settings-section plugin-rack" data-testid="plugin-rack">
    <div className="panel-eyebrow">PLUGINS - {slots.length}</div>
    <button type="button" onClick={props.onAddPlugin}>Add Burns Simple Delay</button>
    {slots.length === 0 && <p className="no-planets">Add an approved effect to this orbit.</p>}
    {slots.map((slot, index) => {
      const status = props.pluginStatus(slot.id);
      const catalog = WAM_CATALOG[slot.catalogId as keyof typeof WAM_CATALOG];
      return <div className="plugin-slot" key={slot.id} data-plugin-status={status}>
        <div className="plugin-slot-header">
          <strong>{catalog?.id === "burns-simple-delay" ? "Burns Simple Delay" : "Unavailable plugin"}</strong>
          <small>{status === "ready" ? (slot.bypassed ? "bypassed" : "ready") : status}</small>
        </div>
        <div className="plugin-actions">
          <button type="button" aria-label="Move plugin earlier" disabled={index === 0} onClick={() => props.onMovePlugin(slot.id, -1)}>↑</button>
          <button type="button" aria-label="Move plugin later" disabled={index === slots.length - 1} onClick={() => props.onMovePlugin(slot.id, 1)}>↓</button>
          <label><input type="checkbox" checked={slot.bypassed} onChange={(event) => props.onBypassPlugin(slot.id, event.target.checked)} /> Bypass</label>
          <button type="button" className="danger" onClick={() => props.onRemovePlugin(slot.id)}>Remove</button>
        </div>
        {status === "unavailable" && <p role="status">Plugin unavailable; its saved state is retained.</p>}
        {status === "loading" && <p role="status">Loading plugin…</p>}
        {status === "ready" && !slot.bypassed && <PluginGui slot={slot} status={status}
          onMount={props.onMountPluginGui} onUnmount={props.onUnmountPluginGui} />}
      </div>;
    })}
  </section>;
}

function NameEditor({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return <input value={draft} onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} />;
}

function formatMetric(value: number, decimals: number) {
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

function EditableMetric({
  label, value, decimals, suffix, step, min, max, disabled, onApply
}: {
  label: string;
  value: number;
  decimals: number;
  suffix: string;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onApply: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatMetric(value, decimals));
  const [isEditing, setIsEditing] = useState(false);
  useEffect(() => {
    if (!isEditing) setDraft(formatMetric(value, decimals));
  }, [value, decimals, isEditing]);

  const apply = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatMetric(value, decimals));
      return;
    }
    const rounded = decimals === 0 ? Math.round(parsed) : Number(parsed.toFixed(decimals));
    onApply(rounded);
  };

  return <div className="editable-metric">
    <span>{label}</span>
    <input type="number" value={draft} step={step} min={min} max={max} disabled={disabled}
      onFocus={() => setIsEditing(true)}
      onBlur={() => { setIsEditing(false); apply(); }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
          event.currentTarget.blur();
        }
      }} />
    <em>{suffix}</em>
    <button type="button" disabled={disabled} onClick={apply}>Apply</button>
  </div>;
}

function ReadonlyMetric({ label, value, suffix, decimals = 2 }: {
  label: string;
  value: number;
  suffix: string;
  decimals?: number;
}) {
  return <div className="readonly-metric">
    <span>{label}</span>
    <output>{decimals === 0 ? Math.round(value) : value.toFixed(decimals)} {suffix}</output>
  </div>;
}

function AudioPanControl({ label, value, onChange }: { label: string; value: number; onChange: (audioPan: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isEditing) setDraft(String(value));
  }, [value, isEditing]);

  const applyDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(nextDraft)) {
      setError("Please enter a valid number.");
      return;
    }
    const parsed = Number(nextDraft);
    if (parsed > 100) {
      setError("Please enter a value less than or equal to 100.");
      return;
    }
    if (parsed < -100) {
      setError("Please enter a value greater than or equal to -100.");
      return;
    }
    setError(null);
    onChange(parsed);
  };
  const reset = () => {
    setDraft("0");
    setError(null);
    onChange(0);
  };

  return <div className="audio-pan-control">
    <label><span>{label} <output>{value > 0 ? "+" : ""}{value}</output></span>
      <input type="range" min="-100" max="100" step="1" value={value}
        onChange={(event) => { setDraft(event.target.value); setError(null); onChange(Number(event.target.value)); }}
        onDoubleClick={reset} />
    </label>
    <input className="audio-pan-number" type="text" inputMode="decimal" value={draft} aria-label={`${label} value`}
      onFocus={() => setIsEditing(true)}
      onChange={(event) => applyDraft(event.target.value)}
      onBlur={() => setIsEditing(false)}
      onDoubleClick={reset} />
    {error && <small className="audio-pan-error">{error}</small>}
  </div>;
}

export function OrbitSettingsPanel(props: Props) {
  const { orbit, planets } = props;
  const orbitPlanets = orbit ? planets.filter((planet) => planet.orbitId === orbit.id) : [];
  return (
    <aside className="settings">
      <section className="settings-section project-section">
        <div className="panel-eyebrow">PROJECT {props.isDirty ? "- UNSAVED" : "- SAVED"}</div>
        <input value={props.projectName} onChange={(event) => props.onProjectName(event.target.value)} />
        <div className="panel-actions">
          <button onClick={props.onSave}>Save</button>
          <button onClick={props.onOpen}>Open</button>
        </div>
      </section>

      {orbit ? <>
        <section className="settings-section">
          <div className="panel-eyebrow">ORBIT</div>
          <NameEditor value={orbit.name} onCommit={props.onName} />
          <div className="audio-duration">{orbit.audioName} - {orbit.audioDuration.toFixed(2)} SEC</div>
          <div className="sample-trim">
            <div className="panel-eyebrow">SAMPLE START / END</div>
            <SampleTrimEditor
              key={orbit.id}
              audioDuration={orbit.audioDuration}
              peaks={props.waveformPeaks}
              start={getSampleStart(orbit)}
              end={getSampleEnd(orbit)}
              color={orbit.color}
              onChange={(start, end) => props.onSampleTrim(orbit.id, start, end)}
            />
            <div className="effective-values">
              <EditableMetric label="START" value={getSampleStart(orbit)} decimals={2} suffix="sec"
                step={0.01} min={0} max={orbit.audioDuration}
                onApply={(value) => {
                  const window = normalizeSampleWindow(orbit.audioDuration, value, getSampleEnd(orbit));
                  props.onSampleTrim(orbit.id, window.start, window.end);
                }} />
              <EditableMetric label="END" value={getSampleEnd(orbit)} decimals={2} suffix="sec"
                step={0.01} min={0} max={orbit.audioDuration}
                onApply={(value) => {
                  const window = normalizeSampleWindow(orbit.audioDuration, getSampleStart(orbit), value);
                  props.onSampleTrim(orbit.id, window.start, window.end);
                }} />
              <ReadonlyMetric label="LENGTH" value={getSampleEnd(orbit) - getSampleStart(orbit)} suffix="sec" />
            </div>
          </div>
          <label><span>MODE</span>
            <select value={orbit.mode} onChange={(event) => props.onMode(event.target.value as OrbitMode)}>
              <option value="loop">Loop / timeline</option>
              <option value="sequence">Sequence / one-shot</option>
            </select>
          </label>
          <label><span>COLOR</span>
            <input className="color-input" type="color" value={orbit.color}
              onChange={(event) => props.onColor(event.target.value)} />
          </label>
          {orbit.mode === "loop" && <label><span>SPLICE <output>
            {(orbit.spliceCount ?? 0) === 0 ? "OFF"
              : `${(orbit.spliceCount ?? 0) > 0 ? "+" : ""}${orbit.spliceCount} pcs`}
          </output></span>
            <input type="range" min={-SPLICE_MAX_PIECES} max={SPLICE_MAX_PIECES} step="2" value={orbit.spliceCount ?? 0}
              onChange={(event) => props.onSpliceCount(Number(event.target.value))}
              onDoubleClick={() => props.onSpliceCount(0)} />
          </label>}
          <div className="toggle-row">
            <label><input type="checkbox" checked={!orbit.isPaused} onChange={props.onPause} /> Active</label>
            <label><input type="checkbox" checked={orbit.isMuted}
              onChange={(event) => props.onMute(event.target.checked)} /> Mute</label>
            <label><input type="checkbox" checked={orbit.isSolo}
              onChange={(event) => props.onSolo(event.target.checked)} /> Solo</label>
          </div>
          <label className="reverse-toggle">
            <input type="checkbox" checked={orbit.showWaveform !== false}
              onChange={(event) => props.onToggleWaveform(event.target.checked)} />
            SHOW WAVEFORM
          </label>
          <label><span>ORBIT VOLUME <output>{Math.round(orbit.volume * 100)}%</output></span>
            <input type="range" min="0" max="1" step=".01" value={orbit.volume}
              onChange={(event) => props.onVolume(Number(event.target.value))}
              onDoubleClick={() => props.onVolume(1)} />
          </label>
          <AudioPanControl label="ORBIT PAN" value={orbit.audioPan} onChange={props.onOrbitAudioPan} />
          {orbit.mode === "sequence" && <label><span>SEQUENCE RETRIGGER</span>
            <select value={orbit.sequenceRetriggerMode}
              onChange={(event) => props.onRetriggerMode(event.target.value as SequenceRetriggerMode)}>
              <option value="overlap">Overlap</option>
              <option value="cut-previous">Cut Previous</option>
              <option value="ignore-until-end">Ignore Until End</option>
            </select>
          </label>}
          <div className="panel-actions">
            <button onClick={props.onDuplicate}>Duplicate</button>
            <button disabled={!props.hasPlanetClipboard} onClick={() => props.onPastePlanetToOrbit(orbit.id)}>
              Paste Planet
            </button>
            <button className="danger" onClick={props.onDeleteOrbit}>Delete Orbit</button>
          </div>
        </section>

        <PluginRack orbit={orbit} props={props} />

        <section className="settings-section">
          <div className="panel-eyebrow">PLANETS - {orbitPlanets.length}</div>
          <div className="planet-controls">
            {orbitPlanets.map((planet, index) => {
              const speedPreview = planet.pendingSpeed ?? planet.speed;
              const pitchPreview = planet.pendingPitchCents ?? planet.pitchCents;
              const orbitTapeRate = getOrbitTapeRate(orbit);
              const runtimeTapeRate = getTapeStyleRuntimeRateOnly(orbit, planet);
              const finalMovementSpeed = getPlanetEffectiveSpeed(orbit, planet);
              const finalPitchCents = planet.pitchCents + rateToCents(runtimeTapeRate);
              return <section className="planet-control" key={planet.id}>
                <h3><i style={{ background: orbit.color }} />PLANET {index + 1}</h3>
                <label className="reverse-toggle">
                  <input type="checkbox" checked={planet.direction === -1}
                    onChange={(event) => props.onPlanetReverse(planet.id, event.target.checked)} />
                  REVERSE DIRECTION
                </label>
                <label><span>SPEED PREVIEW <output>{speedPreview.toFixed(2)}x</output></span>
                  <input type="range" min=".05" max="8" step=".01" value={speedPreview}
                    onChange={(event) => props.onPlanetSpeedPreview(planet.id, Number(event.target.value))}
                    onPointerUp={(event) => props.onPlanetSpeedCommit(planet.id, Number(event.currentTarget.value))}
                    onKeyUp={(event) => props.onPlanetSpeedCommit(planet.id, Number(event.currentTarget.value))}
                    onBlur={(event) => props.onPlanetSpeedCommit(planet.id, Number(event.currentTarget.value))}
                    onDoubleClick={() => {
                      props.onPlanetSpeedPreview(planet.id, 1);
                      props.onPlanetSpeedCommit(planet.id, 1);
                    }} />
                </label>
                <div className={`pitch-status ${planet.isSpeedProcessing ? "processing" : ""}`}>
                  <span>APPLIED {planet.speed.toFixed(2)}x</span>
                  <span>{planet.isSpeedProcessing ? "PROCESSING..." :
                    planet.pendingSpeed !== undefined ? "NOT APPLIED" :
                      planet.speedProcessingError ? "FAILED" : "READY"}</span>
                </div>
                <div className="effective-values">
                  <EditableMetric label="BASE SPEED" value={planet.speed} decimals={2} suffix="x"
                    step={0.01} min={0.05} max={8}
                    onApply={(value) => props.onPlanetSpeedCommit(planet.id, value)} />
                  <ReadonlyMetric label="LIVE SPEED" value={finalMovementSpeed} suffix="x" />
                  <EditableMetric label="USER PITCH" value={planet.pitchCents} decimals={0} suffix="cents"
                    step={1} min={-3600} max={3600}
                    onApply={(value) => props.onPlanetPitchCommit(planet.id, value)} />
                  <EditableMetric label="ORBIT TAPE" value={orbitTapeRate} decimals={2} suffix="x"
                    step={0.01} min={0.05} max={8} disabled={orbit.mode === "sequence"}
                    onApply={(value) => props.onOrbitTapeRateApply(orbit.id, value)} />
                  <EditableMetric label="COLLISION TAPE" value={planet.collisionSpeedMultiplier} decimals={2} suffix="x"
                    step={0.01} min={0.05} max={8} disabled={orbit.mode === "sequence"}
                    onApply={(value) => props.onPlanetCollisionTapeApply(planet.id, value)} />
                  <EditableMetric label="RUNTIME TAPE" value={runtimeTapeRate} decimals={2} suffix="x"
                    step={0.01} min={0.05} max={8} disabled={orbit.mode === "sequence"}
                    onApply={(value) => props.onPlanetRuntimeTapeApply(planet.id, value)} />
                  <EditableMetric label="FINAL MOVEMENT" value={finalMovementSpeed} decimals={2} suffix="x"
                    step={0.01} min={0.05} max={64}
                    onApply={(value) => props.onPlanetFinalMovementApply(planet.id, value)} />
                  <EditableMetric label="FINAL PITCH" value={finalPitchCents} decimals={0} suffix="cents"
                    step={1} min={-7200} max={7200}
                    onApply={(value) => props.onPlanetFinalPitchApply(planet.id, value)} />
                </div>
                <label><span>VOLUME <output>{Math.round(planet.volume * 100)}%</output></span>
                  <input type="range" min="0" max="1" step=".01" value={planet.volume}
                    onChange={(event) => props.onPlanetVolume(planet.id, Number(event.target.value))}
                    onDoubleClick={() => props.onPlanetVolume(planet.id, 1)} />
                </label>
                <AudioPanControl label="PAN" value={planet.audioPan} onChange={(audioPan) => props.onPlanetAudioPan(planet.id, audioPan)} />
                <label><span>PITCH PREVIEW <output>
                  {pitchPreview > 0 ? "+" : ""}{pitchPreview} cents
                </output></span>
                  <input type="range" min="-3600" max="3600" step="1"
                    value={pitchPreview}
                    onChange={(event) => props.onPlanetPitchPreview(planet.id, Number(event.target.value))}
                    onPointerUp={(event) => props.onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onKeyUp={(event) => props.onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onBlur={(event) => props.onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onDoubleClick={() => {
                      props.onPlanetPitchPreview(planet.id, 0);
                      props.onPlanetPitchCommit(planet.id, 0);
                    }} />
                </label>
                <div className={`pitch-status ${planet.isPitchProcessing ? "processing" : ""}`}>
                  <span>APPLIED {planet.pitchCents > 0 ? "+" : ""}{planet.pitchCents} cents</span>
                  <span>{planet.isPitchProcessing ? "PROCESSING..." :
                    planet.pendingPitchCents !== undefined ? "NOT APPLIED" : "READY"}</span>
                </div>
                <div className="planet-actions">
                  <button onClick={() => props.onCopyPlanet(planet.id)}>Copy Planet</button>
                  <button className="danger" onClick={() => props.onDeletePlanet(planet.id)}>Delete Planet</button>
                </div>
              </section>;
            })}
            {!orbitPlanets.length && <p className="no-planets">Use the Planet tool to add a playhead.</p>}
          </div>
        </section>
      </> : <div className="panel-empty"><div className="empty-orbit" /><p>Select an orbit<br />to shape its sound.</p></div>}
    </aside>
  );
}
