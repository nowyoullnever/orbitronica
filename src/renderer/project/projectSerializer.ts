import type { Orbit, Planet, Selection, SerializableProject, TriggerBar } from "../state/types";

export function serializeProject(
  projectName: string,
  orbits: Orbit[],
  planets: Planet[],
  bars: TriggerBar[],
  lastLoopBarLengthRadians: number,
  selection: Selection
): SerializableProject {
  return {
    schemaVersion: 2,
    appName: "Orbitonic",
    savedAt: new Date().toISOString(),
    projectName,
    orbits: orbits.map((orbit) => ({ ...orbit })),
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
    // Splice bars are derived from each orbit's splice settings on load; only manual bars
    // belong in the durable project state.
    bars: bars.filter((bar) => bar.source !== "splice").map((bar) => ({ ...bar })),
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
    schemaVersion: 2,
    appName: "Orbitonic",
    savedAt: parsed.savedAt ?? new Date().toISOString(),
    projectName: parsed.projectName ?? "Untitled Session",
    orbits: parsed.orbits,
    planets: parsed.planets,
    bars: parsed.bars,
    lastLoopBarLengthRadians: parsed.lastLoopBarLengthRadians ?? Math.PI / 12,
    ui: parsed.ui
  };
}
