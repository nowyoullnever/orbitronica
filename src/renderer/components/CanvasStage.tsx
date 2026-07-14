import { useEffect, useMemo, useRef } from "react";
import type { ContextMenuState, MultiSelection, Orbit, Planet, Selection, Tool, TriggerBar, ViewportState } from "../state/types";
import { stepPhysics, type PlaybackCallback } from "../state/physics.ts";
import { clampViewport as clampViewportPure } from "./canvas/viewport.ts";
import { createCanvasRenderer, type WaveformGeometry } from "./canvas/canvasRenderer.ts";
import { useCanvasInput } from "../hooks/useCanvasInput.ts";

export type Props = {
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  waveformPeaksByOrbit: ReadonlyMap<string, Float32Array>;
  selection: Selection;
  multiSelection: MultiSelection;
  selectedTool: Tool;
  isPlaying: boolean;
  sceneId: string;
  playbackEpoch: number;
  isDragOver: boolean;
  cancelSignal: number;
  viewport: ViewportState;
  onViewportChange: (viewport: ViewportState) => void;
  onSelect: (selection: Selection) => void;
  onMarqueeSelect: (orbitIds: string[], planetIds: string[]) => void;
  onAddPlanet: (orbitId: string, angle: number) => void;
  onAddBar: (orbitId: string, angle: number) => void;
  onMovePlanets: (updates: Map<string, Partial<Planet>>) => void;
  onLoopFrame: (orbit: Orbit, planet: Planet, bar: TriggerBar, inside: boolean, angle: number, callback: PlaybackCallback) => void;
  onSequencePlay: (orbit: Orbit, planet: Planet, bar: TriggerBar, callback: PlaybackCallback) => void;
  onSequenceStop: (orbitId: string, callback: PlaybackCallback) => void;
  onContextMenu: (menu: ContextMenuState) => void;
  onBeginMutation: () => void;
  onResizeOrbit: (orbitId: string, radiusX: number, radiusY: number) => void;
  onMoveOrbit: (orbitId: string, x: number, y: number) => void;
  onEditBar: (barId: string, angle: number, lengthRadians: number, startAngle: number) => void;
  onBarLengthEditEnd: (barId: string, lengthRadians: number) => void;
  onSetSpliceCount: (orbitId: string, count: number) => void;
  onSetSpliceStart: (orbitId: string, angle: number) => void;
  onDropFiles: (files: File[], point: { x: number; y: number }) => void;
  onDragState: (over: boolean) => void;
};

export function CanvasStage(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const triggerStates = useRef(new Map<string, boolean>());
  const runtimeAngles = useRef(new Map<string, number>());
  const runtimeUnwrappedAngles = useRef(new Map<string, number>());
  const collisionPairCooldowns = useRef(new Map<string, number>());
  // Bookkeeping for stepPhysics's throttled angle commits (see physics.ts): the last
  // angle value pushed into React state per planet, and seconds accumulated since the
  // last periodic sync while playing.
  const lastSyncedAngles = useRef(new Map<string, number>());
  const angleSyncElapsed = useRef({ value: 0 });
  const waveformGeometryCache = useRef(new Map<string, WaveformGeometry>());
  const stateRef = useRef(props);
  const multiSelectionSets = useMemo(() => ({
    orbitIds: new Set(props.multiSelection.orbitIds),
    planetIds: new Set(props.multiSelection.planetIds)
  }), [props.multiSelection.orbitIds, props.multiSelection.planetIds]);
  const multiSelectionSetsRef = useRef(multiSelectionSets);
  // Live marquee rectangle (world coords), read by the render loop each frame.
  const marqueeRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  // Dirty flag for the rAF draw loop: while paused/idle, redraw only when something
  // actually changed (props, a physics-tick commit, or a pointer interaction) instead of
  // clearing+redrawing an unchanged frame every 16ms. While playing with any active
  // planet, the draw loop ignores this and redraws unconditionally regardless (motion
  // comes from the runtimeAngles ref, which updates every 10ms independent of React
  // renders, so a dirty flag driven only by renders/commits could under-redraw mid-motion).
  const needsRedrawRef = useRef(true);
  stateRef.current = props;
  // Every render means some prop changed (viewport, selection, waveform peaks, planets/
  // orbits/bars, tool, ...) -- simplest correct trigger, matching the spec's own note.
  needsRedrawRef.current = true;
  multiSelectionSetsRef.current = multiSelectionSets;

  const {
    handleMouseDown, handleMouseMove, handleClick, finishDrag, cursorFor, hitTestCanvas, screenToWorld, localPoint
  } = useCanvasInput(props, { canvasRef, stateRef, runtimeAngles: runtimeAngles.current, needsRedrawRef, marqueeRef });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext("2d")!;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      props.onViewportChange(clampViewportPure(stateRef.current.viewport, canvasRef.current));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const renderer = createCanvasRenderer({
      waveformGeometryCache: waveformGeometryCache.current,
      runtimeAngles: runtimeAngles.current
    });
    const draw = () => {
      const state = stateRef.current;
      // While actively playing with at least one active planet, motion is continuous
      // (driven by the runtimeAngles ref, updated every 10ms tick independent of React
      // renders) so always redraw. Otherwise, skip the clear+redraw entirely when
      // nothing has flagged a change since the last frame -- keeps the rAF loop alive
      // (for responsiveness the instant something does change) without doing real work
      // on an unchanged scene.
      const isAnimating = state.isPlaying && state.planets.some((planet) => planet.isActive);
      if (!isAnimating && !needsRedrawRef.current) {
        frameRef.current = requestAnimationFrame(draw);
        return;
      }
      needsRedrawRef.current = false;
      const canvas = canvasRef.current!;
      const context = canvas.getContext("2d")!;
      const rect = canvas.getBoundingClientRect();
      renderer.draw(
        context, rect, state,
        multiSelectionSetsRef.current.orbitIds, multiSelectionSetsRef.current.planetIds,
        marqueeRef.current
      );
      frameRef.current = requestAnimationFrame(draw);
    };
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  useEffect(() => {
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = (now - lastTick) / 1000;
      lastTick = now;
      const state = stateRef.current;
      const result = stepPhysics({
        orbits: state.orbits, planets: state.planets, bars: state.bars,
        isPlaying: state.isPlaying, sceneId: state.sceneId, playbackEpoch: state.playbackEpoch,
        delta,
        runtimeAngles: runtimeAngles.current,
        runtimeUnwrappedAngles: runtimeUnwrappedAngles.current,
        collisionPairCooldowns: collisionPairCooldowns.current,
        triggerStates: triggerStates.current,
        lastSyncedAngles: lastSyncedAngles.current,
        angleSyncElapsed: angleSyncElapsed.current,
        onLoopFrame: state.onLoopFrame,
        onSequencePlay: state.onSequencePlay,
        onSequenceStop: state.onSequenceStop
      });
      if (result.updates.size) state.onMovePlanets(result.updates);
      // Flag a redraw for any tick that advanced motion or produced a commit, so the
      // rAF loop doesn't need to wait on a React re-render round-trip to notice (motion
      // itself is read from the runtimeAngles ref, not props, by the draw loop above).
      if (result.updates.size > 0 || (state.isPlaying && state.planets.some((planet) => planet.isActive))) {
        needsRedrawRef.current = true;
      }
    }, 10);
    return () => {
      window.clearInterval(timer);
      collisionPairCooldowns.current.clear();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`stage tool-${props.selectedTool} ${props.isDragOver ? "drag-over" : ""}`}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={(event) => {
        finishDrag();
        const point = screenToWorld(localPoint(event));
        event.currentTarget.style.cursor = cursorFor(hitTestCanvas(point.x, point.y), point.x, point.y, null);
      }}
      onMouseLeave={finishDrag}
      onContextMenu={(event) => {
        event.preventDefault();
        const point = screenToWorld(localPoint(event));
        const hit = hitTestCanvas(point.x, point.y);
        const orbitId = hit.type === "empty" ? null : hit.orbitId;
        const planetId = hit.type === "planet" ? hit.planetId : null;
        props.onContextMenu({
          x: event.clientX, y: event.clientY, canvasX: point.x, canvasY: point.y, orbitId, planetId
        });
        if (planetId && orbitId) props.onSelect({ orbitId, planetId, barId: null });
        else if (orbitId) props.onSelect({ orbitId, planetId: null, barId: null });
      }}
      onDragEnter={(event) => { event.preventDefault(); props.onDragState(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) props.onDragState(false); }}
      onDrop={(event) => {
        event.preventDefault(); props.onDragState(false);
        props.onDropFiles(Array.from(event.dataTransfer.files), screenToWorld(localPoint(event)));
      }}
    />
  );
}
