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
};

export type SerializableProject = {
  schemaVersion: 3;
  appName: "Orbitonic";
  savedAt: string;
  projectName: string;
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  lastLoopBarLengthRadians: number;
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
