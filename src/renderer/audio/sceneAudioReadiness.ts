import type { ProcessedBufferRequest } from "./audioEngine.ts";
import type { Planet, Scene } from "../state/types.ts";
import { getSampleEnd, getSampleStart } from "../utils/geometry.ts";

export type SceneAudioReadinessTransition = {
  readonly requests: readonly ProcessedBufferRequest[];
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly acquire: () => () => void;
  readonly prewarm: (request: ProcessedBufferRequest, index: number) => Promise<void>;
  readonly hydrate: () => Promise<boolean>;
  readonly publish: () => void;
  readonly reportAudioFailure: (error: unknown) => void;
};

export async function runSceneAudioReadinessTransition(transition: SceneAudioReadinessTransition): Promise<void> {
  const release = transition.acquire();
  try {
    const [_, ownsTarget] = await Promise.all([
      Promise.all(transition.requests.map((request, index) => transition.prewarm(request, index))),
      transition.hydrate().catch(() => true)
    ]);
    if (!ownsTarget || transition.signal.aborted || !transition.isCurrent()) return;
    transition.publish();
  } catch (error) {
    if (!transition.signal.aborted && transition.isCurrent()) transition.reportAudioFailure(error);
  } finally {
    release();
  }
}

export function applyPlanetMotionUpdates(
  scene: Scene, updates: ReadonlyMap<string, Partial<Planet>>
): Scene {
  if (updates.size === 0) return scene;
  let changed = false;
  const planets = scene.planets.map((planet) => {
    const update = updates.get(planet.id);
    if (!update) return planet;
    changed = true;
    return { ...planet, ...update };
  });
  return changed ? { ...scene, planets } : scene;
}

export function collectSceneAudioRequests(scene: Scene): ProcessedBufferRequest[] {
  const orbitsById = new Map(scene.orbits.map((orbit) => [orbit.id, orbit]));
  const requests: ProcessedBufferRequest[] = [];

  for (const planet of scene.planets) {
    const orbit = orbitsById.get(planet.orbitId);
    if (!orbit) continue;

    const speed = orbit.mode === "sequence" ? 1 : planet.speed;
    const pitchCents = Math.round(planet.pitchCents);
    const direction = planet.direction === -1 ? "reverse" : "forward";
    const isNeutralForward = direction === "forward" && speed === 1 && pitchCents === 0;
    if (isNeutralForward) continue;

    requests.push({
      orbitId: orbit.id,
      planetId: planet.id,
      speed,
      pitchCents,
      sampleStart: getSampleStart(orbit),
      sampleEnd: getSampleEnd(orbit),
      direction
    });
  }

  return requests;
}
