import { useCallback, useEffect, useRef, useState } from "react";
import { parseHexColor } from "../utils/color";

type Props = {
  audioDuration: number;
  peaks: Float32Array | undefined;
  start: number;
  end: number;
  color: string;
  onChange: (start: number, end: number) => void;
};

// Dragging a handle sets start/end; dragging elsewhere pans the zoomed view.
type Drag =
  | { type: "start" | "end" }
  | { type: "pan"; anchorClientX: number; viewStart: number; viewEnd: number }
  | null;

// Minimum trimmed region so the two handles can never cross or collapse.
const MIN_REGION_SECONDS = 0.02;
const HANDLE_HIT_PX = 9;
const ZOOM_STEP = 0.85;
// Dragging a handle within this margin of an edge auto-pans the zoomed view.
const EDGE_PAN_MARGIN_PX = 26;
const EDGE_PAN_MAX_PX_PER_FRAME = 10;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function SampleTrimEditor({ audioDuration, peaks, start, end, color, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const [drag, setDrag] = useState<Drag>(null);
  // Visible time window [start, end] in seconds — the wheel zooms/pans this.
  const [view, setView] = useState(() => ({ start: 0, end: audioDuration || 1 }));
  const liveRef = useRef({ view, audioDuration, start, end, onChange });
  liveRef.current = { view, audioDuration, start, end, onChange };
  const dragRef = useRef<Drag>(null);
  dragRef.current = drag;
  const pointerXRef = useRef<number | null>(null);
  const autoPanRef = useRef(0);

  const minViewWidth = Math.max(0.01, (audioDuration || 1) / 2000);
  const viewToX = (time: number, width: number) => ((time - view.start) / (view.end - view.start || 1)) * width;

  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const duration = audioDuration || 1;
    const viewStart = view.start;
    const viewWidth = (view.end - view.start) || 1;
    const mid = height / 2;
    const startX = ((start - viewStart) / viewWidth) * width;
    const endX = ((end - viewStart) / viewWidth) * width;
    const { r, g, b } = parseHexColor(color);

    // Waveform over the visible window; bars inside the trimmed region take the orbit color.
    if (peaks && peaks.length) {
      const bars = Math.max(1, Math.floor(width));
      for (let index = 0; index < bars; index++) {
        const t0 = viewStart + (index / bars) * viewWidth;
        const t1 = viewStart + ((index + 1) / bars) * viewWidth;
        const p0 = clamp(Math.floor((t0 / duration) * peaks.length), 0, peaks.length - 1);
        const p1 = clamp(Math.max(p0 + 1, Math.floor((t1 / duration) * peaks.length)), 0, peaks.length);
        let amp = 0;
        for (let p = p0; p < p1; p++) if (peaks[p] > amp) amp = peaks[p];
        const x = (index / bars) * width;
        // Keep a hairline at the center so silent (amp 0) regions read as a thin line, not a gap.
        const barHeight = Math.max(0.4, amp * (height * 0.44));
        const center = (t0 + t1) / 2;
        const inside = center >= start && center <= end;
        context.fillStyle = inside ? `rgba(${r}, ${g}, ${b}, .72)` : "rgba(74, 76, 70, .28)";
        context.fillRect(x, mid - barHeight, Math.max(0.75, width / bars), barHeight * 2);
      }
    }

    // Dim the trimmed-away portions (clamped to the visible window).
    context.fillStyle = "rgba(28, 28, 25, .30)";
    context.fillRect(0, 0, clamp(startX, 0, width), height);
    context.fillRect(clamp(endX, 0, width), 0, width - clamp(endX, 0, width), height);

    // Handles: a line + grip when visible, or an edge triangle when scrolled off-screen.
    context.lineWidth = 2;
    context.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    const drawHandle = (x: number, gripTop: boolean) => {
      if (x < -0.5 || x > width + 0.5) {
        const edgeX = x < 0 ? 3 : width - 3;
        const direction = x < 0 ? -1 : 1;
        context.beginPath();
        context.moveTo(edgeX - direction * 3, mid - 4);
        context.lineTo(edgeX + direction * 3, mid);
        context.lineTo(edgeX - direction * 3, mid + 4);
        context.closePath();
        context.fill();
        return;
      }
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
      if (gripTop) context.fillRect(x - 3, 0, 6, 9);
      else context.fillRect(x - 3, height - 9, 6, 9);
    };
    drawHandle(startX, true);
    drawHandle(endX, false);

    const zoom = duration / viewWidth;
    if (zoom > 1.05) {
      context.fillStyle = "rgba(46, 48, 42, .6)";
      context.font = '8px "MapoFlowerIsland", sans-serif';
      context.fillText(`×${zoom.toFixed(1)}`, 4, height - 4);
    }
  };

  // Redraw after every render (view / trim / color changes) with the latest props.
  useEffect(() => { drawRef.current(); });

  // Keep the canvas sharp and correct across panel resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Wheel: zoom at cursor, or pan when horizontal / shifted. Native listener so we can preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const duration = liveRef.current.audioDuration;
      if (!duration) return;
      const rect = canvas.getBoundingClientRect();
      const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const { start: viewStart, end: viewEnd } = liveRef.current.view;
      const width = viewEnd - viewStart;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const pan = ((event.shiftKey ? event.deltaY : event.deltaX) / rect.width) * width;
        let nextStart = viewStart + pan;
        let nextEnd = viewEnd + pan;
        if (nextStart < 0) { nextEnd -= nextStart; nextStart = 0; }
        if (nextEnd > duration) { nextStart -= nextEnd - duration; nextEnd = duration; }
        setView({ start: Math.max(0, nextStart), end: Math.min(duration, nextEnd) });
      } else {
        const cursorTime = viewStart + frac * width;
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const nextWidth = clamp(width * factor, minViewWidth, duration);
        let nextStart = cursorTime - frac * nextWidth;
        let nextEnd = nextStart + nextWidth;
        if (nextStart < 0) { nextStart = 0; nextEnd = nextWidth; }
        if (nextEnd > duration) { nextEnd = duration; nextStart = duration - nextWidth; }
        setView({ start: Math.max(0, nextStart), end: Math.min(duration, nextEnd) });
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [minViewWidth]);

  const timeAtClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return view.start + frac * (view.end - view.start);
  };

  const applyDrag = (which: "start" | "end", time: number) => {
    if (which === "start") onChange(clamp(time, 0, end - MIN_REGION_SECONDS), end);
    else onChange(start, clamp(time, start + MIN_REGION_SECONDS, audioDuration));
  };

  // While a handle is dragged to a viewport edge, scroll the view that way and keep the
  // handle pinned to the pointer, so it can be pushed past the currently-visible window.
  const autoPanTick = useCallback(() => {
    const activeDrag = dragRef.current;
    const canvas = canvasRef.current;
    const pointerX = pointerXRef.current;
    if (!activeDrag || activeDrag.type === "pan" || !canvas || pointerX === null) {
      autoPanRef.current = 0;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = pointerX - rect.left;
    const { view, audioDuration, start, end, onChange } = liveRef.current;
    const width = view.end - view.start;
    let direction = 0;
    if (x < EDGE_PAN_MARGIN_PX && view.start > 0) direction = -1;
    else if (x > rect.width - EDGE_PAN_MARGIN_PX && view.end < audioDuration) direction = 1;
    if (direction !== 0) {
      const penetration = clamp(
        direction < 0 ? EDGE_PAN_MARGIN_PX - x : x - (rect.width - EDGE_PAN_MARGIN_PX),
        0, EDGE_PAN_MARGIN_PX
      ) / EDGE_PAN_MARGIN_PX;
      const deltaTime = direction * ((penetration * EDGE_PAN_MAX_PX_PER_FRAME) / (rect.width || 1)) * width;
      const nextStart = clamp(view.start + deltaTime, 0, Math.max(0, audioDuration - width));
      if (nextStart !== view.start) {
        setView({ start: nextStart, end: nextStart + width });
        const time = nextStart + clamp(x / rect.width, 0, 1) * width;
        if (activeDrag.type === "start") onChange(clamp(time, 0, end - MIN_REGION_SECONDS), end);
        else onChange(start, clamp(time, start + MIN_REGION_SECONDS, audioDuration));
      }
    }
    autoPanRef.current = requestAnimationFrame(autoPanTick);
  }, []);

  useEffect(() => () => cancelAnimationFrame(autoPanRef.current), []);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const nearStart = Math.abs(x - viewToX(start, rect.width));
    const nearEnd = Math.abs(x - viewToX(end, rect.width));
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerXRef.current = event.clientX;
    // Only grab a handle when the pointer is on it; anywhere else drags (pans) the view.
    if (Math.min(nearStart, nearEnd) <= HANDLE_HIT_PX) {
      const which = nearStart <= nearEnd ? "start" : "end";
      dragRef.current = { type: which };
      setDrag({ type: which });
      applyDrag(which, timeAtClientX(event.clientX));
      if (!autoPanRef.current) autoPanRef.current = requestAnimationFrame(autoPanTick);
    } else {
      setDrag({ type: "pan", anchorClientX: event.clientX, viewStart: view.start, viewEnd: view.end });
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointerXRef.current = event.clientX;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!drag) {
      const near = Math.min(
        Math.abs(event.clientX - rect.left - viewToX(start, rect.width)),
        Math.abs(event.clientX - rect.left - viewToX(end, rect.width))
      );
      event.currentTarget.style.cursor = near <= HANDLE_HIT_PX ? "ew-resize" : "grab";
      return;
    }
    if (drag.type === "pan") {
      event.currentTarget.style.cursor = "grabbing";
      const viewWidth = drag.viewEnd - drag.viewStart;
      const deltaTime = ((event.clientX - drag.anchorClientX) / (rect.width || 1)) * viewWidth;
      const nextStart = clamp(drag.viewStart - deltaTime, 0, Math.max(0, audioDuration - viewWidth));
      setView({ start: nextStart, end: nextStart + viewWidth });
      return;
    }
    event.currentTarget.style.cursor = "ew-resize";
    applyDrag(drag.type, timeAtClientX(event.clientX));
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    cancelAnimationFrame(autoPanRef.current);
    autoPanRef.current = 0;
    pointerXRef.current = null;
    dragRef.current = null;
    setDrag(null);
  };

  return (
    <canvas
      ref={canvasRef}
      className={`sample-trim-canvas ${drag ? "dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setView({ start: 0, end: audioDuration || 1 })}
    />
  );
}
