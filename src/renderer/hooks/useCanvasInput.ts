// Pointer/wheel/keyboard input handling extracted from CanvasStage: the Drag state
// union, marquee selection, splice-handle hit-testing, cursor selection, and the
// mouse/wheel/keyboard event handlers that drive them. Not pure (owns React state for
// the in-progress drag and calls back into props on every edit), but self-contained --
// it closes only over the refs CanvasStage still owns (canvasRef, the latest-props ref,
// the runtime angle map, the redraw dirty flag, and the live marquee ref the draw loop
// reads) plus the props object for the current render, exactly like the handlers did
// when they lived directly in CanvasStage's function body.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Orbit, TriggerBar, ViewportState } from "../state/types";
import { angularDistance } from "../utils/triggerDetection.ts";
import { collectMarqueeSelection } from "../utils/selection.ts";
import { ellipsePoint, findNearestOrbit, normalizeAngle, orbitAngleAtPoint } from "../utils/geometry.ts";
import { hitTestCanvas as hitTestCanvasPure, type HitTestResult } from "../utils/canvasHitTest.ts";
import {
  clamp, clampBarLength, clampViewport as clampViewportPure, DEFAULT_WORLD_HEIGHT, DEFAULT_WORLD_WIDTH,
  getDynamicMinZoom as getDynamicMinZoomPure, MAX_VIEWPORT_ZOOM, screenToWorld as screenToWorldPure, unwrapLength
} from "../components/canvas/viewport.ts";
import {
  SPLICE_HANDLE_MARGIN, SPLICE_START_MARKER_OFFSET, SPLICE_STEP_PIXELS, SPLICE_TRACK_HALF
} from "../components/canvas/canvasRenderer.ts";
import type { Props } from "../components/CanvasStage.tsx";

// Marquee modifier: Cmd on macOS, Ctrl elsewhere. Using Ctrl on macOS would also fire
// the context menu, so we key off the platform's primary command modifier instead.
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const MIN_RADIUS = 40;
const MAX_RADIUS = 1000;
const SPLICE_HANDLE_HIT = 13;
// Grab radius for the splice start-point arrow marker.
const SPLICE_START_HIT = 12;

type Drag =
  | { type: "resize-orbit"; orbit: Orbit }
  | { type: "move-orbit"; orbit: Orbit; startX: number; startY: number }
  | { type: "bar-start" | "bar-end"; bar: TriggerBar; orbit: Orbit; fixedAngle: number; mutated: boolean; acc?: number; prevRaw?: number }
  | { type: "move-bar"; bar: TriggerBar; orbit: Orbit; mutated: boolean }
  | { type: "splice"; orbit: Orbit }
  | { type: "splice-start"; orbit: Orbit }
  | { type: "marquee"; sx: number; sy: number; x: number; y: number }
  | { type: "pan-viewport"; startX: number; startY: number; viewport: ViewportState };

export type CanvasInputDeps = {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  // Latest props, kept in sync by CanvasStage every render (see its stateRef comment).
  stateRef: MutableRefObject<Props>;
  // Mutated by the physics tick, read here so hit-testing matches what's actually drawn
  // (see canvasHitTest.ts's resolveAngle and physics.ts's throttled commit contract).
  runtimeAngles: Map<string, number>;
  needsRedrawRef: MutableRefObject<boolean>;
  // Live marquee rectangle (world coords), read by the draw loop every frame.
  marqueeRef: MutableRefObject<{ sx: number; sy: number; x: number; y: number } | null>;
};

export function useCanvasInput(props: Props, deps: CanvasInputDeps) {
  const { canvasRef, stateRef, runtimeAngles, needsRedrawRef, marqueeRef } = deps;
  const [drag, setDrag] = useState<Drag | null>(null);
  // Set when a bar-tool drag begins so the trailing click doesn't also place a new bar.
  const suppressClickRef = useRef(false);

  function getDynamicMinZoom() {
    return getDynamicMinZoomPure(canvasRef.current);
  }

  function clampViewport(viewport: ViewportState) {
    return clampViewportPure(viewport, canvasRef.current);
  }

  function screenToWorld(point: { x: number; y: number }, viewport = stateRef.current.viewport) {
    return screenToWorldPure(point, viewport);
  }

  function zoomViewportAtLocalPoint(localX: number, localY: number, factor: number) {
    const viewport = stateRef.current.viewport;
    const oldZoom = viewport.zoom;
    const newZoom = clamp(oldZoom * factor, getDynamicMinZoom(), MAX_VIEWPORT_ZOOM);
    if (Math.abs(newZoom - oldZoom) < .0001) return;
    const worldX = (localX - viewport.offsetX) / oldZoom;
    const worldY = (localY - viewport.offsetY) / oldZoom;
    props.onViewportChange(clampViewport({
      zoom: newZoom,
      offsetX: localX - worldX * newZoom,
      offsetY: localY - worldY * newZoom
    }));
  }

  function zoomViewportAtCanvasCenter(factor: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomViewportAtLocalPoint(rect.width / 2, rect.height / 2, factor);
  }

  function resetViewportZoom() {
    props.onViewportChange(clampViewport({ zoom: 1, offsetX: 0, offsetY: 0 }));
  }

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomViewportAtLocalPoint(localX, localY, event.deltaY < 0 ? 1.1 : .9);
        return;
      }
      event.preventDefault();
      const viewport = stateRef.current.viewport;
      props.onViewportChange(clampViewport({
        ...viewport,
        offsetX: viewport.offsetX - event.deltaX,
        offsetY: viewport.offsetY - event.deltaY
      }));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.matches("input, select, textarea") || target.isContentEditable);
      if (typing) return;
      const command = event.ctrlKey || event.metaKey;
      if (!command) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomViewportAtCanvasCenter(1.1);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomViewportAtCanvasCenter(.9);
      } else if (event.key === "0") {
        event.preventDefault();
        resetViewportZoom();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    setDrag(null);
    marqueeRef.current = null;
  }, [props.cancelSignal]);

  const spliceTrackX = (orbit: Orbit) => orbit.x + orbit.radiusX + SPLICE_HANDLE_MARGIN;
  const spliceCountFromWorldY = (orbit: Orbit, worldY: number) =>
    Math.round((orbit.y - worldY) / SPLICE_STEP_PIXELS) * 2;

  function orbitAtSpliceHandle(x: number, y: number) {
    const zoom = stateRef.current.viewport.zoom || 1;
    const reach = SPLICE_HANDLE_HIT / zoom;
    for (let index = props.orbits.length - 1; index >= 0; index--) {
      const orbit = props.orbits[index];
      if (orbit.mode !== "loop") continue;
      if (Math.abs(x - spliceTrackX(orbit)) <= reach &&
        y >= orbit.y - SPLICE_TRACK_HALF - reach && y <= orbit.y + SPLICE_TRACK_HALF + reach) {
        return orbit;
      }
    }
    return null;
  }

  function spliceStartMarkerPoint(orbit: Orbit) {
    const point = ellipsePoint(orbit, orbit.spliceStartAngle ?? 0);
    const dx = point.x - orbit.x;
    const dy = point.y - orbit.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (dx / magnitude) * SPLICE_START_MARKER_OFFSET,
      y: point.y + (dy / magnitude) * SPLICE_START_MARKER_OFFSET
    };
  }

  function orbitAtSpliceStart(x: number, y: number) {
    const zoom = stateRef.current.viewport.zoom || 1;
    const reach = SPLICE_START_HIT / zoom;
    for (let index = props.orbits.length - 1; index >= 0; index--) {
      const orbit = props.orbits[index];
      if (orbit.mode !== "loop" || (orbit.spliceCount ?? 0) === 0) continue;
      const marker = spliceStartMarkerPoint(orbit);
      if (Math.hypot(marker.x - x, marker.y - y) <= reach) return orbit;
    }
    return null;
  }

  function hitTestCanvas(x: number, y: number): HitTestResult {
    return hitTestCanvasPure({
      x, y, zoom: stateRef.current.viewport.zoom || 1,
      orbits: props.orbits, planets: props.planets, bars: props.bars,
      // Match the draw loop: hit-test against the true runtime angle, not the throttled
      // React-state angle, so clicking a moving planet doesn't miss where it's drawn.
      resolveAngle: (planet) => runtimeAngles.get(planet.id) ?? planet.angle
    });
  }

  const localPoint = (event: React.MouseEvent<HTMLCanvasElement> | React.DragEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function orbitResizeCursor(orbit: Orbit, x: number, y: number) {
    const angle = orbitAngleAtPoint(orbit, x, y);
    const horizontal = Math.abs(Math.cos(angle));
    const vertical = Math.abs(Math.sin(angle));
    if (horizontal > .78) return "ew-resize";
    if (vertical > .78) return "ns-resize";
    return Math.cos(angle) * Math.sin(angle) >= 0 ? "nwse-resize" : "nesw-resize";
  }

  function cursorFor(hit: HitTestResult, x: number, y: number, activeDrag = drag) {
    if (activeDrag?.type === "pan-viewport") return "grabbing";
    if (activeDrag?.type === "marquee") return "crosshair";
    if (activeDrag?.type === "splice") return "ns-resize";
    if (activeDrag?.type === "splice-start") return "grabbing";
    if (props.selectedTool === "splicer") {
      if (orbitAtSpliceStart(x, y)) return "grab";
      return orbitAtSpliceHandle(x, y) ? "ns-resize" : "crosshair";
    }
    if (activeDrag?.type === "move-orbit") return "move";
    if (activeDrag?.type === "move-bar") return "grabbing";
    if (activeDrag?.type === "resize-orbit") return orbitResizeCursor(activeDrag.orbit, x, y);
    if (activeDrag) return "ew-resize";
    if (hit.type === "planet") return "pointer";
    if (hit.type === "bar-edge") return "ew-resize";
    if (hit.type === "bar-body") return "grab";
    if (hit.type === "orbit-line") {
      const orbit = props.orbits.find((item) => item.id === hit.orbitId);
      return orbit ? orbitResizeCursor(orbit, x, y) : "ew-resize";
    }
    if (hit.type === "orbit-inside") return "move";
    return props.selectedTool === "select" ? "grab" : "crosshair";
  }

  // Select the bar and begin a resize (edge) or move (body) drag. Shared by the
  // select and bar tools so bars can be reshaped without leaving the bar tool.
  function startBarInteraction(hit: HitTestResult) {
    if (hit.type !== "bar-edge" && hit.type !== "bar-body") return;
    const bar = props.bars.find((item) => item.id === hit.barId)!;
    const orbit = props.orbits.find((item) => item.id === hit.orbitId)!;
    props.onSelect({ orbitId: hit.orbitId, planetId: null, barId: hit.barId });
    if (hit.type === "bar-body") setDrag({ type: "move-bar", bar, orbit, mutated: false });
    else {
      const fixedAngle = hit.edge === "start"
        ? normalizeAngle(bar.angle + bar.lengthRadians / 2)
        : normalizeAngle(bar.angle - bar.lengthRadians / 2);
      setDrag({
        type: hit.edge === "start" ? "bar-start" : "bar-end", bar, orbit, fixedAngle, mutated: false
      });
    }
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    needsRedrawRef.current = true;
    if (event.button === 1) {
      event.preventDefault();
      const point = localPoint(event);
      setDrag({ type: "pan-viewport", startX: point.x, startY: point.y, viewport: props.viewport });
      event.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (event.button !== 0) return;
    // Clear any stale suppression (e.g. a prior drag that ended off-canvas with no click).
    suppressClickRef.current = false;
    if (props.selectedTool === "splicer") {
      const worldPoint = screenToWorld(localPoint(event));
      const startOrbit = orbitAtSpliceStart(worldPoint.x, worldPoint.y);
      if (startOrbit) {
        props.onSelect({ orbitId: startOrbit.id, planetId: null, barId: null });
        props.onBeginMutation();
        props.onSetSpliceStart(startOrbit.id, orbitAngleAtPoint(startOrbit, worldPoint.x, worldPoint.y));
        setDrag({ type: "splice-start", orbit: startOrbit });
        return;
      }
      const handleOrbit = orbitAtSpliceHandle(worldPoint.x, worldPoint.y);
      if (handleOrbit) {
        props.onSelect({ orbitId: handleOrbit.id, planetId: null, barId: null });
        props.onBeginMutation();
        props.onSetSpliceCount(handleOrbit.id, spliceCountFromWorldY(handleOrbit, worldPoint.y));
        setDrag({ type: "splice", orbit: handleOrbit });
        return;
      }
      const hit = hitTestCanvas(worldPoint.x, worldPoint.y);
      props.onSelect(hit.type === "empty"
        ? { orbitId: null, planetId: null, barId: null }
        : { orbitId: hit.orbitId, planetId: null, barId: null });
      return;
    }
    // Bar tool: allow reshaping an existing bar (edge = resize, body = move) without
    // switching to the select tool. Anything else falls through to click-to-create.
    if (props.selectedTool === "bar") {
      const worldPoint = screenToWorld(localPoint(event));
      const barHit = hitTestCanvas(worldPoint.x, worldPoint.y);
      if (barHit.type === "bar-edge" || barHit.type === "bar-body") {
        startBarInteraction(barHit);
        suppressClickRef.current = true;
      }
      return;
    }
    if (props.selectedTool !== "select") return;
    const screenPoint = localPoint(event);
    const point = screenToWorld(screenPoint);
    const hit = hitTestCanvas(point.x, point.y);
    if (hit.type === "planet") {
      props.onSelect({ orbitId: hit.orbitId, planetId: hit.planetId, barId: null });
      return;
    }
    if (hit.type === "bar-edge" || hit.type === "bar-body") {
      startBarInteraction(hit);
      return;
    }
    if (hit.type === "orbit-line") {
      const orbit = props.orbits.find((item) => item.id === hit.orbitId)!;
      props.onSelect({ orbitId: hit.orbitId, planetId: null, barId: null });
      props.onBeginMutation();
      setDrag({ type: "resize-orbit", orbit });
      return;
    }
    if (hit.type === "orbit-inside") {
      const orbit = props.orbits.find((item) => item.id === hit.orbitId)!;
      props.onSelect({ orbitId: hit.orbitId, planetId: null, barId: null });
      props.onBeginMutation();
      setDrag({ type: "move-orbit", orbit, startX: point.x, startY: point.y });
      return;
    }
    // Empty space: Cmd (macOS) / Ctrl (Windows) + drag draws a marquee box selection;
    // a plain drag pans the canvas, the default empty-space gesture.
    props.onSelect({ orbitId: null, planetId: null, barId: null });
    if (IS_MAC ? event.metaKey : event.ctrlKey) {
      marqueeRef.current = { sx: point.x, sy: point.y, x: point.x, y: point.y };
      setDrag({ type: "marquee", sx: point.x, sy: point.y, x: point.x, y: point.y });
    } else {
      event.preventDefault();
      setDrag({ type: "pan-viewport", startX: screenPoint.x, startY: screenPoint.y, viewport: stateRef.current.viewport });
      event.currentTarget.style.cursor = "grabbing";
    }
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    // Covers plain hover (cursor changes) as well as every drag/marquee update below.
    needsRedrawRef.current = true;
    const screenPoint = localPoint(event);
    const point = screenToWorld(screenPoint);
    event.currentTarget.style.cursor = cursorFor(hitTestCanvas(point.x, point.y), point.x, point.y);
    if (!drag) return;
    if (drag.type === "pan-viewport") {
      props.onViewportChange(clampViewport({
        ...drag.viewport,
        offsetX: drag.viewport.offsetX + screenPoint.x - drag.startX,
        offsetY: drag.viewport.offsetY + screenPoint.y - drag.startY
      }));
    } else if (drag.type === "resize-orbit") {
      props.onResizeOrbit(
        drag.orbit.id,
        Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.abs(point.x - drag.orbit.x))),
        Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.abs(point.y - drag.orbit.y)))
      );
    } else if (drag.type === "move-orbit") {
      props.onMoveOrbit(
        drag.orbit.id,
        clamp(drag.orbit.x + point.x - drag.startX, 0, DEFAULT_WORLD_WIDTH),
        clamp(drag.orbit.y + point.y - drag.startY, 0, DEFAULT_WORLD_HEIGHT)
      );
    } else if (drag.type === "move-bar") {
      const angle = orbitAngleAtPoint(drag.orbit, point.x, point.y);
      if (angularDistance(angle, drag.bar.angle) <= .0001) return;
      if (!drag.mutated) props.onBeginMutation();
      setDrag({ ...drag, mutated: true });
      props.onEditBar(
        drag.bar.id, angle, drag.bar.lengthRadians,
        normalizeAngle(angle - drag.bar.lengthRadians / 2)
      );
    } else if (drag.type === "splice") {
      props.onSetSpliceCount(drag.orbit.id, spliceCountFromWorldY(drag.orbit, point.y));
    } else if (drag.type === "splice-start") {
      props.onSetSpliceStart(drag.orbit.id, orbitAngleAtPoint(drag.orbit, point.x, point.y));
    } else if (drag.type === "marquee") {
      marqueeRef.current = { sx: drag.sx, sy: drag.sy, x: point.x, y: point.y };
      setDrag({ ...drag, x: point.x, y: point.y });
    } else {
      const mouseAngle = orbitAngleAtPoint(drag.orbit, point.x, point.y);
      const raw = drag.type === "bar-end"
        ? normalizeAngle(mouseAngle - drag.fixedAngle)
        : normalizeAngle(drag.fixedAngle - mouseAngle);
      const acc = unwrapLength(drag.acc, drag.prevRaw, raw);
      const length = clampBarLength(acc);
      if (Math.abs(length - drag.bar.lengthRadians) <= .0001) {
        setDrag({ ...drag, acc, prevRaw: raw });
        return;
      }
      if (!drag.mutated) props.onBeginMutation();
      setDrag({ ...drag, acc, prevRaw: raw, mutated: true });
      if (drag.type === "bar-end") {
        props.onEditBar(
          drag.bar.id, normalizeAngle(drag.fixedAngle + length / 2),
          length, normalizeAngle(drag.fixedAngle)
        );
      } else {
        const startAngle = normalizeAngle(drag.fixedAngle - length);
        props.onEditBar(
          drag.bar.id, normalizeAngle(startAngle + length / 2),
          length, startAngle
        );
      }
    }
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (drag || props.selectedTool === "select" || props.selectedTool === "splicer") return;
    const point = screenToWorld(localPoint(event));
    const orbit = findNearestOrbit(props.orbits, point.x, point.y, 14 / stateRef.current.viewport.zoom);
    if (!orbit) return;
    const angle = orbitAngleAtPoint(orbit, point.x, point.y);
    if (props.selectedTool === "planet") props.onAddPlanet(orbit.id, angle);
    else props.onAddBar(orbit.id, angle);
  }

  function finishDrag() {
    needsRedrawRef.current = true;
    if (drag?.type === "bar-start" || drag?.type === "bar-end") {
      const current = stateRef.current.bars.find((bar) => bar.id === drag.bar.id);
      props.onBarLengthEditEnd(drag.bar.id, current?.lengthRadians ?? drag.bar.lengthRadians);
    }
    if (drag?.type === "marquee") {
      const { orbitIds, planetIds } = collectMarqueeSelection(props.orbits, props.planets, drag);
      props.onMarqueeSelect(orbitIds, planetIds);
      marqueeRef.current = null;
    }
    setDrag(null);
  }

  return { handleMouseDown, handleMouseMove, handleClick, finishDrag, cursorFor, hitTestCanvas, screenToWorld, localPoint };
}
