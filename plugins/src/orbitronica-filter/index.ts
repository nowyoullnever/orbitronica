import { createKnobPanel, fmt } from "../shared/knobPanel";

const TYPES = ["lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf"] as const;
type FilterType = typeof TYPES[number];
type FilterState = { schemaVersion: 1; params: { type: FilterType; frequency: number; Q: number; gain: number } };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const maxHz = (context: BaseAudioContext) => Math.min(20_000, 0.45 * context.sampleRate);
const stateRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isDangerous = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || isDangerous(child)) return true;
  }
  return false;
};

class OrbitronicaFilterNode {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly filter: BiquadFilterNode;
  #destroyed = false;
  #state: FilterState;

  constructor(context: AudioContext) {
    this.input = context.createGain();
    this.filter = context.createBiquadFilter();
    this.output = context.createGain();
    this.input.connect(this.filter);
    this.filter.connect(this.output);
    this.#state = { schemaVersion: 1, params: { type: "lowpass", frequency: maxHz(context), Q: 0.707, gain: 0 } };
    this.apply(this.#state.params);
    const nativeConnect = this.input.connect.bind(this.input);
    const nativeDisconnect = this.input.disconnect.bind(this.input);
    // The input node is the browser-facing destination; redirect rack output edges.
    Object.defineProperty(this.input, "connect", { value: this.output.connect.bind(this.output) });
    Object.defineProperty(this.input, "disconnect", { value: this.output.disconnect.bind(this.output) });
    Object.defineProperty(this.input, "destroy", { value: () => this.destroy() });
    Object.defineProperty(this.input, "getState", { value: () => this.getState() });
    Object.defineProperty(this.input, "setState", { value: (state: unknown) => this.setState(state) });
    Object.defineProperty(this.input, "__orbitronicaNativeDisconnect", { value: nativeDisconnect });
    // Preserve native input graph setup before exposing the composite endpoint.
    void nativeConnect;
  }

  private apply(params: FilterState["params"]) {
    const now = this.filter.context.currentTime;
    this.filter.type = params.type;
    this.filter.frequency.setTargetAtTime(params.frequency, now, 0.02);
    this.filter.Q.setTargetAtTime(params.Q, now, 0.02);
    this.filter.gain.setTargetAtTime(params.gain, now, 0.02);
  }

  async getState(): Promise<FilterState> { return structuredClone(this.#state); }

  async setState(value: unknown): Promise<void> {
    if (!stateRecord(value) || isDangerous(value)) throw new Error("invalid-filter-state");
    const state = value as { schemaVersion?: unknown; params?: unknown };
    if (state.schemaVersion !== undefined && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-filter-state");
    const incoming = state.params ?? state;
    if (!stateRecord(incoming) || isDangerous(incoming)) throw new Error("invalid-filter-state");
    const current = this.#state.params;
    const type = incoming.type === undefined ? current.type : incoming.type;
    const frequency = incoming.frequency === undefined ? current.frequency : incoming.frequency;
    const Q = incoming.Q === undefined ? current.Q : incoming.Q;
    const gain = incoming.gain === undefined ? current.gain : incoming.gain;
    if (!TYPES.includes(type as FilterType) || ![frequency, Q, gain].every(Number.isFinite)) throw new Error("invalid-filter-state");
    const next: FilterState = { schemaVersion: 1, params: {
      type: type as FilterType,
      frequency: clamp(frequency as number, 20, maxHz(this.filter.context)),
      Q: clamp(Q as number, 0.1, 20),
      gain: clamp(gain as number, -24, 24),
    } };
    this.apply(next.params);
    this.#state = next;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.input.disconnect(); this.filter.disconnect(); this.output.disconnect();
  }
}

class OrbitronicaFilterModule {
  async createInstance(_groupId: string, context: AudioContext) {
    const node = new OrbitronicaFilterNode(context);
    return {
      audioNode: node.input,
      createGui: () => createKnobPanel("Orbitronica Filter", node, [
        { kind: "select", key: "type", label: "Type", options: TYPES },
        { kind: "knob", key: "frequency", label: "Freq", min: 20, max: maxHz(context), scale: "log", format: fmt.hz },
        { kind: "knob", key: "Q", label: "Q", min: 0.1, max: 20, scale: "log" },
        { kind: "knob", key: "gain", label: "Gain", min: -24, max: 24, format: fmt.db },
      ]),
      destroyGui: (gui: HTMLElement) => gui.remove(),
    };
  }
}

export default new OrbitronicaFilterModule();
