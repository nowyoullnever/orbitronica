type Params = { threshold: number; knee: number; ratio: number; attack: number; release: number; makeupGain: number };
type State = { schemaVersion: 1; params: Params };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dangerousKey = new Set(["__proto__", "constructor", "prototype"]);
const hasDangerousKey = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => dangerousKey.has(key) || hasDangerousKey(child));
};

class OrbitronicaCompressorNode {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly makeup: GainNode;
  readonly paramMgr: { getState(): Promise<Params>; setState(params: Record<string, number>): Promise<void>; getParamsValues(): Params };
  #state: State = { schemaVersion: 1, params: { threshold: -24, knee: 30, ratio: 1, attack: 0.003, release: 0.25, makeupGain: 0 } };
  #destroyed = false;
  #disconnectInput: () => void;

  constructor(context: AudioContext) {
    this.input = context.createGain();
    this.compressor = context.createDynamicsCompressor();
    this.makeup = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.compressor); this.compressor.connect(this.makeup); this.makeup.connect(this.output);
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    this.apply(this.#state.params);
    this.paramMgr = {
      getState: async () => structuredClone(this.#state.params),
      setState: async (params) => this.setState({ schemaVersion: 1, params }),
      getParamsValues: () => structuredClone(this.#state.params),
    };
    Object.defineProperties(this.input, {
      connect: { value: this.output.connect.bind(this.output) },
      disconnect: { value: this.output.disconnect.bind(this.output) },
      destroy: { value: () => this.destroy() },
      getState: { value: () => this.getState() },
      setState: { value: (value: unknown) => this.setState(value) },
      paramMgr: { value: this.paramMgr },
    });
  }

  private apply(params: Params) {
    const now = this.compressor.context.currentTime;
    this.compressor.threshold.setTargetAtTime(params.threshold, now, 0.02);
    this.compressor.knee.setTargetAtTime(params.knee, now, 0.02);
    this.compressor.ratio.setTargetAtTime(params.ratio, now, 0.02);
    this.compressor.attack.setTargetAtTime(params.attack, now, 0.02);
    this.compressor.release.setTargetAtTime(params.release, now, 0.02);
    this.makeup.gain.setTargetAtTime(10 ** (params.makeupGain / 20), now, 0.02);
  }

  async getState(): Promise<State> { return structuredClone(this.#state); }

  async setState(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || hasDangerousKey(value)) throw new Error("invalid-compressor-state");
    const state = value as { schemaVersion?: unknown; params?: unknown };
    if (state.schemaVersion !== undefined && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-compressor-state");
    const incomingValue = state.params ?? state;
    if (!incomingValue || typeof incomingValue !== "object" || Array.isArray(incomingValue) || hasDangerousKey(incomingValue)) throw new Error("invalid-compressor-state");
    const incoming = incomingValue as Record<string, unknown>;
    const current = this.#state.params;
    const values: Params = {
      threshold: incoming.threshold === undefined ? current.threshold : incoming.threshold as number,
      knee: incoming.knee === undefined ? current.knee : incoming.knee as number,
      ratio: incoming.ratio === undefined ? current.ratio : incoming.ratio as number,
      attack: incoming.attack === undefined ? current.attack : incoming.attack as number,
      release: incoming.release === undefined ? current.release : incoming.release as number,
      makeupGain: incoming.makeupGain === undefined ? current.makeupGain : incoming.makeupGain as number,
    };
    if (!Object.values(values).every(Number.isFinite)) throw new Error("invalid-compressor-state");
    const next: State = { schemaVersion: 1, params: {
      threshold: clamp(values.threshold, -100, 0), knee: clamp(values.knee, 0, 40), ratio: clamp(values.ratio, 1, 20),
      attack: clamp(values.attack, 0, 1), release: clamp(values.release, 0, 1), makeupGain: clamp(values.makeupGain, -24, 24),
    } };
    this.apply(next.params);
    this.#state = next;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#disconnectInput(); this.compressor.disconnect(); this.makeup.disconnect(); this.output.disconnect();
  }
}

class OrbitronicaCompressorModule {
  async createInstance(_groupId: string, context: AudioContext) {
    const node = new OrbitronicaCompressorNode(context);
    return {
      audioNode: node.input,
      createGui: () => { const root = document.createElement("div"); root.textContent = "Orbitronica Compressor"; return root; },
      destroyGui: (gui: HTMLElement) => gui.remove(),
    };
  }
}

export default new OrbitronicaCompressorModule();
