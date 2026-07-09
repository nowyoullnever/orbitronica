export type Tool = "select" | "planet" | "bar";
export type OrbitMode = "loop" | "sequence";

export type Orbit = {
  id: string;
  audioName: string;
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
};

export type Planet = {
  id: string;
  orbitId: string;
  angle: number;
  speed: number;
  volume: number;
  pitchCents: number;
  pendingPitchCents?: number;
  isPitchProcessing?: boolean;
  processingPitchCents?: number;
  pitchProcessRequestId?: string;
  isActive: boolean;
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

export type ContextMenuState = {
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
  orbitId: string | null;
};
