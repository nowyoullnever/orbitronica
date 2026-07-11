import type { MasterMix, Orbit, Planet, Selection, SerializableProject, TriggerBar } from "../state/types";
import { normalizeSampleWindow } from "../utils/sampleTrim.ts";

function serializeOrbit(orbit: Orbit): Orbit {
  const window = normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd);
  return { ...orbit, audioPan: Number.isFinite(orbit.audioPan) ? orbit.audioPan : 0, sampleStart: window.start, sampleEnd: window.end };
}

export function normalizeMasterMix(master?: Partial<MasterMix> | null): MasterMix {
  const volume = typeof master?.volume === "number" && Number.isFinite(master.volume) ? master.volume : 1;
  const pan = typeof master?.pan === "number" && Number.isFinite(master.pan) ? master.pan : 0;
  return {
    volume: Math.min(1, Math.max(0, volume)),
    pan: Math.min(1, Math.max(-1, pan))
  };
}

export function serializeProject(
  projectName: string,
  orbits: Orbit[],
  planets: Planet[],
  bars: TriggerBar[],
  lastLoopBarLengthRadians: number,
  selection: Selection,
  master: MasterMix
): SerializableProject {
  return {
    schemaVersion: 4,
    appName: "Orbitonic",
    savedAt: new Date().toISOString(),
    projectName,
    orbits: orbits.map(serializeOrbit),
    planets: planets.map((planet) => ({
      ...planet,
      audioPan: Number.isFinite(planet.audioPan) ? planet.audioPan : 0,
      pendingSpeed: undefined,
      isSpeedProcessing: false,
      processingSpeed: undefined,
      speedProcessRequestId: undefined,
      speedProcessingError: undefined,
      pendingPitchCents: undefined,
      isPitchProcessing: false,
      processingPitchCents: undefined,
      pitchProcessRequestId: undefined
    })),
    // Splice bars are derived from each orbit's splice settings on load; only manual bars
    // belong in the durable project state.
    bars: bars.filter((bar) => bar.source !== "splice").map((bar) => ({ ...bar })),
    lastLoopBarLengthRadians,
    master: normalizeMasterMix(master),
    ui: { ...selection }
  };
}

export function parseProject(text: string): SerializableProject {
  const parsed = JSON.parse(text) as Partial<SerializableProject> & { master?: Partial<MasterMix> | null };
  if (!Array.isArray(parsed.orbits) || !Array.isArray(parsed.planets) || !Array.isArray(parsed.bars)) {
    throw new Error("This file is not a valid Orbitonic project.");
  }
  return {
    schemaVersion: 4,
    appName: "Orbitonic",
    savedAt: parsed.savedAt ?? new Date().toISOString(),
    projectName: parsed.projectName ?? "Untitled Session",
    // v1/v2 projects omitted trim fields; normalizing makes those full-sample
    // windows explicit and repairs malformed imported values before state uses them.
    orbits: parsed.orbits.map(serializeOrbit),
    planets: parsed.planets.map((planet) => ({ ...planet, audioPan: Number.isFinite(planet.audioPan) ? planet.audioPan : 0 })),
    bars: parsed.bars,
    lastLoopBarLengthRadians: parsed.lastLoopBarLengthRadians ?? Math.PI / 12,
    master: normalizeMasterMix(parsed.master),
    ui: parsed.ui
  };
}
