export type Tool = "select" | "planet" | "bar" | "splicer";
export type OrbitMode = "loop" | "sequence";
export type SequenceRetriggerMode = "overlap" | "cut-previous" | "ignore-until-end";

export type Orbit = {
  id: string;
  name: string;
  audioName: string;
  audioPath?: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  initialRadiusX: number;
  initialRadiusY: number;
  audioDuration: number;
  // Playback window into the sample, in seconds. Undefined means the full sample
  // (sampleStart 0 .. sampleEnd audioDuration). Both loop and sequence modes honor it.
  sampleStart?: number;
  sampleEnd?: number;
  mode: OrbitMode;
  volume: number;
  audioPan: number;
  isPaused: boolean;
  isMuted: boolean;
  isSolo: boolean;
  color: string;
  sequenceRetriggerMode: SequenceRetriggerMode;
  isMissingAudio?: boolean;
  // Signed even count of equal pieces the orbit is spliced into (bar/gap alternating).
  // 0 = no splice. Positive starts with a bar at angle 0; negative starts with a gap.
  spliceCount?: number;
  // Angle (radians) where the splice pattern begins; rotates every splice piece. Default 0.
  spliceStartAngle?: number;
  // Whether the sample waveform is drawn around the orbit. Undefined/true = shown.
  showWaveform?: boolean;
};

export type Planet = {
  id: string;
  orbitId: string;
  angle: number;
  speed: number;
  pendingSpeed?: number;
  isSpeedProcessing?: boolean;
  processingSpeed?: number;
  speedProcessRequestId?: string;
  speedProcessingError?: string;
  volume: number;
  audioPan: number;
  pitchCents: number;
  pendingPitchCents?: number;
  isPitchProcessing?: boolean;
  processingPitchCents?: number;
  pitchProcessRequestId?: string;
  isActive: boolean;
  direction: 1 | -1;
  collisionSpeedMultiplier: number;
  collisionFlashRemaining: number;
  name?: string;
};

export type TriggerBar = {
  id: string;
  orbitId: string;
  angle: number;
  lengthRadians: number;
  startAngle: number;
  kind: "play" | "stop";
  startTime?: number;
  endTime?: number;
  // "splice" bars are generated from the orbit's spliceCount and regenerated together;
  // absent/"manual" bars are placed by hand and never touched by the splicer.
  source?: "manual" | "splice";
};

export type Selection = {
  orbitId: string | null;
  planetId: string | null;
  barId: string | null;
};

// Box/marquee selection: multiple orbits and planets picked at once. Kept separate
// from the single Selection (which drives the settings panel); used for group delete.
export type MultiSelection = {
  orbitIds: string[];
  planetIds: string[];
};

export type MasterMix = {
  volume: number;
  pan: number;
};

export type ViewportState = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export type HistorySnapshot = {
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  selection: Selection;
  multiSelection: MultiSelection;
  master: MasterMix;
};

export type SerializableProject = {
  schemaVersion: 4;
  appName: "Orbitonic";
  savedAt: string;
  projectName: string;
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  lastLoopBarLengthRadians: number;
  master: MasterMix;
  ui?: Selection;
};

export type ContextMenuState = {
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
  orbitId: string | null;
  planetId?: string | null;
};
