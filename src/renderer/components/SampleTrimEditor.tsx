import { useEffect, useRef, useState } from "react";
import { parseHexColor } from "../utils/color";

type Props = {
  audioDuration: number;
  peaks: Float32Array | undefined;
  start: number;
  end: number;
  color: string;
  onChange: (start: number, end: number) => void;
};

// Minimum trimmed region so the two handles can never cross or collapse.
const MIN_REGION_SECONDS = 0.02;
const HANDLE_HIT_PX = 9;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function SampleTrimEditor({ audioDuration, peaks, start, end, color, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const [drag, setDrag] = useState<"start" | "end" | null>(null);

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
    const mid = height / 2;
    const startX = clamp((start / duration) * width, 0, width);
    const endX = clamp((end / duration) * width, 0, width);
    const { r, g, b } = parseHexColor(color);

    // Waveform mirrored around the mid line; bars inside the region take the orbit color.
    if (peaks && peaks.length) {
      const bars = Math.max(1, Math.min(peaks.length, Math.floor(width)));
      for (let index = 0; index < bars; index++) {
        const from = Math.floor((index / bars) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((index + 1) / bars) * peaks.length));
        let amp = 0;
        for (let p = from; p < to; p++) if (peaks[p] > amp) amp = peaks[p];
        const x = (index / bars) * width;
        const barHeight = amp * (height * 0.44);
        const inside = x >= startX - 0.5 && x <= endX + 0.5;
        context.fillStyle = inside ? `rgba(${r}, ${g}, ${b}, .72)` : "rgba(74, 76, 70, .28)";
        context.fillRect(x, mid - barHeight, Math.max(0.75, width / bars - 0.5), barHeight * 2);
      }
    }

    // Dim the trimmed-away portions.
    context.fillStyle = "rgba(28, 28, 25, .30)";
    context.fillRect(0, 0, startX, height);
    context.fillRect(endX, 0, width - endX, height);

    // Handles.
    context.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(startX, 0); context.lineTo(startX, height); context.stroke();
    context.beginPath(); context.moveTo(endX, 0); context.lineTo(endX, height); context.stroke();
    context.fillRect(startX - 3, 0, 6, 9);
    context.fillRect(endX - 3, height - 9, 6, 9);
  };

  // Redraw after every render (start/end/color changes) with the latest props.
  useEffect(() => { drawRef.current(); });

  // Keep the canvas sharp and correct across panel resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const timeAtClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    return (x / rect.width) * audioDuration;
  };

  const applyDrag = (which: "start" | "end", time: number) => {
    if (which === "start") onChange(clamp(time, 0, end - MIN_REGION_SECONDS), end);
    else onChange(start, clamp(time, start + MIN_REGION_SECONDS, audioDuration));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const duration = audioDuration || 1;
    const startX = (start / duration) * rect.width;
    const endX = (end / duration) * rect.width;
    const nearStart = Math.abs(x - startX);
    const nearEnd = Math.abs(x - endX);
    let which: "start" | "end" | null = null;
    if (Math.min(nearStart, nearEnd) <= HANDLE_HIT_PX) which = nearStart <= nearEnd ? "start" : "end";
    else if (x < startX) which = "start";
    else if (x > endX) which = "end";
    if (!which) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(which);
    applyDrag(which, timeAtClientX(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    applyDrag(drag, timeAtClientX(event.clientX));
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
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
      onDoubleClick={() => onChange(0, audioDuration)}
    />
  );
}
