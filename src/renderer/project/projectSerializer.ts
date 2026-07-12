import type {
  MasterMix, Orbit, Planet, Scene, Selection, SerializableProjectV4,
  SerializableProjectV5, SerializableSceneV5, TriggerBar, ViewportState
} from "../state/types";
import {
  assertValidScenes, collectSceneIds, createEmptyScene, createSpliceBars, DEFAULT_VIEWPORT
} from "../state/scenes.ts";
import { normalizeSampleWindow } from "../utils/sampleTrim.ts";

export type ParsedProject = Omit<SerializableProjectV5, "scenes"> & { scenes: Scene[] };
type IdFactory = () => string;
const defaultIdFactory: IdFactory = () => crypto.randomUUID();

function invalidProject(detail?: string): never {
  throw new Error(`This file is not a valid Orbitonic project${detail ? `: ${detail}` : "."}`);
}

function serializeOrbit(orbit: Orbit): Orbit {
  const window = normalizeSampleWindow(orbit.audioDuration, orbit.sampleStart, orbit.sampleEnd);
  return {
    ...orbit,
    audioPan: Number.isFinite(orbit.audioPan) ? orbit.audioPan : 0,
    sampleStart: window.start,
    sampleEnd: window.end
  };
}

function stablePlanet(planet: Planet): Planet {
  return {
    ...planet,
    angle: Number.isFinite(planet.angle) ? planet.angle : 0,
    speed: Number.isFinite(planet.speed) ? planet.speed : 1,
    volume: Number.isFinite(planet.volume) ? planet.volume : 1,
    audioPan: Number.isFinite(planet.audioPan) ? planet.audioPan : 0,
    pitchCents: Number.isFinite(planet.pitchCents) ? planet.pitchCents : 0,
    isActive: planet.isActive ?? true,
    direction: planet.direction === -1 ? -1 : 1,
    pendingSpeed: undefined,
    isSpeedProcessing: false,
    processingSpeed: undefined,
    speedProcessRequestId: undefined,
    speedProcessingError: undefined,
    pendingPitchCents: undefined,
    isPitchProcessing: false,
    processingPitchCents: undefined,
    pitchProcessRequestId: undefined,
    collisionSpeedMultiplier: 1,
    collisionFlashRemaining: 0
  };
}

function serializePlanet(planet: Planet): Planet {
  const durable: Partial<Planet> = { ...stablePlanet(planet) };
  delete durable.pendingSpeed;
  delete durable.isSpeedProcessing;
  delete durable.processingSpeed;
  delete durable.speedProcessRequestId;
  delete durable.speedProcessingError;
  delete durable.pendingPitchCents;
  delete durable.isPitchProcessing;
  delete durable.processingPitchCents;
  delete durable.pitchProcessRequestId;
  delete durable.collisionFlashRemaining;
  return durable as Planet;
}

export function normalizeMasterMix(master?: Partial<MasterMix> | null): MasterMix {
  const volume = typeof master?.volume === "number" && Number.isFinite(master.volume) ? master.volume : 1;
  const pan = typeof master?.pan === "number" && Number.isFinite(master.pan) ? master.pan : 0;
  return {
    volume: Math.min(1, Math.max(0, volume)),
    pan: Math.min(1, Math.max(-1, pan))
  };
}

export function normalizeViewport(viewport?: Partial<ViewportState> | null): ViewportState {
  const zoom = typeof viewport?.zoom === "number" && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  const offsetX = typeof viewport?.offsetX === "number" && Number.isFinite(viewport.offsetX) ? viewport.offsetX : 0;
  const offsetY = typeof viewport?.offsetY === "number" && Number.isFinite(viewport.offsetY) ? viewport.offsetY : 0;
  return { zoom: Math.min(4, Math.max(.1, zoom)), offsetX, offsetY };
}

function normalizeSelection(selection: unknown, scene: Pick<Scene, "orbits" | "planets" | "bars">): Selection {
  const empty: Selection = { orbitId: null, planetId: null, barId: null };
  if (!selection || typeof selection !== "object") return empty;
  const value = selection as Partial<Selection>;
  const valid = (id: unknown, values: readonly { id: string }[]) =>
    id === null || (typeof id === "string" && values.some((item) => item.id === id));
  if (!valid(value.orbitId ?? null, scene.orbits) || !valid(value.planetId ?? null, scene.planets) ||
    !valid(value.barId ?? null, scene.bars)) return empty;
  return {
    orbitId: value.orbitId ?? null,
    planetId: value.planetId ?? null,
    barId: value.barId ?? null
  };
}

function serializeScene(scene: Scene): SerializableSceneV5 {
  return {
    id: scene.id,
    name: scene.name,
    orbits: scene.orbits.map(serializeOrbit),
    planets: scene.planets.map(serializePlanet),
    bars: scene.bars.filter((bar) => bar.source !== "splice").map((bar) => ({ ...bar })),
    viewport: normalizeViewport(scene.viewport),
    selection: { ...scene.selection }
  };
}

export function serializeProject(
  projectName: string,
  scenes: readonly Scene[],
  activeSceneId: string,
  lastLoopBarLengthRadians: number,
  master: MasterMix
): SerializableProjectV5 {
  const persistedScenes = scenes.map(serializeScene);
  return {
    schemaVersion: 5,
    appName: "Orbitonic",
    savedAt: new Date().toISOString(),
    projectName,
    scenes: persistedScenes,
    activeSceneId: persistedScenes.some((scene) => scene.id === activeSceneId)
      ? activeSceneId : persistedScenes[0]?.id ?? "",
    master: normalizeMasterMix(master),
    lastLoopBarLengthRadians: Number.isFinite(lastLoopBarLengthRadians)
      ? lastLoopBarLengthRadians : Math.PI / 12
  };
}

function requireSceneShape(value: unknown, index: number, strictV5 = true): asserts value is SerializableSceneV5 {
  if (!value || typeof value !== "object") invalidProject(`scene ${index + 1} is not an object.`);
  const scene = value as Partial<SerializableSceneV5>;
  if (typeof scene.id !== "string" || !scene.id || typeof scene.name !== "string" ||
    !Array.isArray(scene.orbits) || !Array.isArray(scene.planets) || !Array.isArray(scene.bars)) {
    invalidProject(`scene ${index + 1} has malformed identity or entity arrays.`);
  }
  const requireEntity = (entity: unknown, kind: "orbit" | "planet" | "bar", entityIndex: number) => {
    if (!entity || typeof entity !== "object" || typeof (entity as { id?: unknown }).id !== "string" ||
      !(entity as { id: string }).id) {
      invalidProject(`scene ${index + 1} ${kind} ${entityIndex + 1} has a malformed ID.`);
    }
    if (kind !== "orbit" && typeof (entity as { orbitId?: unknown }).orbitId !== "string") {
      invalidProject(`scene ${index + 1} ${kind} ${entityIndex + 1} has a malformed orbitId.`);
    }
  };
  scene.orbits.forEach((entity, entityIndex) => requireEntity(entity, "orbit", entityIndex));
  scene.planets.forEach((entity, entityIndex) => requireEntity(entity, "planet", entityIndex));
  scene.bars.forEach((entity, entityIndex) => requireEntity(entity, "bar", entityIndex));
  if (!strictV5) return;

  const label = (kind: string, entityIndex: number, field: string) =>
    `scene ${index + 1} ${kind} ${entityIndex + 1} has malformed ${field}.`;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const requiredFinite = (entity: Record<string, unknown>, fields: string[], kind: string, entityIndex: number) => {
    for (const field of fields) if (!finite(entity[field])) invalidProject(label(kind, entityIndex, field));
  };
  const optionalFinite = (entity: Record<string, unknown>, fields: string[], kind: string, entityIndex: number) => {
    for (const field of fields) if (entity[field] !== undefined && !finite(entity[field])) {
      invalidProject(label(kind, entityIndex, field));
    }
  };
  const inRange = (value: unknown, min: number, max: number) =>
    finite(value) && (value as number) >= min && (value as number) <= max;
  const angle = (value: unknown) => finite(value) && (value as number) >= 0 && (value as number) < Math.PI * 2;
  scene.orbits.forEach((raw, entityIndex) => {
    const entity = raw as unknown as Record<string, unknown>;
    for (const field of ["name", "audioName", "color"]) {
      if (typeof entity[field] !== "string") invalidProject(label("orbit", entityIndex, field));
    }
    requiredFinite(entity, ["x", "y", "radiusX", "radiusY", "initialRadiusX", "initialRadiusY",
      "audioDuration", "volume", "audioPan"], "orbit", entityIndex);
    optionalFinite(entity, ["sampleStart", "sampleEnd", "spliceCount", "spliceStartAngle"], "orbit", entityIndex);
    for (const field of ["radiusX", "radiusY", "initialRadiusX", "initialRadiusY"]) {
      if ((entity[field] as number) <= 0) invalidProject(label("orbit", entityIndex, field));
    }
    if ((entity.audioDuration as number) < 0) invalidProject(label("orbit", entityIndex, "audioDuration"));
    if (!inRange(entity.volume, 0, 1)) invalidProject(label("orbit", entityIndex, "volume"));
    if (!inRange(entity.audioPan, -1, 1)) invalidProject(label("orbit", entityIndex, "audioPan"));
    const duration = entity.audioDuration as number;
    if (entity.sampleStart !== undefined && !inRange(entity.sampleStart, 0, duration)) {
      invalidProject(label("orbit", entityIndex, "sampleStart"));
    }
    if (entity.sampleEnd !== undefined && (!inRange(entity.sampleEnd, 0, duration) ||
      (entity.sampleStart !== undefined && (entity.sampleEnd as number) < (entity.sampleStart as number)))) {
      invalidProject(label("orbit", entityIndex, "sampleEnd"));
    }
    if (entity.spliceCount !== undefined && (!Number.isInteger(entity.spliceCount) ||
      Math.abs(entity.spliceCount as number) > 32 || (entity.spliceCount as number) % 2 !== 0)) {
      invalidProject(label("orbit", entityIndex, "spliceCount"));
    }
    if (entity.spliceStartAngle !== undefined && !angle(entity.spliceStartAngle)) {
      invalidProject(label("orbit", entityIndex, "spliceStartAngle"));
    }
    if (entity.mode !== "loop" && entity.mode !== "sequence") invalidProject(label("orbit", entityIndex, "mode"));
    if (!["overlap", "cut-previous", "ignore-until-end"].includes(String(entity.sequenceRetriggerMode))) {
      invalidProject(label("orbit", entityIndex, "sequenceRetriggerMode"));
    }
    for (const field of ["isPaused", "isMuted", "isSolo"]) {
      if (typeof entity[field] !== "boolean") invalidProject(label("orbit", entityIndex, field));
    }
    for (const field of ["isMissingAudio", "showWaveform"]) {
      if (entity[field] !== undefined && typeof entity[field] !== "boolean") invalidProject(label("orbit", entityIndex, field));
    }
    if (entity.audioPath !== undefined && typeof entity.audioPath !== "string") {
      invalidProject(label("orbit", entityIndex, "audioPath"));
    }
  });
  scene.planets.forEach((raw, entityIndex) => {
    const entity = raw as unknown as Record<string, unknown>;
    requiredFinite(entity, ["angle", "speed", "volume", "audioPan", "pitchCents"], "planet", entityIndex);
    if (!angle(entity.angle)) invalidProject(label("planet", entityIndex, "angle"));
    if (!inRange(entity.speed, .000001, 8)) invalidProject(label("planet", entityIndex, "speed"));
    if (!inRange(entity.volume, 0, 1)) invalidProject(label("planet", entityIndex, "volume"));
    if (!inRange(entity.audioPan, -1, 1)) invalidProject(label("planet", entityIndex, "audioPan"));
    if (!inRange(entity.pitchCents, -4800, 4800)) invalidProject(label("planet", entityIndex, "pitchCents"));
    if (typeof entity.isActive !== "boolean") invalidProject(label("planet", entityIndex, "isActive"));
    if (entity.direction !== 1 && entity.direction !== -1) invalidProject(label("planet", entityIndex, "direction"));
    optionalFinite(entity, ["collisionSpeedMultiplier", "collisionFlashRemaining"], "planet", entityIndex);
    if (entity.collisionSpeedMultiplier !== undefined && (entity.collisionSpeedMultiplier as number) <= 0) {
      invalidProject(label("planet", entityIndex, "collisionSpeedMultiplier"));
    }
    if (entity.collisionFlashRemaining !== undefined && (entity.collisionFlashRemaining as number) < 0) {
      invalidProject(label("planet", entityIndex, "collisionFlashRemaining"));
    }
  });
  scene.bars.forEach((raw, entityIndex) => {
    const entity = raw as unknown as Record<string, unknown>;
    requiredFinite(entity, ["angle", "lengthRadians", "startAngle"], "bar", entityIndex);
    optionalFinite(entity, ["startTime", "endTime"], "bar", entityIndex);
    if (!angle(entity.angle)) invalidProject(label("bar", entityIndex, "angle"));
    if (!angle(entity.startAngle)) invalidProject(label("bar", entityIndex, "startAngle"));
    if (!inRange(entity.lengthRadians, .000001, Math.PI * 2)) {
      invalidProject(label("bar", entityIndex, "lengthRadians"));
    }
    if (entity.startTime !== undefined && (entity.startTime as number) < 0) {
      invalidProject(label("bar", entityIndex, "startTime"));
    }
    if (entity.endTime !== undefined && ((entity.endTime as number) < 0 ||
      (entity.startTime !== undefined && (entity.endTime as number) < (entity.startTime as number)))) {
      invalidProject(label("bar", entityIndex, "endTime"));
    }
    if (entity.kind !== "play" && entity.kind !== "stop") invalidProject(label("bar", entityIndex, "kind"));
    if (entity.source !== undefined && entity.source !== "manual" && entity.source !== "splice") {
      invalidProject(label("bar", entityIndex, "source"));
    }
  });
  const viewport = scene.viewport as unknown as Record<string, unknown> | undefined;
  if (!viewport || !finite(viewport.zoom) || !finite(viewport.offsetX) || !finite(viewport.offsetY)) {
    invalidProject(`scene ${index + 1} has a malformed viewport.`);
  }
  const selection = scene.selection as unknown as Record<string, unknown> | undefined;
  if (!selection || ["orbitId", "planetId", "barId"].some((field) =>
    selection[field] !== null && typeof selection[field] !== "string")) {
    invalidProject(`scene ${index + 1} has a malformed selection.`);
  }
}

function runtimeScene(raw: SerializableSceneV5): Scene {
  const orbits = raw.orbits.map(serializeOrbit);
  const planets = raw.planets.map(stablePlanet);
  const bars = raw.bars.filter((bar) => bar.source !== "splice").map((bar) => ({ ...bar }));
  return {
    id: raw.id,
    name: raw.name,
    orbits,
    planets,
    bars,
    viewport: normalizeViewport(raw.viewport),
    selection: normalizeSelection(raw.selection, {
      orbits, planets, bars: [...bars, ...orbits.flatMap(createSpliceBars)]
    }),
    multiSelection: { orbitIds: [], planetIds: [] }
  };
}

function uniqueMigrationSceneId(orbits: Orbit[], planets: Planet[], bars: TriggerBar[], createId: IdFactory) {
  const occupied = collectSceneIds([{
    id: "__migration_placeholder__", name: "Scene 1", orbits, planets, bars,
    viewport: { ...DEFAULT_VIEWPORT }, selection: { orbitId: null, planetId: null, barId: null },
    multiSelection: { orbitIds: [], planetIds: [] }
  }]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = createId();
    if (candidate && !occupied.has(candidate)) return candidate;
  }
  invalidProject("could not allocate a unique scene ID during v4 migration.");
}

function migrateV4(raw: Partial<SerializableProjectV4>, createId: IdFactory): ParsedProject {
  if (!Array.isArray(raw.orbits) || !Array.isArray(raw.planets) || !Array.isArray(raw.bars)) {
    invalidProject("v4 projects require top-level orbits, planets, and bars arrays.");
  }
  requireSceneShape({ id: "migration", name: "Scene 1", orbits: raw.orbits, planets: raw.planets, bars: raw.bars }, 0, false);
  const orbits = raw.orbits.map(serializeOrbit);
  const planets = raw.planets.map(stablePlanet);
  const manualBars = raw.bars.filter((bar) => bar.source !== "splice").map((bar) => ({ ...bar }));
  const scene: Scene = {
    id: uniqueMigrationSceneId(orbits, planets, manualBars, createId),
    name: "Scene 1",
    orbits,
    planets,
    bars: manualBars,
    viewport: { ...DEFAULT_VIEWPORT },
    selection: { orbitId: null, planetId: null, barId: null },
    multiSelection: { orbitIds: [], planetIds: [] }
  };
  scene.selection = normalizeSelection(raw.ui, {
    ...scene,
    bars: [...scene.bars, ...scene.orbits.flatMap(createSpliceBars)]
  });
  assertValidScenes([scene]);
  scene.bars = [...scene.bars, ...scene.orbits.flatMap(createSpliceBars)];
  return {
    schemaVersion: 5,
    appName: "Orbitonic",
    savedAt: raw.savedAt ?? new Date().toISOString(),
    projectName: raw.projectName ?? "Untitled Session",
    scenes: [scene],
    activeSceneId: scene.id,
    master: normalizeMasterMix(raw.master),
    lastLoopBarLengthRadians: Number.isFinite(raw.lastLoopBarLengthRadians)
      ? raw.lastLoopBarLengthRadians! : Math.PI / 12
  };
}

export function parseProject(text: string, createId: IdFactory = defaultIdFactory): ParsedProject {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { invalidProject("the JSON could not be parsed."); }
  if (!raw || typeof raw !== "object") invalidProject("the root value is not an object.");
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion === undefined || root.schemaVersion === 4) {
    return migrateV4(root as Partial<SerializableProjectV4>, createId);
  }
  if (typeof root.schemaVersion === "number" && root.schemaVersion > 5) {
    throw new Error(`Unsupported Orbitonic schema version ${root.schemaVersion}. This app supports versions 4 and 5.`);
  }
  if (root.schemaVersion !== 5) invalidProject(`unsupported schemaVersion ${String(root.schemaVersion)}.`);
  if (root.appName !== "Orbitonic") invalidProject("v5 appName must be \"Orbitonic\".");
  if (!Array.isArray(root.scenes)) invalidProject("v5 projects require a scenes array.");

  let scenes: Scene[];
  if (root.scenes.length === 0) {
    scenes = [createEmptyScene("Scene 1", createId)];
  } else {
    root.scenes.forEach((scene, index) => requireSceneShape(scene, index));
    scenes = (root.scenes as SerializableSceneV5[]).map(runtimeScene);
  }
  assertValidScenes(scenes);
  scenes = scenes.map((scene) => ({
    ...scene,
    bars: [...scene.bars, ...scene.orbits.flatMap(createSpliceBars)]
  }));
  const requestedActiveId = typeof root.activeSceneId === "string" ? root.activeSceneId : "";
  const activeSceneId = scenes.some((scene) => scene.id === requestedActiveId)
    ? requestedActiveId : scenes[0].id;
  return {
    schemaVersion: 5,
    appName: "Orbitonic",
    savedAt: typeof root.savedAt === "string" ? root.savedAt : new Date().toISOString(),
    projectName: typeof root.projectName === "string" ? root.projectName : "Untitled Session",
    scenes,
    activeSceneId,
    master: normalizeMasterMix(root.master as Partial<MasterMix> | null),
    lastLoopBarLengthRadians: typeof root.lastLoopBarLengthRadians === "number" &&
      Number.isFinite(root.lastLoopBarLengthRadians) ? root.lastLoopBarLengthRadians : Math.PI / 12
  };
}
