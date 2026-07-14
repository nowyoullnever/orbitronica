// plugins/src/orbitronica-overdrive/index.ts
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
var isDangerous = (value) => {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "__proto__" || key === "constructor" || key === "prototype" || isDangerous(child));
};
var OrbitronicaOverdriveNode = class {
  input;
  output;
  shaper;
  tone;
  wet;
  dry;
  #state = { schemaVersion: 1, params: { drive: 0.35, tone: 6e3, outputGain: 0, mix: 0 } };
  #destroyed = false;
  constructor(context) {
    this.input = context.createGain();
    this.shaper = context.createWaveShaper();
    this.tone = context.createBiquadFilter();
    this.wet = context.createGain();
    this.dry = context.createGain();
    this.output = context.createGain();
    this.tone.type = "lowpass";
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.shaper);
    this.shaper.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.output);
    this.apply(this.#state.params);
    Object.defineProperties(this.input, {
      connect: { value: this.output.connect.bind(this.output) },
      disconnect: { value: this.output.disconnect.bind(this.output) },
      destroy: { value: () => this.destroy() },
      getState: { value: () => this.getState() },
      setState: { value: (value) => this.setState(value) }
    });
  }
  apply(params) {
    const now = this.tone.context.currentTime, drive = params.drive;
    const samples = 2048, curve = new Float32Array(samples), k = 1 + drive * 80;
    for (let index = 0; index < samples; index++) {
      const x = index * 2 / (samples - 1) - 1;
      curve[index] = Math.tanh(k * x) / Math.tanh(k);
    }
    this.shaper.curve = curve;
    this.shaper.oversample = "4x";
    this.tone.frequency.setTargetAtTime(params.tone, now, 0.02);
    this.output.gain.setTargetAtTime(10 ** (params.outputGain / 20), now, 0.02);
    this.dry.gain.setTargetAtTime(Math.cos(params.mix * Math.PI / 2), now, 0.02);
    this.wet.gain.setTargetAtTime(Math.sin(params.mix * Math.PI / 2), now, 0.02);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!value || typeof value !== "object" || isDangerous(value)) throw new Error("invalid-overdrive-state");
    const state = value;
    if (state.schemaVersion !== void 0 && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-overdrive-state");
    const incoming = state.params ?? state, current = this.#state.params;
    const next = { drive: incoming.drive ?? current.drive, tone: incoming.tone ?? current.tone, outputGain: incoming.outputGain ?? current.outputGain, mix: incoming.mix ?? current.mix };
    if (!Object.values(next).every(Number.isFinite)) throw new Error("invalid-overdrive-state");
    this.#state = { schemaVersion: 1, params: { drive: clamp(next.drive, 0, 1), tone: clamp(next.tone, 500, 12e3), outputGain: clamp(next.outputGain, -24, 12), mix: clamp(next.mix, 0, 1) } };
    this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const node of [this.input, this.shaper, this.tone, this.wet, this.dry, this.output]) node.disconnect();
  }
};
var OrbitronicaOverdriveModule = class {
  async createInstance(_groupId, context) {
    const node = new OrbitronicaOverdriveNode(context);
    return { audioNode: node.input, createGui: () => {
      const gui = document.createElement("div");
      gui.textContent = "Orbitronica Overdrive";
      return gui;
    }, destroyGui: (gui) => gui.remove() };
  }
};
var index_default = new OrbitronicaOverdriveModule();
export {
  index_default as default
};
