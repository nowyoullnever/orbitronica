type Params = { drive: number; tone: number; outputGain: number; mix: number };
type State = { schemaVersion: 1; params: Params };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isDangerous = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === "__proto__" || key === "constructor" || key === "prototype" || isDangerous(child));
};
class OrbitronicaOverdriveNode {
  readonly input: GainNode; readonly output: GainNode;
  readonly shaper: WaveShaperNode; readonly tone: BiquadFilterNode; readonly wet: GainNode; readonly dry: GainNode;
  #state: State = { schemaVersion: 1, params: { drive: 0.35, tone: 6000, outputGain: 0, mix: 0 } };
  #destroyed = false;
  constructor(context: AudioContext) {
    this.input = context.createGain(); this.shaper = context.createWaveShaper(); this.tone = context.createBiquadFilter(); this.wet = context.createGain(); this.dry = context.createGain(); this.output = context.createGain();
    this.tone.type = "lowpass";
    this.input.connect(this.dry); this.dry.connect(this.output); this.input.connect(this.shaper); this.shaper.connect(this.tone); this.tone.connect(this.wet); this.wet.connect(this.output);
    this.apply(this.#state.params);
    Object.defineProperties(this.input, {
      connect: { value: this.output.connect.bind(this.output) }, disconnect: { value: this.output.disconnect.bind(this.output) },
      destroy: { value: () => this.destroy() }, getState: { value: () => this.getState() }, setState: { value: (value: unknown) => this.setState(value) },
    });
  }
  private apply(params: Params) {
    const now = this.tone.context.currentTime, drive = params.drive;
    const samples = 2048, curve = new Float32Array(samples), k = 1 + drive * 80;
    for (let index = 0; index < samples; index++) { const x = index * 2 / (samples - 1) - 1; curve[index] = Math.tanh(k * x) / Math.tanh(k); }
    this.shaper.curve = curve; this.shaper.oversample = "4x";
    this.tone.frequency.setTargetAtTime(params.tone, now, .02); this.output.gain.setTargetAtTime(10 ** (params.outputGain / 20), now, .02);
    this.dry.gain.setTargetAtTime(Math.cos(params.mix * Math.PI / 2), now, .02); this.wet.gain.setTargetAtTime(Math.sin(params.mix * Math.PI / 2), now, .02);
  }
  async getState(): Promise<State> { return structuredClone(this.#state); }
  async setState(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || isDangerous(value)) throw new Error("invalid-overdrive-state");
    const state = value as { schemaVersion?: unknown; params?: unknown }; if (state.schemaVersion !== undefined && state.schemaVersion !== 0 && state.schemaVersion !== 1) throw new Error("unsupported-overdrive-state");
    const incoming = (state.params ?? state) as Record<string, unknown>, current = this.#state.params;
    const next = { drive: incoming.drive ?? current.drive, tone: incoming.tone ?? current.tone, outputGain: incoming.outputGain ?? current.outputGain, mix: incoming.mix ?? current.mix };
    if (!Object.values(next).every(Number.isFinite)) throw new Error("invalid-overdrive-state");
    this.#state = { schemaVersion: 1, params: { drive: clamp(next.drive as number, 0, 1), tone: clamp(next.tone as number, 500, 12000), outputGain: clamp(next.outputGain as number, -24, 12), mix: clamp(next.mix as number, 0, 1) } }; this.apply(this.#state.params);
  }
  destroy() { if (this.#destroyed) return; this.#destroyed = true; for (const node of [this.input, this.shaper, this.tone, this.wet, this.dry, this.output]) node.disconnect(); }
}
class OrbitronicaOverdriveModule { async createInstance(_groupId: string, context: AudioContext) { const node = new OrbitronicaOverdriveNode(context); return { audioNode: node.input, createGui: () => { const gui = document.createElement("div"); gui.textContent = "Orbitronica Overdrive"; return gui; }, destroyGui: (gui: HTMLElement) => gui.remove() }; } }
export default new OrbitronicaOverdriveModule();
