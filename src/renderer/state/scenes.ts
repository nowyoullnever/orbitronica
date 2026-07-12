import type {
  HistorySnapshot, MasterMix, MultiSelection, Orbit, Planet, Scene, Selection, TriggerBar,
  ViewportState
} from "./types.ts";
import { normalizeSpliceCount, spliceBarSpecs } from "../utils/geometry.ts";

export const DEFAULT_VIEWPORT: Readonly<ViewportState> = { zoom: 1, offsetX: 0, offsetY: 0 };
export const EMPTY_SELECTION: Readonly<Selection> = { orbitId: null, planetId: null, barId: null };
export type IdFactory = () => string;
const defaultIdFactory: IdFactory = () => crypto.randomUUID();

export type ProjectIdAllocator = {
  next(extraReserved?: Iterable<string>): string;
  nextWithReservations(reservationsFor: (candidate: string) => Iterable<string>): string;
  reserve(ids: Iterable<string>): void;
  reserveDerived(ownerId: string, ids: Iterable<string>): void;
  issued(): ReadonlySet<string>;
};

export function createProjectIdAllocator(
  initiallyReserved: Iterable<string> = [], generate: IdFactory = defaultIdFactory
): ProjectIdAllocator {
  const reserved = new Set(initiallyReserved);
  const tombstones = new Set<string>();
  const derivedOwners = new Map<string, string>();
  const allocate = (
    reservationsFor: (candidate: string) => Iterable<string>, forbidden: ReadonlySet<string> = new Set()
  ) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const candidate = generate();
      if (!candidate || reserved.has(candidate) || tombstones.has(candidate) ||
        derivedOwners.has(candidate) || forbidden.has(candidate)) continue;
      const derived = [...reservationsFor(candidate)];
      const unique = new Set(derived);
      if (unique.size !== derived.length || unique.has(candidate) || derived.some((id) =>
        !id || reserved.has(id) || tombstones.has(id) || derivedOwners.has(id) || forbidden.has(id))) continue;
      reserved.add(candidate);
      tombstones.add(candidate);
      for (const id of derived) derivedOwners.set(id, candidate);
      return candidate;
    }
    throw new Error("Unable to allocate a unique project ID.");
  };
  return {
    next(extraReserved = []) {
      const extra = new Set(extraReserved);
      return allocate(() => [], extra);
    },
    nextWithReservations(reservationsFor) {
      return allocate(reservationsFor);
    },
    reserve(ids) { for (const id of ids) reserved.add(id); },
    reserveDerived(ownerId, ids) {
      const proposed = [...ids];
      if (!ownerId || new Set(proposed).size !== proposed.length || proposed.some((id) =>
        !id || id === ownerId || reserved.has(id) || tombstones.has(id) ||
        (derivedOwners.has(id) && derivedOwners.get(id) !== ownerId))) {
        throw new Error(`Derived ID namespace for orbit "${ownerId}" is already reserved.`);
      }
      proposed.forEach((id) => derivedOwners.set(id, ownerId));
    },
    issued() { return tombstones; }
  };
}

function collectDirectSceneIds(scenes: readonly Scene[]): Set<string> {
  const ids = new Set<string>();
  for (const scene of scenes) {
    ids.add(scene.id);
    scene.orbits.forEach((item) => ids.add(item.id));
    scene.planets.forEach((item) => ids.add(item.id));
    scene.bars.filter((item) => item.source !== "splice").forEach((item) => ids.add(item.id));
  }
  return ids;
}

export function reserveSceneProjectIds(allocator: ProjectIdAllocator, scenes: readonly Scene[]): void {
  allocator.reserve(collectDirectSceneIds(scenes));
  for (const scene of scenes) for (const orbit of scene.orbits) {
    allocator.reserveDerived(orbit.id, impliedSpliceBarIds(orbit));
  }
}

/** Creates an isolated allocator session and fully preflights a candidate document. */
export function createProjectIdAllocatorForScenes(
  scenes: readonly Scene[], generate: IdFactory = defaultIdFactory
): ProjectIdAllocator {
  const allocator = createProjectIdAllocator([], generate);
  reserveSceneProjectIds(allocator, scenes);
  return allocator;
}

/** Identity of user-editable scene structure; ignores simulation angles and transient UI/runtime state. */
export function durableSceneStructureToken(scene: Scene): string {
  return JSON.stringify({
    id: scene.id,
    name: scene.name,
    orbits: scene.orbits,
    planets: scene.planets.map((planet) => ({
      id: planet.id, orbitId: planet.orbitId, speed: planet.speed, volume: planet.volume,
      audioPan: planet.audioPan, pitchCents: planet.pitchCents, isActive: planet.isActive,
      name: planet.name
    })),
    bars: scene.bars
  });
}

export function collectHistoryProjectIds(
  scenes: readonly Scene[], undo: readonly HistorySnapshot[] = [], redo: readonly HistorySnapshot[] = []
): Set<string> {
  const ids = collectSceneIds(scenes);
  for (const snapshot of [...undo, ...redo]) {
    for (const id of collectSceneIds(snapshot.scenes)) ids.add(id);
  }
  return ids;
}

/** Applies restored mixer values for every scene, including inactive audio kept for undo. */
export function reconcileSceneOrbitMix(
  scenes: readonly Scene[], apply: (orbitId: string, volume: number, pan: number) => void
): void {
  for (const scene of scenes) for (const orbit of scene.orbits) {
    apply(orbit.id, orbit.volume, orbit.audioPan);
  }
}

export type StagedDocumentTransaction<TStage> = {
  stage(): Promise<TStage>;
  commit(staged: TStage): void | Promise<void>;
  publish(): void;
  rollback?(staged: TStage): void | Promise<void>;
};

/** Publishes a document only after all fallible staging and runtime installation succeeds. */
export async function runStagedDocumentTransaction<TStage>(
  transaction: StagedDocumentTransaction<TStage>
): Promise<void> {
  const staged = await transaction.stage();
  try {
    await transaction.commit(staged);
    transaction.publish();
  } catch (error) {
    try { await transaction.rollback?.(staged); } catch { /* Preserve the transaction failure. */ }
    throw error;
  }
}

export type TabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";
export function nextSceneTabIndex(current: number, count: number, key: TabNavigationKey): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return (current + (key === "ArrowRight" ? 1 : -1) + count) % count;
}

export function createEmptyScene(name = "Scene 1", createId: IdFactory = defaultIdFactory): Scene {
  return {
    id: createId(), name, orbits: [], planets: [], bars: [],
    viewport: { ...DEFAULT_VIEWPORT }, selection: { ...EMPTY_SELECTION },
    multiSelection: { orbitIds: [], planetIds: [] }
  };
}

export function nextDefaultSceneName(scenes: readonly Pick<Scene, "name">[]): string {
  const used = new Set<number>();
  for (const { name } of scenes) {
    const match = /^Scene ([1-9]\d*)$/.exec(name);
    if (match) used.add(Number(match[1]));
  }
  let number = 1;
  while (used.has(number)) number += 1;
  return `Scene ${number}`;
}

export function updateSceneById(
  scenes: readonly Scene[], sceneId: string, update: (scene: Scene) => Scene
): Scene[] {
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) return scenes as Scene[];
  const replacement = update(scenes[index]);
  if (replacement === scenes[index]) return scenes as Scene[];
  const next = scenes.slice();
  next[index] = replacement;
  return next;
}

export function renameScene(scenes: readonly Scene[], sceneId: string, rawName: string): Scene[] {
  const name = rawName.trim();
  if (!name) return scenes as Scene[];
  return updateSceneById(scenes, sceneId, (scene) => scene.name === name ? scene : { ...scene, name });
}

export function reorderScenes(
  scenes: readonly Scene[], draggedSceneId: string, targetSceneId: string
): Scene[] {
  const from = scenes.findIndex((scene) => scene.id === draggedSceneId);
  const target = scenes.findIndex((scene) => scene.id === targetSceneId);
  if (from < 0 || target < 0 || from === target) return scenes as Scene[];
  const next = scenes.slice();
  const [dragged] = next.splice(from, 1);
  next.splice(Math.min(target, next.length), 0, dragged);
  return next.every((scene, index) => scene === scenes[index]) ? scenes as Scene[] : next;
}

export function deleteScene(
  scenes: readonly Scene[], sceneId: string, activeSceneId: string
): { scenes: Scene[]; activeSceneId: string } {
  if (scenes.length <= 1) return { scenes: scenes as Scene[], activeSceneId };
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) return { scenes: scenes as Scene[], activeSceneId };
  const next = scenes.filter((scene) => scene.id !== sceneId);
  const nextActiveId = activeSceneId === sceneId
    ? next[Math.min(index, next.length - 1)].id
    : activeSceneId;
  return { scenes: next, activeSceneId: nextActiveId };
}

export type SceneTransitionEffects = {
  designateAudibleScene?(): void;
  stopActivePlaybacks(): void;
  closeTransientUi(): void;
  cancelInteractions(): void;
};

/** The single runtime boundary used before publishing a different active scene. */
export function runActiveSceneTransition(
  currentSceneId: string, nextSceneId: string, effects: SceneTransitionEffects, force = false
): boolean {
  if (!force && currentSceneId === nextSceneId) return false;
  effects.designateAudibleScene?.();
  effects.stopActivePlaybacks();
  effects.closeTransientUi();
  effects.cancelInteractions();
  return true;
}

function isStablePlanetRuntime(planet: Planet): boolean {
  return planet.pendingSpeed === undefined && planet.isSpeedProcessing !== true &&
    planet.processingSpeed === undefined && planet.speedProcessRequestId === undefined &&
    planet.speedProcessingError === undefined && planet.pendingPitchCents === undefined &&
    planet.isPitchProcessing !== true && planet.processingPitchCents === undefined &&
    planet.pitchProcessRequestId === undefined && planet.collisionFlashRemaining === 0 &&
    planet.collisionSpeedMultiplier === 1;
}

/** Removes async and collision-only state that must never be restored or persisted. */
export function stabilizePlanetRuntime(planet: Planet): Planet {
  if (isStablePlanetRuntime(planet)) return planet;
  return {
    ...planet,
    pendingSpeed: undefined, isSpeedProcessing: false, processingSpeed: undefined,
    speedProcessRequestId: undefined, speedProcessingError: undefined,
    pendingPitchCents: undefined, isPitchProcessing: false, processingPitchCents: undefined,
    pitchProcessRequestId: undefined, collisionFlashRemaining: 0, collisionSpeedMultiplier: 1
  };
}

export const projectPlanetForHistory = stabilizePlanetRuntime;

export function projectSceneForHistory(scene: Scene): Scene {
  const planets = scene.planets.map(stabilizePlanetRuntime);
  return planets.some((planet, index) => planet !== scene.planets[index]) ? { ...scene, planets } : scene;
}

export function createHistorySnapshot(
  scenes: readonly Scene[], activeSceneId: string, master: MasterMix
): HistorySnapshot {
  return { scenes: scenes.map(projectSceneForHistory), activeSceneId, master: { ...master } };
}

export function collectRetainedOrbitIds(
  scenes: readonly Scene[],
  undo: readonly HistorySnapshot[] = [],
  redo: readonly HistorySnapshot[] = []
): Set<string> {
  const retained = new Set<string>();
  for (const documentScenes of [scenes, ...undo.map((item) => item.scenes), ...redo.map((item) => item.scenes)]) {
    for (const scene of documentScenes) {
      for (const orbit of scene.orbits) retained.add(orbit.id);
    }
  }
  return retained;
}

export function updatePlanetForFreshRequest(
  scenes: readonly Scene[], sceneId: string, planetId: string,
  requestKind: "speed" | "pitch", requestId: string,
  update: (planet: Planet) => Planet
): Scene[] {
  const requestKey = requestKind === "speed" ? "speedProcessRequestId" : "pitchProcessRequestId";
  return updateSceneById(scenes, sceneId, (scene) => {
    const index = scene.planets.findIndex((planet) => planet.id === planetId);
    if (index < 0 || scene.planets[index][requestKey] !== requestId) return scene;
    const planets = scene.planets.slice();
    planets[index] = update(planets[index]);
    return { ...scene, planets };
  });
}

export function spliceBarId(orbitId: string, index: number): string {
  return `${orbitId}:splice:${index}`;
}

export function createSpliceBars(orbit: Pick<Orbit, "id" | "spliceCount" | "spliceStartAngle">): TriggerBar[] {
  return spliceBarSpecs(orbit.spliceCount ?? 0, orbit.spliceStartAngle ?? 0).map((spec, index) => ({
    id: spliceBarId(orbit.id, index), orbitId: orbit.id, angle: spec.angle,
    lengthRadians: spec.lengthRadians, startAngle: spec.startAngle, kind: "play", source: "splice"
  }));
}

export function impliedSpliceBarIds(orbit: Pick<Orbit, "id" | "spliceCount">): string[] {
  const count = Math.abs(normalizeSpliceCount(orbit.spliceCount ?? 0)) / 2;
  return Array.from({ length: count }, (_, index) => spliceBarId(orbit.id, index));
}

export type SceneValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateScenes(scenes: readonly Scene[]): SceneValidationResult {
  const errors: string[] = [];
  const persisted = new Map<string, string>();
  const derived = new Map<string, string>();
  const actualSplice = new Map<string, string>();
  const register = (map: Map<string, string>, id: string, label: string) => {
    if (!id) { errors.push(`${label} has an empty ID.`); return; }
    const prior = map.get(id);
    if (prior) errors.push(`Duplicate ID "${id}" is used by ${prior} and ${label}.`);
    else map.set(id, label);
  };

  for (const scene of scenes) {
    register(persisted, scene.id, `scene "${scene.name}"`);
    const orbitIds = new Set(scene.orbits.map((orbit) => orbit.id));
    for (const orbit of scene.orbits) register(persisted, orbit.id, `orbit "${orbit.id}"`);
    for (const planet of scene.planets) {
      register(persisted, planet.id, `planet "${planet.id}"`);
      if (!orbitIds.has(planet.orbitId)) errors.push(
        `Planet "${planet.id}" references orbit "${planet.orbitId}" outside its scene.`);
    }
    for (const bar of scene.bars) {
      if (!orbitIds.has(bar.orbitId)) errors.push(
        `Bar "${bar.id}" references orbit "${bar.orbitId}" outside its scene.`);
      register(bar.source === "splice" ? actualSplice : persisted, bar.id,
        `${bar.source === "splice" ? "splice bar" : "bar"} "${bar.id}"`);
      if (bar.source === "splice") {
        const owner = scene.orbits.find((orbit) => orbit.id === bar.orbitId);
        if (owner && !impliedSpliceBarIds(owner).includes(bar.id)) {
          errors.push(`Splice bar "${bar.id}" is not implied by orbit "${bar.orbitId}".`);
        }
      }
    }
    for (const orbit of scene.orbits) {
      for (const id of impliedSpliceBarIds(orbit)) {
        register(derived, id, `derived splice for orbit "${orbit.id}"`);
      }
    }
  }
  for (const [id, label] of derived) {
    const collision = persisted.get(id);
    if (collision) errors.push(`Reserved ID "${id}" for ${label} collides with ${collision}.`);
  }
  for (const [id, label] of actualSplice) {
    if (!derived.has(id)) errors.push(`${label} is not implied by its orbit's splice settings.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function assertValidScenes(scenes: readonly Scene[]): void {
  const result = validateScenes(scenes);
  if (!result.ok) throw new Error(result.errors.join("\n"));
}

export function replaceOrbitSpliceSettings(
  scenes: readonly Scene[], sceneId: string, orbitId: string,
  spliceCount: number, spliceStartAngle: number
): Scene[] {
  const normalizedCount = normalizeSpliceCount(spliceCount);
  const proposedIds = impliedSpliceBarIds({ id: orbitId, spliceCount: normalizedCount });
  const proposed = new Set(proposedIds);
  // Pointer-move edits only change one orbit's derived bars. Preflight that namespace
  // before publication instead of revalidating history-independent document state.
  for (const candidateScene of scenes) {
    for (const candidateOrbit of candidateScene.orbits) {
      if (candidateOrbit.id !== orbitId && proposed.has(candidateOrbit.id)) {
        throw new Error(`Reserved ID collision for splice bar "${candidateOrbit.id}".`);
      }
      if (candidateOrbit.id !== orbitId) for (const id of impliedSpliceBarIds(candidateOrbit)) {
        if (proposed.has(id)) throw new Error(`Reserved ID collision for splice bar "${id}".`);
      }
    }
    for (const candidatePlanet of candidateScene.planets) if (proposed.has(candidatePlanet.id)) {
      throw new Error(`Reserved ID collision for splice bar "${candidatePlanet.id}".`);
    }
    for (const candidateBar of candidateScene.bars) {
      if ((candidateBar.source !== "splice" || candidateBar.orbitId !== orbitId) && proposed.has(candidateBar.id)) {
        throw new Error(`Reserved ID collision for splice bar "${candidateBar.id}".`);
      }
    }
    if (proposed.has(candidateScene.id)) {
      throw new Error(`Reserved ID collision for splice bar "${candidateScene.id}".`);
    }
  }
  const next = updateSceneById(scenes, sceneId, (scene) => {
    const orbit = scene.orbits.find((item) => item.id === orbitId);
    if (!orbit) return scene;
    const updated = { ...orbit, spliceCount: normalizedCount, spliceStartAngle };
    return {
      ...scene,
      orbits: scene.orbits.map((item) => item.id === orbitId ? updated : item),
      bars: [...scene.bars.filter((bar) => bar.source !== "splice" || bar.orbitId !== orbitId),
        ...createSpliceBars(updated)]
    };
  });
  return next;
}

function remapSelection(selection: Selection, ids: Map<string, string>): Selection {
  return {
    orbitId: selection.orbitId ? ids.get(selection.orbitId) ?? null : null,
    planetId: selection.planetId ? ids.get(selection.planetId) ?? null : null,
    barId: selection.barId ? ids.get(selection.barId) ?? null : null
  };
}

function remapMultiSelection(selection: MultiSelection, ids: Map<string, string>): MultiSelection {
  return {
    orbitIds: selection.orbitIds.flatMap((id) => ids.get(id) ?? []),
    planetIds: selection.planetIds.flatMap((id) => ids.get(id) ?? [])
  };
}

export type SceneDuplicatePlan = {
  scene: Scene;
  orbitIdMap: ReadonlyMap<string, string>;
};

export function collectSceneIds(scenes: readonly Scene[]): Set<string> {
  const ids = new Set<string>();
  for (const scene of scenes) {
    ids.add(scene.id);
    scene.orbits.forEach((item) => ids.add(item.id));
    scene.planets.forEach((item) => ids.add(item.id));
    scene.bars.forEach((item) => ids.add(item.id));
    scene.orbits.flatMap(impliedSpliceBarIds).forEach((id) => ids.add(id));
  }
  return ids;
}

export function planSceneDuplicate(
  source: Scene,
  options: {
    createId?: IdFactory;
    createOrbitId?: (orbit: Orbit) => string;
    name?: string;
    occupiedIds?: Iterable<string>;
  } = {}
): SceneDuplicatePlan {
  const createId = options.createId ?? defaultIdFactory;
  const occupied = collectSceneIds([source]);
  for (const id of options.occupiedIds ?? []) occupied.add(id);
  const ids = new Map<string, string>();
  const freshId = (oldId: string, derivedIds: (candidate: string) => string[] = () => []) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const next = createId();
      const derived = next ? derivedIds(next) : [];
      if (!next || occupied.has(next) || derived.some((id) => occupied.has(id))) continue;
      occupied.add(next);
      derived.forEach((id) => occupied.add(id));
      ids.set(oldId, next);
      return next;
    }
    throw new Error(`ID factory could not produce a unique ID for "${oldId}".`);
  };
  const sceneId = freshId(source.id);
  const orbits = source.orbits.map((orbit) => {
    if (!options.createOrbitId) return {
      ...orbit,
      id: freshId(orbit.id, (candidate) => impliedSpliceBarIds({ ...orbit, id: candidate }))
    };
    const next = options.createOrbitId(orbit);
    const derived = impliedSpliceBarIds({ ...orbit, id: next });
    if (!next || occupied.has(next) || derived.some((id) => occupied.has(id))) {
      throw new Error(`Orbit ID allocator produced occupied ID "${next}".`);
    }
    occupied.add(next);
    derived.forEach((id) => occupied.add(id));
    ids.set(orbit.id, next);
    return { ...orbit, id: next };
  });
  const planets = source.planets.map((planet) => ({
    ...projectPlanetForHistory(planet),
    id: freshId(planet.id),
    orbitId: ids.get(planet.orbitId) ?? planet.orbitId
  }));
  const manualBars = source.bars.filter((bar) => bar.source !== "splice").map((bar) => ({
    ...bar,
    id: freshId(bar.id),
    orbitId: ids.get(bar.orbitId) ?? bar.orbitId
  }));
  for (const sourceOrbit of source.orbits) {
    const targetOrbitId = ids.get(sourceOrbit.id);
    if (!targetOrbitId) continue;
    const sourceSpliceIds = impliedSpliceBarIds(sourceOrbit);
    const targetOrbit = orbits.find((orbit) => orbit.id === targetOrbitId)!;
    const targetSpliceIds = impliedSpliceBarIds(targetOrbit);
    sourceSpliceIds.forEach((sourceId, index) => {
      if (targetSpliceIds[index]) ids.set(sourceId, targetSpliceIds[index]);
    });
  }
  const scene: Scene = {
    id: sceneId,
    name: options.name ?? `${source.name} Copy`,
    orbits,
    planets,
    bars: [...manualBars, ...orbits.flatMap(createSpliceBars)],
    viewport: { ...source.viewport },
    selection: remapSelection(source.selection, ids),
    multiSelection: remapMultiSelection(source.multiSelection, ids)
  };
  assertValidScenes([scene]);
  return {
    scene,
    orbitIdMap: new Map(source.orbits.map((orbit) => [orbit.id, ids.get(orbit.id)!]))
  };
}

export type AudioDuplicateAdapter = {
  stage(sourceOrbitId: string, targetOrbitId: string): void | Promise<void>;
  rollback(targetOrbitId: string): void | Promise<void>;
};

/** Stages available audio, returning no document state until all copies succeed. */
export async function stageSceneDuplicate(
  source: Scene, plan: SceneDuplicatePlan, audio: AudioDuplicateAdapter
): Promise<Scene> {
  const staged: string[] = [];
  try {
    for (const orbit of source.orbits) {
      if (orbit.isMissingAudio) continue;
      const targetId = plan.orbitIdMap.get(orbit.id);
      if (!targetId) throw new Error(`Duplicate plan has no mapping for orbit "${orbit.id}".`);
      staged.push(targetId);
      await audio.stage(orbit.id, targetId);
    }
    return plan.scene;
  } catch (error) {
    for (const targetId of staged.reverse()) {
      try { await audio.rollback(targetId); } catch { /* Keep the original staging error. */ }
    }
    throw error;
  }
}
