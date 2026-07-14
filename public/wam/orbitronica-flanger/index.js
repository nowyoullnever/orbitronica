// plugins/src/orbitronica-flanger/index.ts
var stateRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
var defaults = { rate: 0.25, depth: 3e-3, feedback: 0.25, mix: 0 };
var clamp = (n, a, b) => Math.min(b, Math.max(a, n));
var dangerous = (v) => !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => ["__proto__", "constructor", "prototype"].includes(k) || dangerous(x));
var FlangerNode = class {
  input;
  output;
  delay;
  lfo;
  depth;
  offset;
  feedbackNode;
  wet;
  dry;
  #state = { schemaVersion: 1, params: { ...defaults } };
  #destroyed = false;
  #disconnectInput;
  constructor(context) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.delay = context.createDelay(0.02);
    this.lfo = context.createOscillator();
    this.depth = context.createGain();
    this.offset = context.createConstantSource();
    this.feedbackNode = context.createGain();
    this.wet = context.createGain();
    this.dry = context.createGain();
    this.lfo.type = "sine";
    this.offset.connect(this.delay.delayTime);
    this.lfo.connect(this.depth);
    this.depth.connect(this.delay.delayTime);
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);
    this.delay.connect(this.feedbackNode);
    this.feedbackNode.connect(this.delay);
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    this.offset.start();
    this.lfo.start();
    this.apply(this.#state.params);
    Object.defineProperties(this.input, { connect: { value: this.output.connect.bind(this.output) }, disconnect: { value: this.output.disconnect.bind(this.output) }, destroy: { value: () => this.destroy() }, getState: { value: () => this.getState() }, setState: { value: (v) => this.setState(v) }, paramMgr: { value: { getState: async () => structuredClone(this.#state.params), getParamsValues: () => structuredClone(this.#state.params), setState: async (p) => this.setState({ schemaVersion: 1, params: p }) } } });
  }
  apply(p) {
    const now = this.delay.context.currentTime;
    this.lfo.frequency.setTargetAtTime(p.rate, now, 0.02);
    this.offset.offset.setTargetAtTime(0.01, now, 0.02);
    this.depth.gain.setTargetAtTime(p.depth, now, 0.02);
    this.feedbackNode.gain.setTargetAtTime(p.feedback, now, 0.02);
    this.dry.gain.setTargetAtTime(Math.cos(p.mix * Math.PI / 2), now, 0.02);
    this.wet.gain.setTargetAtTime(Math.sin(p.mix * Math.PI / 2), now, 0.02);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(v) {
    if (!stateRecord(v) || dangerous(v)) throw new Error("invalid-flanger-state");
    const source = v;
    if (source.schemaVersion !== void 0 && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-flanger-state");
    const incoming = source.params === void 0 ? source : source.params;
    if (!stateRecord(incoming) || dangerous(incoming)) throw new Error("invalid-flanger-state");
    const old = this.#state.params;
    const raw = { rate: incoming.rate ?? old.rate, depth: incoming.depth ?? old.depth, feedback: incoming.feedback ?? old.feedback, mix: incoming.mix ?? old.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-flanger-state");
    this.#state = { schemaVersion: 1, params: { rate: clamp(raw.rate, 0.05, 10), depth: clamp(raw.depth, 0, 9e-3), feedback: clamp(raw.feedback, -0.95, 0.95), mix: clamp(raw.mix, 0, 1) } };
    this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.lfo.stop();
    this.offset.stop();
    this.#disconnectInput();
    for (const n of [this.delay, this.lfo, this.depth, this.offset, this.feedbackNode, this.wet, this.dry, this.output]) n.disconnect();
  }
};
var Module = class {
  async createInstance(_group, context) {
    const node = new FlangerNode(context);
    return { audioNode: node.input, createGui: () => {
      const root = document.createElement("div");
      root.textContent = "Orbitronica Flanger";
      return root;
    }, destroyGui: (gui) => gui.remove() };
  }
};
var index_default = new Module();
export {
  index_default as default
};
