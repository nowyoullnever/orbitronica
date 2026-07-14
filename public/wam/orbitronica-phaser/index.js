// plugins/src/orbitronica-phaser/index.ts
var defaults = { rate: 0.3, depth: 0.5, stages: 6, feedback: 0.2, mix: 0 };
var clamp = (n, a, b) => Math.min(b, Math.max(a, n));
var dangerous = (v) => !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => ["__proto__", "constructor", "prototype"].includes(k) || dangerous(x));
var PhaserNode = class {
  input;
  output;
  stages = [];
  taps = [];
  wetBus;
  feedbackGain;
  cycleBreak;
  dry;
  wet;
  lfo;
  modulation;
  offsets = [];
  #state = { schemaVersion: 1, params: { ...defaults } };
  #destroyed = false;
  #disconnectInput;
  constructor(context) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.wetBus = context.createGain();
    this.feedbackGain = context.createGain();
    this.cycleBreak = context.createDelay(0.1);
    this.cycleBreak.delayTime.value = 1 / context.sampleRate;
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.lfo = context.createOscillator();
    this.modulation = context.createGain();
    this.lfo.type = "sine";
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wetBus.connect(this.wet);
    this.wet.connect(this.output);
    this.wetBus.connect(this.feedbackGain);
    this.feedbackGain.connect(this.cycleBreak);
    for (let i = 0; i < 8; i++) {
      const stage = context.createBiquadFilter();
      stage.type = "allpass";
      stage.Q.value = 0.7;
      const offset = context.createConstantSource();
      offset.connect(stage.frequency);
      this.offsets.push(offset);
      this.stages.push(stage);
      if (i) this.stages[i - 1].connect(stage);
      const tap = context.createGain();
      tap.gain.value = 0;
      stage.connect(tap);
      tap.connect(this.wetBus);
      this.taps.push(tap);
    }
    this.input.connect(this.stages[0]);
    this.cycleBreak.connect(this.stages[0]);
    this.lfo.connect(this.modulation);
    for (const stage of this.stages) this.modulation.connect(stage.frequency);
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    for (const source of this.offsets) source.start();
    this.lfo.start();
    this.apply(this.#state.params);
    Object.defineProperties(this.input, { connect: { value: this.output.connect.bind(this.output) }, disconnect: { value: this.output.disconnect.bind(this.output) }, destroy: { value: () => this.destroy() }, getState: { value: () => this.getState() }, setState: { value: (v) => this.setState(v) }, paramMgr: { value: { getState: async () => structuredClone(this.#state.params), getParamsValues: () => structuredClone(this.#state.params), setState: async (p) => this.setState({ schemaVersion: 1, params: p }) } } });
  }
  apply(p) {
    const now = this.output.context.currentTime, maxHz = Math.min(2e4, 0.45 * this.output.context.sampleRate), span = 800 * p.depth, selected = Math.round(p.stages) - 4;
    this.lfo.frequency.setTargetAtTime(p.rate, now, 0.02);
    this.modulation.gain.setTargetAtTime(span, now, 0.02);
    this.feedbackGain.gain.setTargetAtTime(clamp(p.feedback, -0.12, 0.12), now, 0.02);
    this.dry.gain.setTargetAtTime(Math.cos(p.mix * Math.PI / 2), now, 0.02);
    this.wet.gain.setTargetAtTime(Math.sin(p.mix * Math.PI / 2), now, 0.02);
    for (let i = 0; i < 8; i++) {
      const center = clamp(200 * 1.34 ** i, 20, maxHz);
      this.offsets[i].offset.setTargetAtTime(center, now, 0.02);
      const target = i === selected ? 1 : 0;
      this.taps[i].gain.setTargetAtTime(target, now, 0.015);
    }
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(v) {
    if (!v || typeof v !== "object" || Array.isArray(v) || dangerous(v)) throw new Error("invalid-phaser-state");
    const src = v;
    if (src.schemaVersion !== void 0 && src.schemaVersion !== 0 && src.schemaVersion !== 1) throw new Error("unsupported-phaser-state");
    const incoming = src.params ?? src, old = this.#state.params;
    const raw = { rate: incoming.rate ?? old.rate, depth: incoming.depth ?? old.depth, stages: incoming.stages ?? old.stages, feedback: incoming.feedback ?? old.feedback, mix: incoming.mix ?? old.mix };
    if (!Object.values(raw).every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("invalid-phaser-state");
    this.#state = { schemaVersion: 1, params: { rate: clamp(raw.rate, 0.05, 10), depth: clamp(raw.depth, 0, 1), stages: Math.round(clamp(raw.stages, 4, 8)), feedback: clamp(raw.feedback, -0.95, 0.95), mix: clamp(raw.mix, 0, 1) } };
    this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.lfo.stop();
    for (const source of this.offsets) source.stop();
    this.#disconnectInput();
    for (const n of [this.lfo, this.modulation, this.wetBus, this.feedbackGain, this.cycleBreak, this.dry, this.wet, this.output, ...this.stages, ...this.taps, ...this.offsets]) n.disconnect();
  }
};
var Module = class {
  async createInstance(_group, context) {
    const node = new PhaserNode(context);
    return { audioNode: node.input, createGui: () => {
      const root = document.createElement("div");
      root.textContent = "Orbitronica Phaser";
      return root;
    }, destroyGui: (gui) => gui.remove() };
  }
};
var index_default = new Module();
export {
  index_default as default
};
