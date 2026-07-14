// The rAF draw-loop body extracted from CanvasStage: draws orbits, the waveform overlay,
// bars, markers, planets, the splicer tool's dragbar overlay, and the marquee box onto a
// 2D canvas context for a single frame. Pure w.r.t. React -- takes a context, a frame's
// worth of state, and the small set of persistent caches the component still owns (the
// waveform geometry cache and the physics tick's runtime angle ref). The rAF scheduling
// and the needs-redraw dirty flag stay in CanvasStage.tsx, since both touch refs owned
// by the component.
import type { Orbit, Planet, Selection, Tool, TriggerBar, ViewportState } from "../../state/types";
import {
  TAU, ellipsePoint, getSampleEnd, getSampleStart, isFullLoopBar, normalizeAngle, SPLICE_MAX_PIECES
} from "../../utils/geometry.ts";
import { angularDistance } from "../../utils/triggerDetection.ts";
import { parseHexColor } from "../../utils/color.ts";
import { COLLISION_FLASH_SECONDS, PLANET_RADIUS } from "../../state/physics.ts";
import { PLANET_STROKE_WIDTH } from "../../utils/canvasHitTest.ts";
import { clamp, DEFAULT_WORLD_HEIGHT, DEFAULT_WORLD_WIDTH } from "./viewport.ts";

const LOOP_BAR_WIDTH = 7.65;
const LOOP_BAR_SELECTED_WIDTH = 9.35;
const SEQUENCE_BAR_WIDTH = 6.8;
const SEQUENCE_BAR_SELECTED_WIDTH = 8.5;
// Blue accent used to make the current selection stand out (orbits, bars, planets).
const SELECTION_COLOR = "#5b93f2";
const WAVEFORM_HIGHLIGHT_WINDOW = .28;

// Splice dragbar geometry: shared with CanvasStage's pointer interaction code (which
// hit-tests the handle and start marker), so it's exported rather than duplicated --
// see physics.ts's PLANET_RADIUS for the same pattern (kept in one place so drawing and
// hit-test math never drift apart).
export const SPLICE_HANDLE_MARGIN = 28;
export const SPLICE_TRACK_HALF = 68;
export const SPLICE_STEP_PIXELS = SPLICE_TRACK_HALF / (SPLICE_MAX_PIECES / 2);
export const SPLICE_START_MARKER_OFFSET = 11;

type WaveformSegment = {
  x: number;
  y: number;
  nx: number;
  ny: number;
  half: number;
  angle: number;
};

export type WaveformGeometry = {
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

// The subset of CanvasStage's props a single frame's draw needs.
export type DrawFrameState = {
  orbits: Orbit[];
  planets: Planet[];
  bars: TriggerBar[];
  waveformPeaksByOrbit: ReadonlyMap<string, Float32Array>;
  selection: Selection;
  selectedTool: Tool;
  viewport: ViewportState;
};

export type CanvasRendererDeps = {
  // Mutated in place across frames, exactly like the ref-backed structures CanvasStage
  // used to close over directly.
  waveformGeometryCache: Map<string, WaveformGeometry>;
  runtimeAngles: Map<string, number>;
};

// Where the splice dragbar's knob sits vertically: centred at spliceCount 0, moving up
// (positive) or down (negative) SPLICE_STEP_PIXELS per 2 pieces of splice, clamped to the
// track. Rendering-only -- no interaction code needs this exact Y (hit-testing the handle
// only checks proximity to the track's X and the track's vertical extent).
const spliceHandleY = (orbit: Orbit) =>
  orbit.y - clamp(((orbit.spliceCount ?? 0) / 2) * SPLICE_STEP_PIXELS, -SPLICE_TRACK_HALF, SPLICE_TRACK_HALF);

export function createCanvasRenderer(deps: CanvasRendererDeps) {
  const { waveformGeometryCache, runtimeAngles } = deps;
  // Persistent, frame-to-frame scratch structures: allocated once for the renderer's
  // lifetime (matching the single rAF loop that owns it) and cleared+refilled each frame
  // instead of being reallocated every frame at 60fps.
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
    const cached = waveformGeometryCache.get(orbit.id);
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
    waveformGeometryCache.set(orbit.id, geometry);
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

  const drawSpliceDragbar = (
    context: CanvasRenderingContext2D, orbit: Orbit, zoom: number, selectedOrbitId: string | null
  ) => {
    const trackX = orbit.x + orbit.radiusX + SPLICE_HANDLE_MARGIN;
    const centerY = orbit.y;
    const count = orbit.spliceCount ?? 0;
    const handleY = spliceHandleY(orbit);
    const px = (value: number) => value / zoom;
    const active = orbit.id === selectedOrbitId;
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

  function draw(
    context: CanvasRenderingContext2D,
    rect: { width: number; height: number },
    state: DrawFrameState,
    multiOrbitIds: ReadonlySet<string>,
    multiPlanetIds: ReadonlySet<string>,
    marquee: { sx: number; sy: number; x: number; y: number } | null
  ) {
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
      const angle = runtimeAngles.get(planet.id) ?? planet.angle;
      const list = planetAnglesByOrbit.get(planet.orbitId);
      if (list) list.push(angle);
      else planetAnglesByOrbit.set(planet.orbitId, [angle]);
    }
    waveformOrbitIds.clear();
    for (const orbit of state.orbits) waveformOrbitIds.add(orbit.id);
    for (const orbitId of waveformGeometryCache.keys()) {
      if (!waveformOrbitIds.has(orbitId)) waveformGeometryCache.delete(orbitId);
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
      const point = ellipsePoint(orbit, runtimeAngles.get(planet.id) ?? planet.angle);
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
        drawSpliceDragbar(context, orbit, zoom, state.selection.orbitId);
        // A grabbable start-point arrow, drawn only where a splice actually exists.
        if ((orbit.spliceCount ?? 0) !== 0) {
          drawStartArrow(context, orbit, orbit.spliceStartAngle ?? 0, orbit.color, 1.9);
        }
      }
    }

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
  }

  return { draw };
}
