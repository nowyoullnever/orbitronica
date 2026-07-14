import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextMenuState, MultiSelection, Orbit, Planet, Selection, Tool, TriggerBar, ViewportState } from "../state/types";
import {
  TAU, ellipsePoint, findNearestOrbit,
  getSampleEnd, getSampleStart, isFullLoopBar,
  normalizeAngle, orbitAngleAtPoint, SPLICE_MAX_PIECES
} from "../utils/geometry";
import { angularDistance } from "../utils/triggerDetection";
import { collectMarqueeSelection } from "../utils/selection";
import { parseHexColor } from "../utils/color";
import {
  COLLISION_FLASH_SECONDS, PLANET_RADIUS, stepPhysics, type PlaybackCallback
} from "../state/physics.ts";
import { hitTestCanvas as hitTestCanvasPure, PLANET_STROKE_WIDTH, type HitTestResult } from "../utils/canvasHitTest.ts";

const LOOP_BAR_WIDTH = 7.65;
const LOOP_BAR_SELECTED_WIDTH = 9.35;
const SEQUENCE_BAR_WIDTH = 6.8;
const SEQUENCE_BAR_SELECTED_WIDTH = 8.5;
// Blue accent used to make the current selection stand out (orbits, bars, planets).
const SELECTION_COLOR = "#5b93f2";
// Marquee modifier: Cmd on macOS, Ctrl elsewhere. Using Ctrl on macOS would also fire
// the context menu, so we key off the platform's primary command modifier instead.
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const MIN_BAR = .01;
const MAX_BAR = TAU;
const FULL_LOOP_SNAP_THRESHOLD = TAU * .03;
const MIN_RADIUS = 40;
const MAX_RADIUS = 1000;
// Splice dragbar: a vertical track sitting just outside an orbit's right edge. The knob
// rests at the centre (count 0) and drags up (positive / bar-first) or down (negative /
// gap-first). Each 2 pieces of splice shift the knob SPLICE_STEP_PIXELS world units.
const SPLICE_HANDLE_MARGIN = 28;
const SPLICE_TRACK_HALF = 68;
const SPLICE_STEP_PIXELS = SPLICE_TRACK_HALF / (SPLICE_MAX_PIECES / 2);
const SPLICE_HANDLE_HIT = 13;
// Radial distance of the start-arrow marker from the orbit line, and its grab radius.
const SPLICE_START_MARKER_OFFSET = 11;
const SPLICE_START_HIT = 12;
const ABSOLUTE_MIN_VIEWPORT_ZOOM = .1;
const MAX_VIEWPORT_ZOOM = 4;
const DEFAULT_WORLD_WIDTH = 4000;
const DEFAULT_WORLD_HEIGHT = 3000;

const WAVEFORM_HIGHLIGHT_WINDOW = .28;

// lengthRadians is always the complete span from the start edge to the end edge.
const clampBarLength = (lengthRadians: number) => {
  const clamped = Math.min(MAX_BAR, Math.max(MIN_BAR, lengthRadians));
  return TAU - clamped <= FULL_LOOP_SNAP_THRESHOLD ? TAU : clamped;
};

// Keep bar edge drags continuous when crossing the fixed edge, so the bar can
// grow smoothly up to a full loop instead of wrapping back toward zero.
const unwrapLength = (prevAcc: number | undefined, prevRaw: number | undefined, raw: number) => {
  if (prevAcc === undefined || prevRaw === undefined) return raw;
  let delta = raw - prevRaw;
  if (delta > Math.PI) delta -= TAU;
  else if (delta < -Math.PI) delta += TAU;
  return Math.min(TAU, Math.max(0, prevAcc + delta));
};

type Drag =
  | { type: "resize-orbit"; orbit: Orbit }
  | { type: "move-orbit"; orbit: Orbit; startX: number; startY: number }
  | { type: "bar-start" | "bar-end"; bar: TriggerBar; orbit: Orbit; fixedAngle: number; mutated: boolean; acc?: number; prevRaw?: number }
  | { type: "move-bar"; bar: TriggerBar; orbit: Orbit; mutated: boolean }
  | { type: "splice"; orbit: Orbit }
  | { type: "splice-start"; orbit: Orbit }
  | { type: "marquee"; sx: number; sy: number; x: number; y: number }
  | { type: "pan-viewport"; startX: number; startY: number; viewport: ViewportState };

type WaveformSegment = {
  x: number;
  y: number;
  nx: number;
  ny: number;
  half: number;
  angle: number;
};

type WaveformGeometry = {
  peaks: Float32Array;
  radiusX: number;
  radiusY: number;
  spikeCount: number;
  startFraction: number;
  endFraction: number;
  baseWidth: number;
  segments: WaveformSegment[];
  basePath: Path2D;
};

type Props = {
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
  const [drag, setDrag] = useState<Drag | null>(null);
  // Live marquee rectangle (world coords), read by the render loop each frame.
  const marqueeRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  // Set when a bar-tool drag begins so the trailing click doesn't also place a new bar.
  const suppressClickRef = useRef(false);
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

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  function getFitToWorkspaceZoom(canvasWidth: number, canvasHeight: number) {
    if (canvasWidth <= 0 || canvasHeight <= 0) return ABSOLUTE_MIN_VIEWPORT_ZOOM;
    return Math.min(canvasWidth / DEFAULT_WORLD_WIDTH, canvasHeight / DEFAULT_WORLD_HEIGHT);
  }

  function getDynamicMinZoom() {
    const canvas = canvasRef.current;
    if (!canvas) return ABSOLUTE_MIN_VIEWPORT_ZOOM;
    const rect = canvas.getBoundingClientRect();
    return Math.max(ABSOLUTE_MIN_VIEWPORT_ZOOM, getFitToWorkspaceZoom(rect.width, rect.height));
  }

  function clampViewport(viewport: ViewportState) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return {
        zoom: clamp(viewport.zoom, ABSOLUTE_MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM),
        offsetX: viewport.offsetX,
        offsetY: viewport.offsetY
      };
    }
    const rect = canvas.getBoundingClientRect();
    const minZoom = Math.max(ABSOLUTE_MIN_VIEWPORT_ZOOM, getFitToWorkspaceZoom(rect.width, rect.height));
    const zoom = clamp(viewport.zoom, minZoom, MAX_VIEWPORT_ZOOM);
    const worldScreenWidth = DEFAULT_WORLD_WIDTH * zoom;
    const worldScreenHeight = DEFAULT_WORLD_HEIGHT * zoom;
    const offsetX = worldScreenWidth <= rect.width
      ? (rect.width - worldScreenWidth) / 2
      : clamp(viewport.offsetX, rect.width - worldScreenWidth, 0);
    const offsetY = worldScreenHeight <= rect.height
      ? (rect.height - worldScreenHeight) / 2
      : clamp(viewport.offsetY, rect.height - worldScreenHeight, 0);
    return {
      zoom,
      offsetX,
      offsetY
    };
  }

  function screenToWorld(point: { x: number; y: number }, viewport = stateRef.current.viewport) {
    return {
      x: (point.x - viewport.offsetX) / viewport.zoom,
      y: (point.y - viewport.offsetY) / viewport.zoom
    };
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
    const context = canvas.getContext("2d")!;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      props.onViewportChange(clampViewport(stateRef.current.viewport));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

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

  const spliceTrackX = (orbit: Orbit) => orbit.x + orbit.radiusX + SPLICE_HANDLE_MARGIN;
  const spliceHandleY = (orbit: Orbit) =>
    orbit.y - clamp(((orbit.spliceCount ?? 0) / 2) * SPLICE_STEP_PIXELS, -SPLICE_TRACK_HALF, SPLICE_TRACK_HALF);
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
      resolveAngle: (planet) => runtimeAngles.current.get(planet.id) ?? planet.angle
    });
  }

  useEffect(() => {
    // Persistent, frame-to-frame scratch structures for the draw loop below: allocated
    // once for the lifetime of this effect (a single rAF loop) and cleared+refilled each
    // frame instead of being reallocated every frame at 60fps.
    const orbitsById = new Map<string, Orbit>();
    const planetAnglesByOrbit = new Map<string, number[]>();
    const waveformOrbitIds = new Set<string>();
    const drawTick = (context: CanvasRenderingContext2D, orbit: Orbit, angle: number, color: string, width = 8) => {
      const point = ellipsePoint(orbit, angle);
      const nx = Math.cos(angle), ny = Math.sin(angle);
      context.beginPath();
      context.moveTo(point.x - nx * 8, point.y - ny * 8);
      context.lineTo(point.x + nx * 8, point.y + ny * 8);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.lineCap = "butt";
      context.stroke();
    };
    const drawRadialMarker = (
      context: CanvasRenderingContext2D, orbit: Orbit, angle: number, length: number
    ) => {
      const point = ellipsePoint(orbit, angle);
      const dx = point.x - orbit.x;
      const dy = point.y - orbit.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      const nx = dx / magnitude;
      const ny = dy / magnitude;
      context.beginPath();
      context.moveTo(point.x - nx * length / 2, point.y - ny * length / 2);
      context.lineTo(point.x + nx * length / 2, point.y + ny * length / 2);
      context.stroke();
    };
    const getWaveformGeometry = (orbit: Orbit, peaks: Float32Array) => {
      const circumference = Math.PI * (orbit.radiusX + orbit.radiusY);
      const spikeCount = Math.min(720, Math.max(160, Math.round(circumference / 4)));
      const amplitudeScale = Math.max(14, Math.min(orbit.radiusX, orbit.radiusY) * .22);
      const baseWidth = Math.max(.6, (circumference / spikeCount) * .55);
      // Only the trimmed [start, end] slice of the sample is wrapped around the orbit,
      // matching what actually plays as the angle sweeps 0..TAU.
      const startFraction = orbit.audioDuration > 0 ? getSampleStart(orbit) / orbit.audioDuration : 0;
      const endFraction = orbit.audioDuration > 0 ? getSampleEnd(orbit) / orbit.audioDuration : 1;
      const cached = waveformGeometryCache.current.get(orbit.id);
      if (cached && cached.peaks === peaks && cached.radiusX === orbit.radiusX &&
        cached.radiusY === orbit.radiusY && cached.spikeCount === spikeCount &&
        cached.startFraction === startFraction && cached.endFraction === endFraction) return cached;

      const lo = startFraction * peaks.length;
      const hi = endFraction * peaks.length;
      const segments: WaveformSegment[] = [];
      const basePath = new Path2D();
      for (let index = 0; index < spikeCount; index++) {
        const from = Math.min(peaks.length - 1, Math.max(0, Math.floor(lo + (index / spikeCount) * (hi - lo))));
        const to = Math.min(peaks.length, Math.max(from + 1, Math.floor(lo + ((index + 1) / spikeCount) * (hi - lo))));
        let amp = 0;
        for (let p = from; p < to; p++) if (peaks[p] > amp) amp = peaks[p];
        const angle = (index / spikeCount) * TAU;
        const x = Math.cos(angle) * orbit.radiusX;
        const y = Math.sin(angle) * orbit.radiusY;
        const dx = x;
        const dy = y;
        const magnitude = Math.hypot(dx, dy) || 1;
        const segment = { x, y, nx: dx / magnitude, ny: dy / magnitude, half: amp * amplitudeScale, angle };
        segments.push(segment);
        basePath.moveTo(segment.x - segment.nx * segment.half, segment.y - segment.ny * segment.half);
        basePath.lineTo(segment.x + segment.nx * segment.half, segment.y + segment.ny * segment.half);
      }
      const geometry = {
        peaks, radiusX: orbit.radiusX, radiusY: orbit.radiusY, spikeCount,
        startFraction, endFraction, baseWidth, segments, basePath
      };
      waveformGeometryCache.current.set(orbit.id, geometry);
      return geometry;
    };

    // Overlay the loaded sample's waveform around the orbit: angle is the audio
    // timeline, amplitude displaces radially in/out from the orbit line.
    const drawWaveform = (
      context: CanvasRenderingContext2D, orbit: Orbit, peaks: Float32Array, planetAngles: number[]
    ) => {
      const geometry = getWaveformGeometry(orbit, peaks);
      context.save();
      context.translate(orbit.x, orbit.y);
      context.lineCap = "butt";
      context.globalAlpha = orbit.isPaused ? .48 : 1;
      // Base pass: the full waveform in translucent gray, batched into one stroke.
      context.strokeStyle = "rgba(74, 76, 70, .28)";
      context.lineWidth = geometry.baseWidth;
      context.stroke(geometry.basePath);
      // Highlight pass: spikes near a planet glow in the orbit's color and fade with distance.
      if (planetAngles.length) {
        const { r, g, b } = parseHexColor(orbit.color);
        const highlightFactors = new Map<number, number>();
        const span = Math.ceil(WAVEFORM_HIGHLIGHT_WINDOW / TAU * geometry.spikeCount);
        for (const planetAngle of planetAngles) {
          const center = Math.round(normalizeAngle(planetAngle) / TAU * geometry.spikeCount) % geometry.spikeCount;
          for (let offset = -span; offset <= span; offset++) {
            const index = (center + offset + geometry.spikeCount) % geometry.spikeCount;
            const distance = angularDistance(geometry.segments[index].angle, planetAngle);
            if (distance >= WAVEFORM_HIGHLIGHT_WINDOW) continue;
            const factor = 1 - distance / WAVEFORM_HIGHLIGHT_WINDOW;
            if (factor > (highlightFactors.get(index) ?? 0)) highlightFactors.set(index, factor);
          }
        }
        // Sharp spike at the planet, fading all the way to transparent at the window edge
        // (continuous alpha, no floor) so the highlight blends smoothly into the gray waveform.
        // Only the spikes within the window are touched, so this stays cheap despite per-spike strokes.
        for (const [index, factor] of highlightFactors) {
          const eased = factor * factor;
          const segment = geometry.segments[index];
          context.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(.92 * eased).toFixed(3)})`;
          context.lineWidth = geometry.baseWidth * (1 + eased * .8);
          context.beginPath();
          context.moveTo(segment.x - segment.nx * segment.half, segment.y - segment.ny * segment.half);
          context.lineTo(segment.x + segment.nx * segment.half, segment.y + segment.ny * segment.half);
          context.stroke();
        }
      }
      context.restore();
    };
    const drawStartArrow = (
      context: CanvasRenderingContext2D, orbit: Orbit, angle: number, color: string, scale = 1
    ) => {
      const point = ellipsePoint(orbit, angle);
      const dx = point.x - orbit.x;
      const dy = point.y - orbit.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      const nx = dx / magnitude;
      const ny = dy / magnitude;
      const tx = -ny;
      const ty = nx;
      // Keep the marker outside even the selected loop bar's thickest edge.
      const markerX = point.x + nx * SPLICE_START_MARKER_OFFSET;
      const markerY = point.y + ny * SPLICE_START_MARKER_OFFSET;
      const wing = 3 * scale;
      const tip = 2 * scale;
      context.strokeStyle = color;
      context.lineWidth = 1.5 * scale;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(markerX + nx * wing + tx * wing, markerY + ny * wing + ty * wing);
      context.lineTo(markerX - nx * tip, markerY - ny * tip);
      context.lineTo(markerX + nx * wing - tx * wing, markerY + ny * wing - ty * wing);
      context.stroke();
    };
    const drawAudioStartMarker = (context: CanvasRenderingContext2D, orbit: Orbit) =>
      drawStartArrow(context, orbit, 0, "#11120f", 1);
    const drawSpliceDragbar = (context: CanvasRenderingContext2D, orbit: Orbit, zoom: number) => {
      const trackX = orbit.x + orbit.radiusX + SPLICE_HANDLE_MARGIN;
      const centerY = orbit.y;
      const count = orbit.spliceCount ?? 0;
      const handleY = spliceHandleY(orbit);
      const px = (value: number) => value / zoom;
      const active = orbit.id === stateRef.current.selection.orbitId;
      // Track.
      context.strokeStyle = "#c3c2bb";
      context.lineWidth = px(2);
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(trackX, centerY - SPLICE_TRACK_HALF);
      context.lineTo(trackX, centerY + SPLICE_TRACK_HALF);
      context.stroke();
      // Centre (zero) tick.
      context.strokeStyle = "#9a9b92";
      context.lineWidth = px(1.5);
      context.beginPath();
      context.moveTo(trackX - px(5), centerY);
      context.lineTo(trackX + px(5), centerY);
      context.stroke();
      // Knob.
      context.beginPath();
      context.arc(trackX, handleY, px(6), 0, TAU);
      context.fillStyle = active ? "#171813" : "#3f413a";
      context.fill();
      context.strokeStyle = "#ffffff";
      context.lineWidth = px(1.5);
      context.stroke();
      // Count label.
      context.fillStyle = "#2e302a";
      context.font = `${px(11)}px "MapoFlowerIsland", sans-serif`;
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(count > 0 ? `+${count}` : String(count), trackX + px(11), handleY);
      context.textAlign = "start";
      context.textBaseline = "alphabetic";
    };
    const draw = (time: number) => {
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
      const multiOrbitIds = multiSelectionSetsRef.current.orbitIds;
      const multiPlanetIds = multiSelectionSetsRef.current.planetIds;
      context.clearRect(0, 0, rect.width, rect.height);
      context.save();
      context.translate(state.viewport.offsetX, state.viewport.offsetY);
      context.scale(state.viewport.zoom, state.viewport.zoom);
      context.lineCap = "round";

      context.strokeStyle = "#dddcd5";
      context.lineWidth = 1 / state.viewport.zoom;
      context.strokeRect(0, 0, DEFAULT_WORLD_WIDTH, DEFAULT_WORLD_HEIGHT);

      orbitsById.clear();
      for (const orbit of state.orbits) {
        orbitsById.set(orbit.id, orbit);
        context.beginPath();
        context.ellipse(orbit.x, orbit.y, orbit.radiusX, orbit.radiusY, 0, 0, TAU);
        const orbitSelected = orbit.id === state.selection.orbitId || multiOrbitIds.has(orbit.id);
        context.strokeStyle = orbitSelected ? SELECTION_COLOR
          : orbit.isPaused ? "#c8c8c3" : orbit.mode === "sequence" ? "#376cc4" : orbit.color;
        context.lineWidth = orbitSelected ? 2.5 : 1;
        context.globalAlpha = orbit.isPaused ? .48 : 1;
        context.stroke();
        context.globalAlpha = 1;
      }

      // Waveform overlay sits above the orbit line but below bars, markers, and planets.
      // Angle is read from the runtime ref (falling back to React state for planets the
      // physics tick hasn't touched yet) so the waveform highlight tracks true motion
      // even on ticks where React state's angle hasn't been committed.
      planetAnglesByOrbit.clear();
      for (const planet of state.planets) {
        const angle = runtimeAngles.current.get(planet.id) ?? planet.angle;
        const list = planetAnglesByOrbit.get(planet.orbitId);
        if (list) list.push(angle);
        else planetAnglesByOrbit.set(planet.orbitId, [angle]);
      }
      waveformOrbitIds.clear();
      for (const orbit of state.orbits) waveformOrbitIds.add(orbit.id);
      for (const orbitId of waveformGeometryCache.current.keys()) {
        if (!waveformOrbitIds.has(orbitId)) waveformGeometryCache.current.delete(orbitId);
      }
      for (const orbit of state.orbits) {
        if (orbit.showWaveform === false) continue;
        const amplitude = Math.max(14, Math.min(orbit.radiusX, orbit.radiusY) * .22);
        const left = (orbit.x - orbit.radiusX - amplitude) * state.viewport.zoom + state.viewport.offsetX;
        const right = (orbit.x + orbit.radiusX + amplitude) * state.viewport.zoom + state.viewport.offsetX;
        const top = (orbit.y - orbit.radiusY - amplitude) * state.viewport.zoom + state.viewport.offsetY;
        const bottom = (orbit.y + orbit.radiusY + amplitude) * state.viewport.zoom + state.viewport.offsetY;
        if (right < 0 || left > rect.width || bottom < 0 || top > rect.height) continue;
        const peaks = state.waveformPeaksByOrbit.get(orbit.id);
        if (peaks) drawWaveform(context, orbit, peaks, planetAnglesByOrbit.get(orbit.id) ?? []);
      }

      for (const bar of state.bars) {
        const orbit = orbitsById.get(bar.orbitId);
        if (!orbit || (orbit.mode !== "loop" && bar.source === "splice")) continue;
        const selected = bar.id === state.selection.barId;
        if (orbit.mode === "loop") {
          context.beginPath();
          if (isFullLoopBar(bar)) {
            context.ellipse(orbit.x, orbit.y, orbit.radiusX, orbit.radiusY, 0, 0, TAU);
          } else {
            context.ellipse(orbit.x, orbit.y, orbit.radiusX, orbit.radiusY, 0,
              bar.angle - bar.lengthRadians / 2, bar.angle + bar.lengthRadians / 2);
          }
          context.strokeStyle = selected ? SELECTION_COLOR : "#464841";
          context.lineWidth = selected ? LOOP_BAR_SELECTED_WIDTH : LOOP_BAR_WIDTH;
          context.lineCap = "butt";
          context.stroke();
        } else {
          const color = bar.kind === "stop" ? "#c64e47" : "#255cb8";
          drawTick(context, orbit, bar.angle, color, selected ? SEQUENCE_BAR_SELECTED_WIDTH : SEQUENCE_BAR_WIDTH);
          if (bar.kind === "stop") {
            const point = ellipsePoint(orbit, bar.angle);
            context.fillStyle = "#c64e47";
            context.fillRect(point.x - 3, point.y - 3, 6, 6);
          }
        }
      }

      // Visual markers sit above bars but below moving planets.
      for (const bar of state.bars) {
        const orbit = orbitsById.get(bar.orbitId);
        if (!orbit || orbit.mode !== "loop" || bar.source === "splice" || !isFullLoopBar(bar)) continue;
        context.strokeStyle = "#ffffff";
        context.lineWidth = 3;
        context.lineCap = "round";
        drawRadialMarker(context, orbit, bar.startAngle, 22);
      }
      for (const orbit of state.orbits) drawAudioStartMarker(context, orbit);

      for (const planet of state.planets) {
        const orbit = orbitsById.get(planet.orbitId);
        if (!orbit) continue;
        // Read the true runtime angle (updated every 10ms tick) instead of React state's
        // angle, which is now only committed periodically -- see physics.ts's stepPhysics
        // for the throttled commit contract this depends on.
        const point = ellipsePoint(orbit, runtimeAngles.current.get(planet.id) ?? planet.angle);
        context.beginPath();
        context.arc(point.x, point.y, PLANET_RADIUS, 0, TAU);
        context.fillStyle = orbit.color;
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = planet.collisionFlashRemaining > 0 ? PLANET_STROKE_WIDTH + 2 : PLANET_STROKE_WIDTH;
        context.stroke();
        if (planet.collisionFlashRemaining > 0) {
          const progress = 1 - planet.collisionFlashRemaining / COLLISION_FLASH_SECONDS;
          context.beginPath();
          context.arc(point.x, point.y, PLANET_RADIUS + 3 + progress * 4, 0, TAU);
          context.globalAlpha = Math.max(0, 1 - progress);
          context.strokeStyle = "#ffffff";
          context.lineWidth = 1.5;
          context.stroke();
          context.globalAlpha = 1;
        }
        if (planet.id === state.selection.planetId || multiPlanetIds.has(planet.id)) {
          context.beginPath(); context.arc(point.x, point.y, PLANET_RADIUS + 3.5, 0, TAU);
          context.strokeStyle = SELECTION_COLOR; context.lineWidth = 2; context.stroke();
        }
      }

      if (state.selectedTool === "splicer") {
        const zoom = state.viewport.zoom || 1;
        for (const orbit of state.orbits) {
          // Splicing only applies to loop orbits, matching where the dragbar is interactive.
          if (orbit.mode !== "loop") continue;
          drawSpliceDragbar(context, orbit, zoom);
          // A grabbable start-point arrow, drawn only where a splice actually exists.
          if ((orbit.spliceCount ?? 0) !== 0) {
            drawStartArrow(context, orbit, orbit.spliceStartAngle ?? 0, orbit.color, 1.9);
          }
        }
      }

      const marquee = marqueeRef.current;
      if (marquee) {
        const x0 = Math.min(marquee.sx, marquee.x), y0 = Math.min(marquee.sy, marquee.y);
        const width = Math.abs(marquee.x - marquee.sx), height = Math.abs(marquee.y - marquee.sy);
        const zoom = state.viewport.zoom || 1;
        context.save();
        context.fillStyle = "rgba(55, 108, 196, .12)";
        context.strokeStyle = "#376cc4";
        context.lineWidth = 1 / zoom;
        context.setLineDash([4 / zoom, 3 / zoom]);
        context.fillRect(x0, y0, width, height);
        context.strokeRect(x0, y0, width, height);
        context.restore();
      }

      context.restore();
      context.fillStyle = "rgba(46, 48, 42, .72)";
      context.font = '10px "MapoFlowerIsland", sans-serif';
      context.fillText(`Zoom: ${Math.round(state.viewport.zoom * 100)}%`, rect.width - 82, rect.height - 18);
      frameRef.current = requestAnimationFrame(draw);
    };
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  useEffect(() => {
    setDrag(null);
    marqueeRef.current = null;
  }, [props.cancelSignal]);

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
