import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlanetMotionUpdates,
  collectSceneAudioRequests,
  runSceneAudioReadinessTransition
} from "../src/renderer/audio/sceneAudioReadiness.ts";
import type { Orbit, Planet, Scene } from "../src/renderer/state/types.ts";

const orbit = (overrides: Partial<Orbit> = {}): Orbit => ({
  id: "orbit-1",
  name: "Orbit",
  audioName: "sample.wav",
  x: 0,
  y: 0,
  radiusX: 100,
  radiusY: 100,
  initialRadiusX: 100,
  initialRadiusY: 100,
  audioDuration: 12,
  mode: "loop",
  volume: 1,
  audioPan: 0,
  isPaused: false,
  isMuted: false,
  isSolo: false,
  sequenceRetriggerMode: "overlap",
  ...overrides
});

const planet = (overrides: Partial<Planet> = {}): Planet => ({
  id: "planet-1",
  orbitId: "orbit-1",
  angle: 0,
  speed: 1,
  volume: 1,
  audioPan: 0,
  pitchCents: 0,
  isActive: true,
  direction: 1,
  collisionSpeedMultiplier: 1,
  collisionFlashRemaining: 0,
  ...overrides
});

const scene = (orbits: Orbit[], planets: Planet[]): Scene => ({
  id: "scene-1",
  name: "Scene",
  orbits,
  planets,
  bars: [],
  viewport: { zoom: 1, offsetX: 0, offsetY: 0 },
  selection: { orbitId: null, planetId: null, barId: null },
  multiSelection: { orbitIds: [], planetIds: [] }
});

test("scene audio requirements collect semantic loop and sequence requests", () => {
  const requests = collectSceneAudioRequests(scene([
    orbit({ id: "loop", sampleStart: 1.25, sampleEnd: 4.75 }),
    orbit({ id: "sequence", mode: "sequence", sampleStart: 2, sampleEnd: 8 })
  ], [
    planet({ id: "loop-planet", orbitId: "loop", speed: 1.5, pitchCents: 37 }),
    planet({ id: "sequence-planet", orbitId: "sequence", speed: .5, pitchCents: -12 })
  ]));

  assert.deepEqual(requests, [
    {
      orbitId: "loop",
      planetId: "loop-planet",
      speed: 1.5,
      pitchCents: 37,
      sampleStart: 1.25,
      sampleEnd: 4.75,
      direction: "forward"
    },
    {
      orbitId: "sequence",
      planetId: "sequence-planet",
      speed: 1,
      pitchCents: -12,
      sampleStart: 2,
      sampleEnd: 8,
      direction: "forward"
    }
  ]);
});

test("scene audio requirements retain reverse neutral and processed requests but exclude only neutral forward", () => {
  const requests = collectSceneAudioRequests(scene([
    orbit({ id: "full" }),
    orbit({ id: "trimmed", sampleStart: 2.5, sampleEnd: 7.25 })
  ], [
    planet({ id: "skip", orbitId: "full", speed: 1, pitchCents: 0, direction: 1 }),
    planet({ id: "neutral-reverse", orbitId: "full", speed: 1, pitchCents: 0, direction: -1 }),
    planet({ id: "processed-reverse", orbitId: "trimmed", speed: 1.25, pitchCents: 80, direction: -1 })
  ]));

  assert.deepEqual(requests, [
    {
      orbitId: "full",
      planetId: "neutral-reverse",
      speed: 1,
      pitchCents: 0,
      sampleStart: 0,
      sampleEnd: 12,
      direction: "reverse"
    },
    {
      orbitId: "trimmed",
      planetId: "processed-reverse",
      speed: 1.25,
      pitchCents: 80,
      sampleStart: 2.5,
      sampleEnd: 7.25,
      direction: "reverse"
    }
  ]);
});

test("scene audio requirements include committed muted, paused, and inactive planets without mutating the scene", () => {
  const committed = scene([
    orbit({ id: "audibility-does-not-matter", isMuted: true, isPaused: true, isSolo: true })
  ], [
    planet({
      orbitId: "audibility-does-not-matter",
      isActive: false,
      speed: 1.2,
      pitchCents: 20,
      direction: -1
    })
  ]);
  const before = structuredClone(committed);

  assert.deepEqual(collectSceneAudioRequests(committed), [{
    orbitId: "audibility-does-not-matter",
    planetId: "planet-1",
    speed: 1.2,
    pitchCents: 20,
    sampleStart: 0,
    sampleEnd: 12,
    direction: "reverse"
  }]);
  assert.deepEqual(committed, before);
});

test("scene audio requirements clamp malformed committed sample windows and ignore orphan planets", () => {
  const requests = collectSceneAudioRequests(scene([
    orbit({ id: "clamped", audioDuration: 3, sampleStart: -5, sampleEnd: 99 })
  ], [
    planet({ id: "valid", orbitId: "clamped", speed: 2, pitchCents: 10 }),
    planet({ id: "orphan", orbitId: "missing", speed: 2, pitchCents: 10 })
  ]));

  assert.deepEqual(requests, [{
    orbitId: "clamped",
    planetId: "valid",
    speed: 2,
    pitchCents: 10,
    sampleStart: 0,
    sampleEnd: 3,
    direction: "forward"
  }]);
});

test("scene audio requirements round pitch before neutral-forward exclusion", () => {
  const requests = collectSceneAudioRequests(scene([orbit()], [
    planet({ id: "rounded-neutral", pitchCents: .4 }),
    planet({ id: "rounded-processed", pitchCents: .6 })
  ]));

  assert.deepEqual(requests, [{
    orbitId: "orbit-1",
    planetId: "rounded-processed",
    speed: 1,
    pitchCents: 1,
    sampleStart: 0,
    sampleEnd: 12,
    direction: "forward"
  }]);
});

test("collision direction updates produce an immutable reverse-ready scene request", () => {
  const committed = scene([orbit({ sampleStart: 1, sampleEnd: 5 })], [
    planet({ speed: 1.25, pitchCents: 40, direction: 1 })
  ]);
  const next = applyPlanetMotionUpdates(committed, new Map([
    ["planet-1", { direction: -1 }]
  ]));

  assert.notEqual(next, committed);
  assert.equal(committed.planets[0].direction, 1);
  assert.deepEqual(collectSceneAudioRequests(next), [{
    orbitId: "orbit-1",
    planetId: "planet-1",
    speed: 1.25,
    pitchCents: 40,
    sampleStart: 1,
    sampleEnd: 5,
    direction: "reverse"
  }]);
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const readinessRequest = {
  orbitId: "orbit-1",
  planetId: "planet-1",
  speed: 1.25,
  pitchCents: 100,
  sampleStart: 0,
  sampleEnd: 12,
  direction: "forward" as const
};

test("scene preflight acquires before enqueue and atomically publishes after audio plus WAM", async () => {
  const controller = new AbortController();
  const audio = deferred<void>();
  const wam = deferred<boolean>();
  const calls: string[] = [];
  const transition = runSceneAudioReadinessTransition({
    requests: [readinessRequest],
    signal: controller.signal,
    isCurrent: () => true,
    acquire: () => {
      calls.push("acquire");
      return () => calls.push("release");
    },
    prewarm: () => {
      calls.push("prewarm");
      return audio.promise;
    },
    hydrate: () => {
      calls.push("hydrate");
      return wam.promise;
    },
    publish: () => calls.push("publish"),
    reportAudioFailure: () => calls.push("failure")
  });

  assert.deepEqual(calls, ["acquire", "prewarm", "hydrate"]);
  audio.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["acquire", "prewarm", "hydrate"]);
  wam.resolve(true);
  await transition;
  assert.deepEqual(calls, ["acquire", "prewarm", "hydrate", "publish", "release"]);
});

test("scene preflight never lets stale or failed audio publish and always releases the target pin", async () => {
  const staleController = new AbortController();
  const staleAudio = deferred<void>();
  const staleWam = deferred<boolean>();
  const staleCalls: string[] = [];
  const stale = runSceneAudioReadinessTransition({
    requests: [readinessRequest],
    signal: staleController.signal,
    isCurrent: () => false,
    acquire: () => () => staleCalls.push("release"),
    prewarm: () => staleAudio.promise,
    hydrate: () => staleWam.promise,
    publish: () => staleCalls.push("publish"),
    reportAudioFailure: () => staleCalls.push("failure")
  });
  staleAudio.resolve();
  staleWam.resolve(true);
  await stale;
  assert.deepEqual(staleCalls, ["release"]);

  const failedController = new AbortController();
  const failedCalls: string[] = [];
  await runSceneAudioReadinessTransition({
    requests: [readinessRequest],
    signal: failedController.signal,
    isCurrent: () => true,
    acquire: () => () => failedCalls.push("release"),
    prewarm: () => Promise.reject(new Error("render failed")),
    hydrate: () => Promise.resolve(true),
    publish: () => failedCalls.push("publish"),
    reportAudioFailure: () => failedCalls.push("failure")
  });
  assert.deepEqual(failedCalls, ["failure", "release"]);
});

test("scene preflight treats WAM failure as dry-ready after exact audio succeeds", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await runSceneAudioReadinessTransition({
    requests: [readinessRequest],
    signal: controller.signal,
    isCurrent: () => true,
    acquire: () => () => calls.push("release"),
    prewarm: () => Promise.resolve(),
    hydrate: () => Promise.reject(new Error("unavailable WAM")),
    publish: () => calls.push("publish"),
    reportAudioFailure: () => calls.push("failure")
  });
  assert.deepEqual(calls, ["publish", "release"]);
});

test("deferred scene transitions keep selection synchronous, reject stale publish, retain old pins, and retry in place", async () => {
  let active = "A";
  let audible: string | null = "A";
  let permanent = "A";
  let epoch = 0;
  let selectionChanges = 0;
  const releases: string[] = [];
  const failures: string[] = [];
  const begin = (target: string, audio: Promise<void>, wam: Promise<boolean>) => {
    if (target !== active) {
      active = target;
      selectionChanges++;
    }
    audible = null;
    const controller = new AbortController();
    const currentEpoch = ++epoch;
    const done = runSceneAudioReadinessTransition({
      requests: [readinessRequest],
      signal: controller.signal,
      isCurrent: () => currentEpoch === epoch,
      acquire: () => () => releases.push(target),
      prewarm: () => audio,
      hydrate: () => wam,
      publish: () => {
        permanent = target;
        audible = target;
      },
      reportAudioFailure: (error) => failures.push(error instanceof Error ? error.message : String(error))
    });
    return { controller, done };
  };

  const bAudio = deferred<void>();
  const bWam = deferred<boolean>();
  const b = begin("B", bAudio.promise, bWam.promise);
  assert.deepEqual({ active, audible, permanent, selectionChanges }, {
    active: "B", audible: null, permanent: "A", selectionChanges: 1
  });

  const c = begin("C", Promise.reject(new Error("C audio failed")), Promise.resolve(true));
  b.controller.abort();
  bAudio.resolve();
  bWam.resolve(true);
  await Promise.all([b.done, c.done]);
  assert.deepEqual({ active, audible, permanent, selectionChanges, failures }, {
    active: "C", audible: null, permanent: "A", selectionChanges: 2, failures: ["C audio failed"]
  });

  const retryAudio = deferred<void>();
  const retryWam = deferred<boolean>();
  const retry = begin("C", retryAudio.promise, retryWam.promise);
  assert.equal(selectionChanges, 2);
  retryAudio.resolve();
  await Promise.resolve();
  assert.deepEqual({ audible, permanent }, { audible: null, permanent: "A" });
  retryWam.resolve(true);
  await retry.done;
  assert.deepEqual({ active, audible, permanent, selectionChanges, releases }, {
    active: "C", audible: "C", permanent: "C", selectionChanges: 2, releases: ["C", "B", "C"]
  });
});
