import { useEffect, useState } from "react";
import type { Orbit, OrbitMode, Planet, SequenceRetriggerMode } from "../state/types";
import { centsToPlaybackRate, getPlanetEffectiveSpeed, getSpeedBasedPlaybackRate } from "../utils/geometry";

type Props = {
  orbit: Orbit | null;
  planets: Planet[];
  projectName: string;
  isDirty: boolean;
  onProjectName: (name: string) => void;
  onSave: () => void;
  onOpen: () => void;
  onMode: (mode: OrbitMode) => void;
  onName: (name: string) => void;
  onColor: (color: string) => void;
  onVolume: (volume: number) => void;
  onPause: () => void;
  onMute: (muted: boolean) => void;
  onSolo: (solo: boolean) => void;
  onRetriggerMode: (mode: SequenceRetriggerMode) => void;
  onDuplicate: () => void;
  onDeleteOrbit: () => void;
  onPlanetSpeed: (planetId: string, speed: number) => void;
  onPlanetVolume: (planetId: string, volume: number) => void;
  onPlanetPitchPreview: (planetId: string, pitchCents: number) => void;
  onPlanetPitchCommit: (planetId: string, pitchCents: number) => void;
  onPlanetReverse: (planetId: string, reverse: boolean) => void;
  onDeletePlanet: (planetId: string) => void;
};

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

export function OrbitSettingsPanel(props: Props) {
  const { orbit, planets } = props;
  const orbitPlanets = orbit ? planets.filter((planet) => planet.orbitId === orbit.id) : [];
  return (
    <aside className="settings">
      <section className="settings-section project-section">
        <div className="panel-eyebrow">PROJECT {props.isDirty ? "• UNSAVED" : "• SAVED"}</div>
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
          <div className="audio-duration">{orbit.audioName} · {orbit.audioDuration.toFixed(2)} SEC</div>
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
          <div className="toggle-row">
            <label><input type="checkbox" checked={!orbit.isPaused} onChange={props.onPause} /> Active</label>
            <label><input type="checkbox" checked={orbit.isMuted}
              onChange={(event) => props.onMute(event.target.checked)} /> Mute</label>
            <label><input type="checkbox" checked={orbit.isSolo}
              onChange={(event) => props.onSolo(event.target.checked)} /> Solo</label>
          </div>
          <label><span>ORBIT VOLUME <output>{Math.round(orbit.volume * 100)}%</output></span>
            <input type="range" min="0" max="1" step=".01" value={orbit.volume}
              onChange={(event) => props.onVolume(Number(event.target.value))}
              onDoubleClick={() => props.onVolume(1)} />
          </label>
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
            <button className="danger" onClick={props.onDeleteOrbit}>Delete Orbit</button>
          </div>
        </section>

        <section className="settings-section">
          <div className="panel-eyebrow">PLANETS · {orbitPlanets.length}</div>
          <div className="planet-controls">
            {orbitPlanets.map((planet, index) => <section className="planet-control" key={planet.id}>
              <h3><i style={{ background: orbit.color }} />PLANET {index + 1}</h3>
              <label className="reverse-toggle">
                <input type="checkbox" checked={planet.direction === -1}
                  onChange={(event) => props.onPlanetReverse(planet.id, event.target.checked)} />
                REVERSE DIRECTION
              </label>
              <label><span>SPEED <output>{planet.speed.toFixed(2)}×</output></span>
                <input type="range" min=".25" max="3" step=".05" value={planet.speed}
                  onChange={(event) => props.onPlanetSpeed(planet.id, Number(event.target.value))}
                  onDoubleClick={() => props.onPlanetSpeed(planet.id, 1)} />
              </label>
              <div className="effective-values">
                <span>EFFECTIVE <output>{getPlanetEffectiveSpeed(orbit, planet).toFixed(2)}×</output></span>
                <span>TAPE RATE <output>{getSpeedBasedPlaybackRate(orbit, planet).toFixed(2)}×</output></span>
                <span>COLLISION <output>{planet.collisionSpeedMultiplier.toFixed(2)}×</output></span>
                <span>PITCH <output>{centsToPlaybackRate(planet.pitchCents).toFixed(2)}×</output></span>
              </div>
              <label><span>VOLUME <output>{Math.round(planet.volume * 100)}%</output></span>
                <input type="range" min="0" max="1" step=".01" value={planet.volume}
                  onChange={(event) => props.onPlanetVolume(planet.id, Number(event.target.value))}
                  onDoubleClick={() => props.onPlanetVolume(planet.id, 1)} />
              </label>
              <label><span>PITCH PREVIEW <output>
                {(planet.pendingPitchCents ?? planet.pitchCents) > 0 ? "+" : ""}
                {planet.pendingPitchCents ?? planet.pitchCents} cents
              </output></span>
                <input type="range" min="-1200" max="1200" step="10"
                  value={planet.pendingPitchCents ?? planet.pitchCents}
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
                <span>{planet.isPitchProcessing ? "PROCESSING…" :
                  planet.pendingPitchCents !== undefined ? "NOT APPLIED" : "READY"}</span>
              </div>
              <button className="delete-planet" onClick={() => props.onDeletePlanet(planet.id)}>Delete Planet</button>
            </section>)}
            {!orbitPlanets.length && <p className="no-planets">Use the Planet tool to add a playhead.</p>}
          </div>
        </section>
      </> : <div className="panel-empty"><div className="empty-orbit" /><p>Select an orbit<br />to shape its sound.</p></div>}
    </aside>
  );
}
