import { useEffect, useRef, useState } from "react";
import { audioEngine } from "../audio/audioEngine";

// Meter width maps linearly to amplitude. The track gradient (styles.css) turns
// yellow at -6 dBFS (amplitude 10^(-6/20) ~= 50.1%) and red at -1 dBFS (~89.1%).
const METER_INTERVAL_MS = 1000 / 30;
const CLIP_HOLD_MS = 1200;

// Stereo final-output level meter: L on top, R on bottom. Each channel polls its
// own analyser peak, paints a smoothed bar, and lights a clip marker past 0 dBFS.
function MasterMeter({ isActive }: { isActive: boolean }) {
  const maskRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const clipRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];

  useEffect(() => {
    const smoothed = [0, 0];
    const clipUntil = [0, 0];
    const lastMask = [100, 100];
    const lastLit = [false, false];
    let timer: number | undefined;
    const reset = () => {
      for (let channel = 0; channel < 2; channel++) {
        smoothed[channel] = 0;
        clipUntil[channel] = 0;
        lastMask[channel] = 100;
        lastLit[channel] = false;
        const mask = maskRefs[channel].current;
        if (mask) mask.style.width = "100%";
        clipRefs[channel].current?.classList.remove("lit");
      }
    };
    const tick = () => {
      const levels = audioEngine.getMasterLevels();
      const raw = [levels.left, levels.right];
      const now = performance.now();
      for (let channel = 0; channel < 2; channel++) {
        const level = raw[channel];
        // Fast attack, slow release keeps the bar readable rather than flickering.
        smoothed[channel] = level > smoothed[channel]
          ? level : smoothed[channel] * 0.82 + level * 0.18;
        const filled = Math.min(1, smoothed[channel]);
        const maskWidth = (1 - filled) * 100;
        const mask = maskRefs[channel].current;
        if (mask && Math.abs(maskWidth - lastMask[channel]) >= .1) {
          mask.style.width = `${maskWidth}%`;
          lastMask[channel] = maskWidth;
        }
        if (level >= 1) clipUntil[channel] = now + CLIP_HOLD_MS;
        const lit = clipUntil[channel] > now;
        const clip = clipRefs[channel].current;
        if (clip && lit !== lastLit[channel]) {
          clip.classList.toggle("lit", lit);
          lastLit[channel] = lit;
        }
      }
    };
    const syncTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (!isActive || document.visibilityState !== "visible") {
        reset();
        return;
      }
      tick();
      timer = window.setInterval(tick, METER_INTERVAL_MS);
    };
    document.addEventListener("visibilitychange", syncTimer);
    syncTimer();
    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [isActive]);

  return <div className="master-meter" title="Final output level (L / R)">
    {["L", "R"].map((label, channel) => <div className="master-meter-row" key={label}>
      <span className="master-meter-ch">{label}</span>
      <div className="master-meter-track">
        <div ref={maskRefs[channel]} className="master-meter-mask" />
      </div>
      <div ref={clipRefs[channel]} className="master-meter-clip" title="Clip (> 0 dBFS)" />
    </div>)}
  </div>;
}

// Rotary knob driven by vertical pointer drag. Alt/Option-click (or double-click)
// resets to the supplied default value.
function Knob({ label, value, min, max, defaultValue, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const range = max - min;
  const fraction = range === 0 ? 0 : (value - min) / range;
  // Sweep the indicator across a 270° arc, centred at the top (12 o'clock).
  const angle = -135 + fraction * 270;

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      const delta = (drag.current.startY - event.clientY) / 140;
      onChange(Math.min(max, Math.max(min, drag.current.startValue + delta * range)));
    };
    const up = () => { drag.current = null; setDragging(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, min, max, range, onChange]);

  return <div className={`master-knob ${dragging ? "dragging" : ""}`}>
    <div className="master-knob-dial"
      onPointerDown={(event) => {
        event.preventDefault();
        // Alt (Windows) / Option (macOS) click resets instead of dragging.
        if (event.altKey) { onChange(defaultValue); return; }
        drag.current = { startY: event.clientY, startValue: value };
        setDragging(true);
      }}
      onDoubleClick={() => onChange(defaultValue)}>
      <span className="master-knob-indicator" style={{ transform: `rotate(${angle}deg)` }} />
    </div>
    <span className="master-knob-label">{label}</span>
    <output className="master-knob-value">{format(value)}</output>
  </div>;
}

export function MasterControls({ volume, pan, isActive, onVolume, onPan }: {
  volume: number;
  pan: number;
  isActive: boolean;
  onVolume: (value: number) => void;
  onPan: (value: number) => void;
}) {
  return <div className="master-controls">
    <MasterMeter isActive={isActive} />
    <Knob label="VOL" value={volume} min={0} max={1} defaultValue={1}
      format={(value) => `${Math.round(value * 100)}%`} onChange={onVolume} />
    <Knob label="PAN" value={pan} min={-1} max={1} defaultValue={0}
      format={(value) => value === 0 ? "C" : `${value < 0 ? "L" : "R"}${Math.round(Math.abs(value) * 100)}`}
      onChange={onPan} />
  </div>;
}
