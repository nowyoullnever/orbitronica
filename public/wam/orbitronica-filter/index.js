// plugins/src/orbitronica-filter/index.ts
var TYPES = ["lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf"];
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
var maxHz = (context) => Math.min(2e4, 0.45 * context.sampleRate);
var stateRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
var isDangerous = (value) => {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || isDangerous(child)) return true;
  }
  return false;
};
var OrbitronicaFilterNode = class {
  input;
  output;
  filter;
  #destroyed = false;
  #state;
  constructor(context) {
    this.input = context.createGain();
    this.filter = context.createBiquadFilter();
    this.output = context.createGain();
    this.input.connect(this.filter);
    this.filter.connect(this.output);
    this.#state = { schemaVersion: 1, params: { type: "lowpass", frequency: maxHz(context), Q: 0.707, gain: 0 } };
    this.apply(this.#state.params);
    const nativeConnect = this.input.connect.bind(this.input);
    const nativeDisconnect = this.input.disconnect.bind(this.input);
    Object.defineProperty(this.input, "connect", { value: this.output.connect.bind(this.output) });
    Object.defineProperty(this.input, "disconnect", { value: this.output.disconnect.bind(this.output) });
    Object.defineProperty(this.input, "destroy", { value: () => this.destroy() });
    Object.defineProperty(this.input, "getState", { value: () => this.getState() });
    Object.defineProperty(this.input, "setState", { value: (state) => this.setState(state) });
    Object.defineProperty(this.input, "__orbitronicaNativeDisconnect", { value: nativeDisconnect });
    void nativeConnect;
  }
  apply(params) {
    const now = this.filter.context.currentTime;
    this.filter.type = params.type;
    this.filter.frequency.setTargetAtTime(params.frequency, now, 0.02);
    this.filter.Q.setTargetAtTime(params.Q, now, 0.02);
    this.filter.gain.setTargetAtTime(params.gain, now, 0.02);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!stateRecord(value) || isDangerous(value)) throw new Error("invalid-filter-state");
    const state = value;
    if (state.schemaVersion !== void 0 && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-filter-state");
    const incoming = state.params ?? state;
    if (!stateRecord(incoming) || isDangerous(incoming)) throw new Error("invalid-filter-state");
    const current = this.#state.params;
    const type = incoming.type === void 0 ? current.type : incoming.type;
    const frequency = incoming.frequency === void 0 ? current.frequency : incoming.frequency;
    const Q = incoming.Q === void 0 ? current.Q : incoming.Q;
    const gain = incoming.gain === void 0 ? current.gain : incoming.gain;
    if (!TYPES.includes(type) || ![frequency, Q, gain].every(Number.isFinite)) throw new Error("invalid-filter-state");
    const next = { schemaVersion: 1, params: {
      type,
      frequency: clamp(frequency, 20, maxHz(this.filter.context)),
      Q: clamp(Q, 0.1, 20),
      gain: clamp(gain, -24, 24)
    } };
    this.apply(next.params);
    this.#state = next;
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.input.disconnect();
    this.filter.disconnect();
    this.output.disconnect();
  }
};
var OrbitronicaFilterModule = class {
  async createInstance(_groupId, context) {
    const node = new OrbitronicaFilterNode(context);
    return {
      audioNode: node.input,
      createGui: () => {
        const root = document.createElement("div");
        root.textContent = "Orbitronica Filter";
        return root;
      },
      destroyGui: (gui) => gui.remove()
    };
  }
};
var index_default = new OrbitronicaFilterModule();
export {
  index_default as default
};
