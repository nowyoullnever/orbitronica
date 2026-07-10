import type { Orbit, Planet, Selection, SerializableProject, TriggerBar } from "../state/types";
import { normalizeSampleWindow } from "../utils/sampleTrim";

function serializeOrbit(orbit: Orbit): Orbit {
  const window = normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd);
  return { ...orbit, sampleStart: window.start, sampleEnd: window.end };
}

export function serializeProject(
  projectName: string,
  orbits: Orbit[],
  planets: Planet[],
  bars: TriggerBar[],
  lastLoopBarLengthRadians: number,
  selection: Selection
): SerializableProject {
  return {
    schemaVersion: 3,
    appName: "Orbitonic",
    savedAt: new Date().toISOString(),
    projectName,
    orbits: orbits.map(serializeOrbit),
    planets: planets.map((planet) => ({
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
    })),
    bars: bars.map((bar) => ({ ...bar })),
    lastLoopBarLengthRadians,
    ui: { ...selection }
  };
}

export function parseProject(text: string): SerializableProject {
  const parsed = JSON.parse(text) as Partial<SerializableProject>;
  if (!Array.isArray(parsed.orbits) || !Array.isArray(parsed.planets) || !Array.isArray(parsed.bars)) {
    throw new Error("This file is not a valid Orbitonic project.");
  }
  return {
    schemaVersion: 3,
    appName: "Orbitonic",
    savedAt: parsed.savedAt ?? new Date().toISOString(),
    projectName: parsed.projectName ?? "Untitled Session",
    // v1/v2 projects omitted trim fields; normalizing makes those full-sample
    // windows explicit and repairs malformed imported values before state uses them.
    orbits: parsed.orbits.map(serializeOrbit),
    planets: parsed.planets,
    bars: parsed.bars,
    lastLoopBarLengthRadians: parsed.lastLoopBarLengthRadians ?? Math.PI / 12,
    ui: parsed.ui
  };
}
