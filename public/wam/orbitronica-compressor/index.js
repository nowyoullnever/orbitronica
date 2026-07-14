// plugins/src/orbitronica-compressor/index.ts
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
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
      threshold: clamp(values.threshold, -100, 0),
      knee: clamp(values.knee, 0, 40),
      ratio: clamp(values.ratio, 1, 20),
      attack: clamp(values.attack, 0, 1),
      release: clamp(values.release, 0, 1),
      makeupGain: clamp(values.makeupGain, -24, 24)
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
      createGui: () => {
        const root = document.createElement("div");
        root.textContent = "Orbitronica Compressor";
        return root;
      },
      destroyGui: (gui) => gui.remove()
    };
  }
};
var index_default = new OrbitronicaCompressorModule();
export {
  index_default as default
};
