// Pure viewport math extracted from CanvasStage: zoom clamping, screen<->world
// transforms, and the world-bounds constants. No React/DOM dependency beyond reading
// an already-obtained canvas element's bounding rect (never touches refs or state).
import { TAU } from "../../utils/geometry.ts";
import type { ViewportState } from "../../state/types";

export const ABSOLUTE_MIN_VIEWPORT_ZOOM = .1;
export const MAX_VIEWPORT_ZOOM = 4;
export const DEFAULT_WORLD_WIDTH = 4000;
export const DEFAULT_WORLD_HEIGHT = 3000;

const MIN_BAR = .01;
const MAX_BAR = TAU;
const FULL_LOOP_SNAP_THRESHOLD = TAU * .03;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// lengthRadians is always the complete span from the start edge to the end edge.
export const clampBarLength = (lengthRadians: number) => {
  const clamped = Math.min(MAX_BAR, Math.max(MIN_BAR, lengthRadians));
  return TAU - clamped <= FULL_LOOP_SNAP_THRESHOLD ? TAU : clamped;
};

// Keep bar edge drags continuous when crossing the fixed edge, so the bar can
// grow smoothly up to a full loop instead of wrapping back toward zero.
export const unwrapLength = (prevAcc: number | undefined, prevRaw: number | undefined, raw: number) => {
  if (prevAcc === undefined || prevRaw === undefined) return raw;
  let delta = raw - prevRaw;
  if (delta > Math.PI) delta -= TAU;
  else if (delta < -Math.PI) delta += TAU;
  return Math.min(TAU, Math.max(0, prevAcc + delta));
};

export function getFitToWorkspaceZoom(canvasWidth: number, canvasHeight: number) {
  if (canvasWidth <= 0 || canvasHeight <= 0) return ABSOLUTE_MIN_VIEWPORT_ZOOM;
  return Math.min(canvasWidth / DEFAULT_WORLD_WIDTH, canvasHeight / DEFAULT_WORLD_HEIGHT);
}

export function getDynamicMinZoom(canvas: HTMLCanvasElement | null) {
  if (!canvas) return ABSOLUTE_MIN_VIEWPORT_ZOOM;
  const rect = canvas.getBoundingClientRect();
  return Math.max(ABSOLUTE_MIN_VIEWPORT_ZOOM, getFitToWorkspaceZoom(rect.width, rect.height));
}

export function clampViewport(viewport: ViewportState, canvas: HTMLCanvasElement | null) {
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

export function screenToWorld(point: { x: number; y: number }, viewport: ViewportState) {
  return {
    x: (point.x - viewport.offsetX) / viewport.zoom,
    y: (point.y - viewport.offsetY) / viewport.zoom
  };
}
