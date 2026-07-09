import type { Orbit, OrbitMode, Planet } from "../state/types";
import {
  centsToPlaybackRate, getPlanetEffectiveSpeed, getSpeedBasedPlaybackRate
} from "../utils/geometry";

type Props = {
  orbit: Orbit | null;
  planets: Planet[];
  onMode: (mode: OrbitMode) => void;
  onVolume: (volume: number) => void;
  onPlanetSpeed: (planetId: string, speed: number) => void;
  onPlanetVolume: (planetId: string, volume: number) => void;
  onPlanetPitchPreview: (planetId: string, pitchCents: number) => void;
  onPlanetPitchCommit: (planetId: string, pitchCents: number) => void;
  onDeletePlanet: (planetId: string) => void;
};

export function OrbitSettingsPanel({
  orbit, planets, onMode, onVolume, onPlanetSpeed, onPlanetVolume,
  onPlanetPitchPreview, onPlanetPitchCommit, onDeletePlanet
}: Props) {
  const orbitPlanets = orbit ? planets.filter((planet) => planet.orbitId === orbit.id) : [];
  return (
    <aside className={`settings ${orbit ? "visible" : ""}`}>
      {orbit ? (
        <>
          <div className="panel-eyebrow">ORBIT</div>
          <h2 title={orbit.audioName}>{orbit.audioName}</h2>
          <div className="audio-duration">{orbit.audioDuration.toFixed(2)} SEC / FULL ORBIT</div>
          <div className="rule" />
          <label>
            <span>MODE</span>
            <select value={orbit.mode} onChange={(event) => onMode(event.target.value as OrbitMode)}>
              <option value="loop">Loop / timeline</option>
              <option value="sequence">Sequence / one-shot</option>
            </select>
          </label>
          <label>
            <span>ORBIT VOLUME <output>{Math.round(orbit.volume * 100)}%</output></span>
            <input type="range" min="0" max="1" step=".01" value={orbit.volume}
              onChange={(event) => onVolume(Number(event.target.value))}
              onDoubleClick={() => onVolume(1)} />
          </label>
          <div className="orbit-status">
            <i className={orbit.isPaused ? "paused" : ""} />
            {orbit.isPaused ? "Orbit paused" : "Orbit active"}
          </div>
          <div className="rule planet-rule" />
          <div className="panel-eyebrow">PLANETS · {orbitPlanets.length}</div>
          <div className="planet-controls">
            {orbitPlanets.map((planet, index) => (
              <section className="planet-control" key={planet.id}>
                <h3><i style={{ opacity: .45 + index * .12 }} />PLANET {index + 1}</h3>
                <label>
                  <span>USER SPEED <output>{planet.speed.toFixed(2)}×</output></span>
                  <input type="range" min=".25" max="3" step=".05" value={planet.speed}
                    onChange={(event) => onPlanetSpeed(planet.id, Number(event.target.value))}
                    onDoubleClick={() => onPlanetSpeed(planet.id, 1)} />
                </label>
                <div className="effective-values">
                  <span>EFFECTIVE SPEED <output>{getPlanetEffectiveSpeed(orbit, planet).toFixed(2)}×</output></span>
                  <span>TAPE RATE <output>{getSpeedBasedPlaybackRate(orbit, planet).toFixed(2)}×</output></span>
                  <span>PITCH RATIO <output>{centsToPlaybackRate(planet.pitchCents).toFixed(2)}×</output></span>
                </div>
                <label>
                  <span>VOLUME <output>{Math.round(planet.volume * 100)}%</output></span>
                  <input type="range" min="0" max="1" step=".01" value={planet.volume}
                    onChange={(event) => onPlanetVolume(planet.id, Number(event.target.value))}
                    onDoubleClick={() => onPlanetVolume(planet.id, 1)} />
                </label>
                <label>
                  <span>PITCH PREVIEW <output>
                    {(planet.pendingPitchCents ?? planet.pitchCents) > 0 ? "+" : ""}
                    {planet.pendingPitchCents ?? planet.pitchCents} cents
                  </output></span>
                  <input
                    type="range" min="-1200" max="1200" step="10"
                    value={planet.pendingPitchCents ?? planet.pitchCents}
                    onChange={(event) => onPlanetPitchPreview(planet.id, Number(event.target.value))}
                    onPointerUp={(event) => onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onKeyUp={(event) => onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onBlur={(event) => onPlanetPitchCommit(planet.id, Number(event.currentTarget.value))}
                    onDoubleClick={() => {
                      onPlanetPitchPreview(planet.id, 0);
                      onPlanetPitchCommit(planet.id, 0);
                    }}
                  />
                </label>
                <div className={`pitch-status ${planet.isPitchProcessing ? "processing" : ""}`}>
                  <span>APPLIED {planet.pitchCents > 0 ? "+" : ""}{planet.pitchCents} cents</span>
                  <span>{planet.isPitchProcessing
                    ? "PROCESSING PITCH…"
                    : planet.pendingPitchCents !== undefined ? "NOT APPLIED YET" : "READY"}</span>
                </div>
                <button className="delete-planet" onClick={() => onDeletePlanet(planet.id)}>
                  Delete Planet
                </button>
              </section>
            ))}
            {!orbitPlanets.length && <p className="no-planets">Use the Planet tool to add a playhead.</p>}
          </div>
        </>
      ) : (
        <div className="panel-empty">
          <div className="empty-orbit" />
          <p>Select an orbit<br />to shape its sound.</p>
        </div>
      )}
    </aside>
  );
}
