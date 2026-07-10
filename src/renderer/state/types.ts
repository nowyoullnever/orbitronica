export type Tool = "select" | "planet" | "bar";
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
  mode: OrbitMode;
  volume: number;
  isPaused: boolean;
  isMuted: boolean;
  isSolo: boolean;
  color: string;
  sequenceRetriggerMode: SequenceRetriggerMode;
  isMissingAudio?: boolean;
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
  collisionCooldownRemaining: number;
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
};

export type Selection = {
  orbitId: string | null;
  planetId: string | null;
  barId: string | null;
};

export type HistorySnapshot = {
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  selection: Selection;
};

export type SerializableProject = {
  schemaVersion: 2;
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
