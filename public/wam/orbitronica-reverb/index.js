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

// plugins/src/shared/effectNode.ts
var clamp2 = (value, min, max) => Math.min(max, Math.max(min, value));
var isStateRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
var hasDangerousKey = (value) => {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || hasDangerousKey(child)) return true;
  }
  return false;
};
function installNodeShim(input, output, node, paramMgr) {
  const props = {
    connect: { value: output.connect.bind(output) },
    disconnect: { value: output.disconnect.bind(output) },
    destroy: { value: () => node.destroy() },
    getState: { value: () => node.getState() },
    setState: { value: (value) => node.setState(value) }
  };
  if (paramMgr !== void 0) props.paramMgr = { value: paramMgr };
  Object.defineProperties(input, props);
}
function createParamMgrShim(getParams, setState) {
  return {
    getState: async () => structuredClone(getParams()),
    getParamsValues: () => structuredClone(getParams()),
    setState: async (params) => setState({ schemaVersion: 1, params })
  };
}

// plugins/src/orbitronica-reverb/index.ts
var defaults = { roomSize: 0.5, damping: 0.35, width: 1, mix: 0 };
var COMB_REFERENCE_FRAMES = {
  left: [1371, 1672, 1927, 2306, 2721, 3171, 3674, 4281],
  right: [1473, 1755, 2033, 2456, 2881, 3378, 3934, 4582]
};
var ALLPASS_REFERENCE_FRAMES = { left: [181, 322, 525, 781], right: [207, 379, 578, 851] };
var scaledDelay = (referenceFrames, sampleRate) => {
  const scaledFrames = referenceFrames * sampleRate / 44100;
  return clamp2(scaledFrames / sampleRate, 1 / sampleRate, 0.2);
};
var ReverbNode = class {
  input;
  output;
  splitter;
  merger;
  dry;
  wet;
  wetLeft;
  wetRight;
  combs = [];
  allpasses = [];
  widthGains = [];
  #state = { schemaVersion: 1, params: { ...defaults } };
  #destroyed = false;
  #disconnectInput;
  constructor(context) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.splitter = context.createChannelSplitter(2);
    this.merger = context.createChannelMerger(2);
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.wetLeft = context.createGain();
    this.wetRight = context.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.splitter);
    this.merger.connect(this.wet);
    this.wet.connect(this.output);
    this.wetLeft.connect(this.merger, 0, 0);
    this.wetRight.connect(this.merger, 0, 1);
    for (const side of ["left", "right"]) {
      const combSum = context.createGain();
      for (const frames of COMB_REFERENCE_FRAMES[side]) {
        const comb = this.createComb(context, scaledDelay(frames, context.sampleRate));
        this.combs.push(comb);
        this.splitter.connect(comb.delay, side === "left" ? 0 : 1, 0);
        comb.output.connect(combSum);
      }
      let stageOutput = combSum;
      for (const frames of ALLPASS_REFERENCE_FRAMES[side]) {
        const stage = this.createAllpass(context, scaledDelay(frames, context.sampleRate));
        this.allpasses.push(stage);
        stageOutput.connect(stage.input);
        stageOutput = stage.output;
      }
      const own = context.createGain(), cross = context.createGain();
      this.widthGains.push(own, cross);
      stageOutput.connect(own);
      stageOutput.connect(cross);
      if (side === "left") {
        own.connect(this.wetLeft);
        cross.connect(this.wetRight);
      } else {
        own.connect(this.wetRight);
        cross.connect(this.wetLeft);
      }
    }
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    this.apply(this.#state.params);
    installNodeShim(this.input, this.output, this, createParamMgrShim(() => this.#state.params, (state) => this.setState(state)));
  }
  createComb(context, delayTime) {
    const delay = context.createDelay(0.2), damper = context.createBiquadFilter(), feedback = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime;
    damper.type = "lowpass";
    damper.Q.value = 0.707;
    delay.connect(damper);
    damper.connect(output);
    damper.connect(feedback);
    feedback.connect(delay);
    return { delay, damper, feedback, output };
  }
  createAllpass(context, delayTime) {
    const input = context.createGain(), delay = context.createDelay(0.2), feedback = context.createGain(), direct = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime;
    feedback.gain.value = 0.5;
    direct.gain.value = -0.5;
    input.connect(delay);
    input.connect(direct);
    direct.connect(output);
    delay.connect(output);
    delay.connect(feedback);
    feedback.connect(input);
    return { input, delay, feedback, direct, output };
  }
  apply(params) {
    const now = this.output.context.currentTime;
    const feedback = 0.3 + params.roomSize * 0.6;
    const dampingHz = clamp2(2e4 * 0.015 ** params.damping, 300, 2e4);
    const own = 0.5 + 0.5 * params.width, cross = 0.5 - 0.5 * params.width;
    for (const comb of this.combs) {
      comb.feedback.gain.setTargetAtTime(feedback, now, 0.03);
      comb.damper.frequency.setTargetAtTime(dampingHz, now, 0.03);
    }
    for (let index = 0; index < this.widthGains.length; index += 2) {
      this.widthGains[index].gain.setTargetAtTime(own, now, 0.03);
      this.widthGains[index + 1].gain.setTargetAtTime(cross, now, 0.03);
    }
    this.dry.gain.setTargetAtTime(Math.cos(params.mix * Math.PI / 2), now, 0.03);
    this.wet.gain.setTargetAtTime(Math.sin(params.mix * Math.PI / 2), now, 0.03);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!isStateRecord(value) || hasDangerousKey(value)) throw new Error("invalid-reverb-state");
    const source = value;
    if (source.schemaVersion !== void 0 && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-reverb-state");
    const incoming = source.params === void 0 ? source : source.params;
    if (!isStateRecord(incoming) || hasDangerousKey(incoming)) throw new Error("invalid-reverb-state");
    const old = this.#state.params;
    const raw = { roomSize: incoming.roomSize ?? old.roomSize, damping: incoming.damping ?? old.damping, width: incoming.width ?? old.width, mix: incoming.mix ?? old.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-reverb-state");
    this.#state = { schemaVersion: 1, params: { roomSize: clamp2(raw.roomSize, 0, 1), damping: clamp2(raw.damping, 0, 1), width: clamp2(raw.width, 0, 1), mix: clamp2(raw.mix, 0, 1) } };
    this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#disconnectInput();
    for (const comb of this.combs) for (const node of [comb.delay, comb.damper, comb.feedback, comb.output]) node.disconnect();
    for (const stage of this.allpasses) for (const node of [stage.input, stage.delay, stage.feedback, stage.direct, stage.output]) node.disconnect();
    for (const node of [this.splitter, this.merger, this.dry, this.wet, this.wetLeft, this.wetRight, ...this.widthGains, this.output]) node.disconnect();
  }
};
var Module = class {
  async createInstance(_group, context) {
    const node = new ReverbNode(context);
    return { audioNode: node.input, createGui: () => createKnobPanel("Orbitronica Reverb", node, [
      { kind: "knob", key: "roomSize", label: "Room", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "damping", label: "Damping", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "width", label: "Width", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "mix", label: "Mix", min: 0, max: 1, format: fmt.pct }
    ]), destroyGui: (gui) => gui.remove() };
  }
};
var index_default = new Module();
export {
  index_default as default
};
