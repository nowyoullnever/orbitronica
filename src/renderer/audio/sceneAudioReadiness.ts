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
  // Optional: called with the requests that failed to prewarm when the transition still
  // published despite one or more individual render failures (see below). A request whose
  // failure is an AbortError (the scene switched away mid-render) is never reported here.
  readonly reportPartialAudioFailure?: (
    failedRequests: readonly ProcessedBufferRequest[], errors: readonly unknown[]
  ) => void;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function runSceneAudioReadinessTransition(transition: SceneAudioReadinessTransition): Promise<void> {
  const release = transition.acquire();
  try {
    // Prewarms are settled individually (not Promise.all) so a single planet's render
    // failure can never veto the whole scene's publish -- otherwise one bad artifact
    // would leave audibleSceneId null and mute every other planet in the scene forever.
    const [prewarmResults, ownsTarget] = await Promise.all([
      Promise.allSettled(transition.requests.map((request, index) => transition.prewarm(request, index))),
      transition.hydrate().catch(() => true)
    ]);
    if (transition.signal.aborted || !transition.isCurrent()) return;
    if (!ownsTarget) return;
    transition.publish();
    const failures = prewarmResults.flatMap((result, index) =>
      result.status === "rejected" ? [{ request: transition.requests[index], error: result.reason }] : []
    ).filter(({ error }) => !isAbortError(error));
    if (failures.length) {
      transition.reportPartialAudioFailure?.(
        failures.map(({ request }) => request), failures.map(({ error }) => error)
      );
    }
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
