/*
 * Shared, dependency-free control-panel renderer for Orbitronica's first-party
 * WAM plugins.  esbuild bundles this module into each plugin's `index.js`
 * (bundle: true), so every plugin still ships one self-contained GUI inside its
 * own `createGui()` — this file only removes the knob-drag and accessibility
 * boilerplate that would otherwise be copied into all seven plugins.
 *
 * A control writes back through the plugin node's own `setState({schemaVersion,
 * params})`.  Because every first-party node merges partial params
 * (`incoming.x ?? current.x`), a single changed knob sends only its own key,
 * and the host captures the merged result on save/freeze via `getState()`.
 */

type StatefulNode = {
  getState(): Promise<{ params?: Record<string, unknown> } | unknown>;
  setState(state: unknown): Promise<void>;
};

export type KnobControl = {
  kind: "knob";
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  scale?: "linear" | "log";
  format?: (value: number) => string;
};
export type SelectControl = {
  kind: "select";
  key: string;
  label: string;
  options: readonly string[];
};
export type Control = KnobControl | SelectControl;

/** Shared readout formatters so every plugin shows units consistently. */
export const fmt = {
  hz: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : v >= 100 ? `${Math.round(v)} Hz` : `${v.toFixed(2)} Hz`),
  db: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`,
  pct: (v: number) => `${Math.round(v * 100)}%`,
  ms: (v: number) => { const m = v * 1000; return `${m >= 100 ? Math.round(m) : m.toFixed(1)} ms`; },
  ratio: (v: number) => `${v.toFixed(1)}:1`,
  int: (v: number) => `${Math.round(v)}`,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const toFraction = (control: KnobControl, value: number): number => {
  const { min, max } = control;
  if (control.scale === "log") {
    const lo = Math.log(Math.max(min, 1e-6));
    const hi = Math.log(Math.max(max, 1e-6));
    return clamp((Math.log(Math.max(value, 1e-6)) - lo) / (hi - lo || 1), 0, 1);
  }
  return clamp((value - min) / (max - min || 1), 0, 1);
};

const fromFraction = (control: KnobControl, fraction: number): number => {
  const { min, max, step } = control;
  let value: number;
  if (control.scale === "log") {
    const lo = Math.log(Math.max(min, 1e-6));
    const hi = Math.log(Math.max(max, 1e-6));
    value = Math.exp(lo + (hi - lo) * fraction);
  } else {
    value = min + (max - min) * fraction;
  }
  if (step) value = Math.round(value / step) * step;
  return clamp(value, min, max);
};

const defaultFormat = (control: KnobControl, value: number): string => {
  if (control.format) return control.format(value);
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return value.toFixed(digits);
};

const STYLE_ID = "orbitronica-knob-panel-style";
// Mirrors the host's light theme and .master-knob styling in styles.css so the
// panel reads as native chrome rather than a foreign dark widget.
const CSS = `
.opw-panel{font:11px "MapoFlowerIsland",system-ui,sans-serif;color:#242520;display:flex;flex-direction:column;gap:10px;padding:12px 14px;min-width:220px}
.opw-title{font:9px "MapoFlowerIsland",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#777870}
.opw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:16px 10px;align-items:start}
.opw-ctl{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;user-select:none}
.opw-ctl>label{font:8px "MapoFlowerIsland",sans-serif;letter-spacing:.12em;color:#8a897f}
.opw-knob{width:42px;height:42px;border-radius:50%;position:relative;cursor:ns-resize;touch-action:none;
  background:radial-gradient(circle at 50% 38%,#fbfaf6,#dedcd4);border:1px solid #c7c5bd;
  box-shadow:0 1px 2px rgba(0,0,0,.12),inset 0 1px 1px rgba(255,255,255,.8);outline:none}
.opw-knob:focus-visible{border-color:#4b9967;box-shadow:0 0 0 2px rgba(75,153,103,.35)}
.opw-knob::after{content:"";position:absolute;left:50%;top:5px;width:2px;height:13px;margin-left:-1px;border-radius:1px;
  background:#4d4f47;transform-origin:50% 16px;transform:rotate(var(--angle,0deg))}
.opw-knob:active::after{background:#3d6e51}
.opw-readout{font:9px system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#55564e;min-height:12px}
.opw-select{background:#f8f7f2;color:#292a25;border:1px solid #cccbc4;border-radius:3px;padding:4px 6px;font:10px "MapoFlowerIsland",sans-serif}
`;

const ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
};

function buildKnob(control: KnobControl, initial: number, commit: (value: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "opw-ctl";
  const label = document.createElement("label");
  label.textContent = control.label;
  const knob = document.createElement("div");
  knob.className = "opw-knob";
  knob.tabIndex = 0;
  knob.setAttribute("role", "slider");
  knob.setAttribute("aria-label", control.label);
  const readout = document.createElement("div");
  readout.className = "opw-readout";

  let value = clamp(initial, control.min, control.max);
  const render = () => {
    const angle = -135 + toFraction(control, value) * 270;
    knob.style.setProperty("--angle", `${angle}deg`);
    readout.textContent = defaultFormat(control, value);
    knob.setAttribute("aria-valuenow", String(Number(value.toFixed(4))));
    knob.setAttribute("aria-valuemin", String(control.min));
    knob.setAttribute("aria-valuemax", String(control.max));
    knob.setAttribute("aria-valuetext", readout.textContent ?? "");
  };
  const setFraction = (fraction: number) => {
    value = fromFraction(control, clamp(fraction, 0, 1));
    render();
    commit(value);
  };
  const nudge = (deltaFraction: number) => setFraction(toFraction(control, value) + deltaFraction);

  knob.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    knob.focus();
    knob.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startFraction = toFraction(control, value);
    const move = (moveEvent: PointerEvent) => {
      const fine = moveEvent.shiftKey ? 0.25 : 1;
      setFraction(startFraction + ((startY - moveEvent.clientY) / 180) * fine);
    };
    const release = (upEvent: PointerEvent) => {
      try { knob.releasePointerCapture(upEvent.pointerId); } catch { /* already released */ }
      knob.removeEventListener("pointermove", move);
      knob.removeEventListener("pointerup", release);
      knob.removeEventListener("pointercancel", release);
    };
    knob.addEventListener("pointermove", move);
    knob.addEventListener("pointerup", release);
    knob.addEventListener("pointercancel", release);
  });
  knob.addEventListener("wheel", (event) => {
    event.preventDefault();
    nudge((event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 0.01 : 0.04));
  }, { passive: false });
  knob.addEventListener("keydown", (event) => {
    const big = event.shiftKey ? 0.1 : 0.02;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); nudge(big); }
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); nudge(-big); }
    else if (event.key === "Home") { event.preventDefault(); setFraction(0); }
    else if (event.key === "End") { event.preventDefault(); setFraction(1); }
  });

  render();
  wrap.append(label, knob, readout);
  return wrap;
}

function buildSelect(control: SelectControl, initial: string, commit: (value: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "opw-ctl";
  const label = document.createElement("label");
  label.textContent = control.label;
  const select = document.createElement("select");
  select.className = "opw-select";
  select.setAttribute("aria-label", control.label);
  for (const option of control.options) {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = option;
    if (option === initial) element.selected = true;
    select.append(element);
  }
  select.addEventListener("change", () => commit(select.value));
  wrap.append(label, select);
  return wrap;
}

const buildControl = (
  control: Control,
  params: Record<string, unknown>,
  write: (key: string, value: number | string) => void,
): HTMLElement => {
  if (control.kind === "select") {
    const raw = params[control.key];
    const current = typeof raw === "string" && control.options.includes(raw) ? raw : control.options[0];
    return buildSelect(control, current, (value) => write(control.key, value));
  }
  const raw = params[control.key];
  const current = typeof raw === "number" && Number.isFinite(raw) ? raw : control.min;
  return buildKnob(control, current, (value) => write(control.key, value));
};

/**
 * Builds a titled control panel bound to `node`.  Returns synchronously with
 * default positions, then reconciles control positions from `node.getState()`
 * once it resolves so a restored project shows its saved values.
 */
export function createKnobPanel(title: string, node: StatefulNode, controls: readonly Control[]): HTMLElement {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "opw-panel";
  const heading = document.createElement("div");
  heading.className = "opw-title";
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "opw-grid";
  root.append(heading, grid);

  const write = (key: string, value: number | string) => {
    void node.setState({ schemaVersion: 1, params: { [key]: value } });
  };
  const populate = (params: Record<string, unknown>) => {
    grid.textContent = "";
    for (const control of controls) grid.append(buildControl(control, params, write));
  };

  populate({});
  void Promise.resolve(node.getState()).then((state) => {
    const params = (state as { params?: Record<string, unknown> })?.params ?? (state as Record<string, unknown>);
    if (params && typeof params === "object") populate(params as Record<string, unknown>);
  }).catch(() => undefined);

  return root;
}
