import type { SetStateAction } from "react";
import type { DspRenderPriority, ProcessedBufferRequest } from "../audio/audioEngine";
import { updatePlanetForFreshRequest } from "../state/scenes";
import type { Planet, Scene } from "../state/types";
import { getSampleEnd, getSampleStart } from "../utils/geometry";

// Mirrors App.tsx's cleanPlanet: clears only the speed-processing transients so an
// in-flight preview never leaks into a committed planet.
const clearSpeedProcessing = (planet: Planet): Planet => ({
  ...planet,
  pendingSpeed: undefined,
  isSpeedProcessing: false,
  processingSpeed: undefined,
  speedProcessRequestId: undefined
});

const clearPitchProcessing = (planet: Planet): Planet => ({
  ...planet,
  pendingPitchCents: undefined,
  isPitchProcessing: false,
  processingPitchCents: undefined,
  pitchProcessRequestId: undefined
});

/** The slice of App's stateRef this hook reads synchronously (never a stale render's value). */
export type SpeedPitchStateSnapshot = {
  scenes: Scene[];
  activeSceneId: string;
  planets: Planet[];
};

export type SpeedPitchAudioEngine = {
  hasProcessedBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart?: number, sampleEnd?: number): boolean;
  ensureProcessedBuffer(request: ProcessedBufferRequest, options: {
    ownerId: string;
    priority: DspRenderPriority;
    signal: AbortSignal;
  }): Promise<void>;
};

export type UseSpeedPitchProcessingDeps = {
  stateRef: { current: SpeedPitchStateSnapshot };
  setPlanets: (action: SetStateAction<Planet[]>) => void;
  setScenes: (action: SetStateAction<Scene[]>) => void;
  pushHistory: () => void;
  flash: (text: string, duration?: number) => void;
  audioEngine: SpeedPitchAudioEngine;
  randomId: () => string;
  clamp: (value: number, min: number, max: number) => number;
  minDirectRate: number;
  maxDirectRate: number;
  startRenderOwner: (ownerId: string) => AbortController;
  releaseRenderOwner: (ownerId: string, controller: AbortController) => void;
};

/**
 * The SoundTouch speed/pitch preview+commit pipeline lifted out of App.tsx. This only
 * orchestrates React state around owner-scoped DSP requests; the actual DSP transform
 * lives in audioEngine.ts (pinned by a dedicated test in test/audioEngine.test.ts).
 */
export function useSpeedPitchProcessing(deps: UseSpeedPitchProcessingDeps) {
  const { stateRef, setPlanets, setScenes, pushHistory, flash, audioEngine, randomId, clamp, minDirectRate, maxDirectRate, startRenderOwner, releaseRenderOwner } = deps;
  const startEdit = (sceneId: string, orbitId: string, planetId: string) => {
    const ownerId = `edit:${sceneId}:${orbitId}:${planetId}`;
    return { ownerId, controller: startRenderOwner(ownerId) };
  };
  const ensureSelected = (
    orbitId: string, planetId: string, speed: number, pitchCents: number,
    sampleStart: number, sampleEnd: number, ownerId: string, signal: AbortSignal
  ) => audioEngine.ensureProcessedBuffer({
    orbitId, planetId, speed, pitchCents, sampleStart, sampleEnd, direction: "forward"
  }, { ownerId, priority: "selected", signal });
  const isAbortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
  const sampleWindow = (orbitId: string) => {
    const orbit = stateRef.current.scenes.find((scene) => scene.id === stateRef.current.activeSceneId)?.orbits.find((item) => item.id === orbitId);
    return orbit ? [getSampleStart(orbit), getSampleEnd(orbit)] as const : [0, Infinity] as const;
  };

  function previewPlanetSpeed(planetId: string, pendingSpeed: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingSpeed, speedProcessingError: undefined } : planet));
  }

  async function commitPlanetSpeed(planetId: string, requestedSpeed?: number) {
    const sceneId = stateRef.current.activeSceneId;
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const speed = clamp(requestedSpeed ?? planet.pendingSpeed ?? planet.speed, minDirectRate, maxDirectRate);
    const pitchAtRequest = planet.pitchCents;
    if (planet.isSpeedProcessing && planet.processingSpeed === speed) return;
    if (Math.abs(speed - planet.speed) < .0001 && !planet.isSpeedProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingSpeed: undefined, speedProcessingError: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = randomId();
    const [sampleStart, sampleEnd] = sampleWindow(planet.orbitId);
    if (audioEngine.hasProcessedBuffer(planet.orbitId, planet.id, speed, planet.pitchCents, sampleStart, sampleEnd)) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearSpeedProcessing(item), speed, speedProcessingError: undefined } : item));
      return;
    }
    const { ownerId, controller } = startEdit(sceneId, planet.orbitId, planetId);
    setPlanets((current) => current.map((item) => item.id === planetId ? {
      ...item,
      pendingSpeed: speed,
      isSpeedProcessing: true,
      processingSpeed: speed,
      speedProcessRequestId: requestId,
      speedProcessingError: undefined
    } : item));
    try {
      await ensureSelected(planet.orbitId, planet.id, speed, pitchAtRequest, sampleStart, sampleEnd, ownerId, controller.signal);
      let latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.speedProcessRequestId !== requestId) return;
      if (latest.pitchCents !== pitchAtRequest) {
        const [latestStart, latestEnd] = sampleWindow(latest.orbitId);
        await ensureSelected(latest.orbitId, latest.id, speed, latest.pitchCents, latestStart, latestEnd, ownerId, controller.signal);
        latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
          ?.planets.find((item) => item.id === planetId);
        if (latest?.speedProcessRequestId !== requestId) return;
      }
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "speed", requestId,
        (item) => ({ ...clearSpeedProcessing(item), speed, speedProcessingError: undefined })
      ));
    } catch (error) {
      if (isAbortError(error)) return;
      const latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.speedProcessRequestId !== requestId) return;
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "speed", requestId,
        (item) => ({ ...clearSpeedProcessing(item), speedProcessingError: "Speed processing failed" })
      ));
      flash("Speed processing failed; the previous speed remains active.");
    } finally {
      releaseRenderOwner(ownerId, controller);
    }
  }

  function previewPlanetPitch(planetId: string, pendingPitchCents: number) {
    setPlanets((current) => current.map((planet) =>
      planet.id === planetId ? { ...planet, pendingPitchCents } : planet));
  }

  async function commitPlanetPitch(planetId: string, requestedPitch?: number) {
    const sceneId = stateRef.current.activeSceneId;
    const planet = stateRef.current.planets.find((item) => item.id === planetId);
    if (!planet) return;
    const pitchCents = clamp(requestedPitch ?? planet.pendingPitchCents ?? planet.pitchCents, -4800, 4800);
    const speedAtRequest = planet.speed;
    if (planet.isPitchProcessing && planet.processingPitchCents === pitchCents) return;
    if (pitchCents === planet.pitchCents && !planet.isPitchProcessing) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...item, pendingPitchCents: undefined } : item));
      return;
    }
    pushHistory();
    const requestId = randomId();
    const [sampleStart, sampleEnd] = sampleWindow(planet.orbitId);
    if (audioEngine.hasProcessedBuffer(planet.orbitId, planet.id, planet.speed, pitchCents, sampleStart, sampleEnd)) {
      setPlanets((current) => current.map((item) =>
        item.id === planetId ? { ...clearPitchProcessing(item), pitchCents } : item));
      return;
    }
    const { ownerId, controller } = startEdit(sceneId, planet.orbitId, planetId);
    setPlanets((current) => current.map((item) => item.id === planetId ? {
      ...item, pendingPitchCents: pitchCents, isPitchProcessing: true,
      processingPitchCents: pitchCents, pitchProcessRequestId: requestId
    } : item));
    try {
      await ensureSelected(planet.orbitId, planet.id, speedAtRequest, pitchCents, sampleStart, sampleEnd, ownerId, controller.signal);
      let latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      if (latest.speed !== speedAtRequest) {
        const [latestStart, latestEnd] = sampleWindow(latest.orbitId);
        await ensureSelected(latest.orbitId, latest.id, latest.speed, pitchCents, latestStart, latestEnd, ownerId, controller.signal);
        latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
          ?.planets.find((item) => item.id === planetId);
        if (latest?.pitchProcessRequestId !== requestId) return;
      }
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "pitch", requestId,
        (item) => ({ ...clearPitchProcessing(item), pitchCents })
      ));
    } catch (error) {
      if (isAbortError(error)) return;
      const latest = stateRef.current.scenes.find((scene) => scene.id === sceneId)
        ?.planets.find((item) => item.id === planetId);
      if (latest?.pitchProcessRequestId !== requestId) return;
      setScenes((current) => updatePlanetForFreshRequest(
        current, sceneId, planetId, "pitch", requestId, clearPitchProcessing
      ));
      flash("Pitch processing failed; the previous pitch remains active.");
    } finally {
      releaseRenderOwner(ownerId, controller);
    }
  }

  return { previewPlanetSpeed, commitPlanetSpeed, previewPlanetPitch, commitPlanetPitch };
}
