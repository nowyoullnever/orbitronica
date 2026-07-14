// plugins/src/shared/knobPanel.ts
var fmt = {
  hz: (v) => v >= 1e3 ? `${(v / 1e3).toFixed(2)} kHz` : v >= 100 ? `${Math.round(v)} Hz` : `${v.toFixed(2)} Hz`,
  db: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`,
  pct: (v) => `${Math.round(v * 100)}%`,
  ms: (v) => {
    const m = v * 1e3;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1)} ms`;
  },
  ratio: (v) => `${v.toFixed(1)}:1`,
  int: (v) => `${Math.round(v)}`
};
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
var toFraction = (control, value) => {
  const { min, max } = control;
  if (control.scale === "log") {
    const lo = Math.log(Math.max(min, 1e-6));
    const hi = Math.log(Math.max(max, 1e-6));
    return clamp((Math.log(Math.max(value, 1e-6)) - lo) / (hi - lo || 1), 0, 1);
  }
  return clamp((value - min) / (max - min || 1), 0, 1);
};
var fromFraction = (control, fraction) => {
  const { min, max, step } = control;
  let value;
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
var defaultFormat = (control, value) => {
  if (control.format) return control.format(value);
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return value.toFixed(digits);
};
var STYLE_ID = "orbitronica-knob-panel-style";
var CSS = `
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
var ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
};
function buildKnob(control, initial, commit) {
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
  const setFraction = (fraction) => {
    value = fromFraction(control, clamp(fraction, 0, 1));
    render();
    commit(value);
  };
  const nudge = (deltaFraction) => setFraction(toFraction(control, value) + deltaFraction);
  knob.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    knob.focus();
    knob.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startFraction = toFraction(control, value);
    const move = (moveEvent) => {
      const fine = moveEvent.shiftKey ? 0.25 : 1;
      setFraction(startFraction + (startY - moveEvent.clientY) / 180 * fine);
    };
    const release = (upEvent) => {
      try {
        knob.releasePointerCapture(upEvent.pointerId);
      } catch {
      }
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
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      nudge(big);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      nudge(-big);
    } else if (event.key === "Home") {
      event.preventDefault();
      setFraction(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFraction(1);
    }
  });
  render();
  wrap.append(label, knob, readout);
  return wrap;
}
function buildSelect(control, initial, commit) {
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
var buildControl = (control, params, write) => {
  if (control.kind === "select") {
    const raw2 = params[control.key];
    const current2 = typeof raw2 === "string" && control.options.includes(raw2) ? raw2 : control.options[0];
    return buildSelect(control, current2, (value) => write(control.key, value));
  }
  const raw = params[control.key];
  const current = typeof raw === "number" && Number.isFinite(raw) ? raw : control.min;
  return buildKnob(control, current, (value) => write(control.key, value));
};
function createKnobPanel(title, node, controls) {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "opw-panel";
  const heading = document.createElement("div");
  heading.className = "opw-title";
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "opw-grid";
  root.append(heading, grid);
  const write = (key, value) => {
    void node.setState({ schemaVersion: 1, params: { [key]: value } });
  };
  const populate = (params) => {
    grid.textContent = "";
    for (const control of controls) grid.append(buildControl(control, params, write));
  };
  populate({});
  void Promise.resolve(node.getState()).then((state) => {
    const params = state?.params ?? state;
    if (params && typeof params === "object") populate(params);
  }).catch(() => void 0);
  return root;
}

// plugins/src/orbitronica-compressor/index.ts
var clamp2 = (value, min, max) => Math.min(max, Math.max(min, value));
var dangerousKey = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var hasDangerousKey = (value) => {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => dangerousKey.has(key) || hasDangerousKey(child));
};
var OrbitronicaCompressorNode = class {
  input;
  output;
  compressor;
  makeup;
  paramMgr;
  #state = { schemaVersion: 1, params: { threshold: -24, knee: 30, ratio: 1, attack: 3e-3, release: 0.25, makeupGain: 0 } };
  #destroyed = false;
  #disconnectInput;
  constructor(context) {
    this.input = context.createGain();
    this.compressor = context.createDynamicsCompressor();
    this.makeup = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.compressor);
    this.compressor.connect(this.makeup);
    this.makeup.connect(this.output);
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    this.apply(this.#state.params);
    this.paramMgr = {
      getState: async () => structuredClone(this.#state.params),
      setState: async (params) => this.setState({ schemaVersion: 1, params }),
      getParamsValues: () => structuredClone(this.#state.params)
    };
    Object.defineProperties(this.input, {
      connect: { value: this.output.connect.bind(this.output) },
      disconnect: { value: this.output.disconnect.bind(this.output) },
      destroy: { value: () => this.destroy() },
      getState: { value: () => this.getState() },
      setState: { value: (value) => this.setState(value) },
      paramMgr: { value: this.paramMgr }
    });
  }
  apply(params) {
    const now = this.compressor.context.currentTime;
    this.compressor.threshold.setTargetAtTime(params.threshold, now, 0.02);
    this.compressor.knee.setTargetAtTime(params.knee, now, 0.02);
    this.compressor.ratio.setTargetAtTime(params.ratio, now, 0.02);
    this.compressor.attack.setTargetAtTime(params.attack, now, 0.02);
    this.compressor.release.setTargetAtTime(params.release, now, 0.02);
    this.makeup.gain.setTargetAtTime(10 ** (params.makeupGain / 20), now, 0.02);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || hasDangerousKey(value)) throw new Error("invalid-compressor-state");
    const state = value;
    if (state.schemaVersion !== void 0 && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-compressor-state");
    const incomingValue = state.params ?? state;
    if (!incomingValue || typeof incomingValue !== "object" || Array.isArray(incomingValue) || hasDangerousKey(incomingValue)) throw new Error("invalid-compressor-state");
    const incoming = incomingValue;
    const current = this.#state.params;
    const values = {
      threshold: incoming.threshold === void 0 ? current.threshold : incoming.threshold,
      knee: incoming.knee === void 0 ? current.knee : incoming.knee,
      ratio: incoming.ratio === void 0 ? current.ratio : incoming.ratio,
      attack: incoming.attack === void 0 ? current.attack : incoming.attack,
      release: incoming.release === void 0 ? current.release : incoming.release,
      makeupGain: incoming.makeupGain === void 0 ? current.makeupGain : incoming.makeupGain
    };
    if (!Object.values(values).every(Number.isFinite)) throw new Error("invalid-compressor-state");
    const next = { schemaVersion: 1, params: {
      threshold: clamp2(values.threshold, -100, 0),
      knee: clamp2(values.knee, 0, 40),
      ratio: clamp2(values.ratio, 1, 20),
      attack: clamp2(values.attack, 0, 1),
      release: clamp2(values.release, 0, 1),
      makeupGain: clamp2(values.makeupGain, -24, 24)
    } };
    this.apply(next.params);
    this.#state = next;
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#disconnectInput();
    this.compressor.disconnect();
    this.makeup.disconnect();
    this.output.disconnect();
  }
};
var OrbitronicaCompressorModule = class {
  async createInstance(_groupId, context) {
    const node = new OrbitronicaCompressorNode(context);
    return {
      audioNode: node.input,
      createGui: () => createKnobPanel("Orbitronica Compressor", node, [
        { kind: "knob", key: "threshold", label: "Thresh", min: -100, max: 0, format: fmt.db },
        { kind: "knob", key: "knee", label: "Knee", min: 0, max: 40, format: fmt.db },
        { kind: "knob", key: "ratio", label: "Ratio", min: 1, max: 20, format: fmt.ratio },
        { kind: "knob", key: "attack", label: "Attack", min: 0, max: 1, format: fmt.ms },
        { kind: "knob", key: "release", label: "Release", min: 0, max: 1, format: fmt.ms },
        { kind: "knob", key: "makeupGain", label: "Makeup", min: -24, max: 24, format: fmt.db }
      ]),
      destroyGui: (gui) => gui.remove()
    };
  }
};
var index_default = new OrbitronicaCompressorModule();
export {
  index_default as default
};
