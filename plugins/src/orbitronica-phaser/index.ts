import { createKnobPanel, fmt } from "../shared/knobPanel";
import { clamp, createParamMgrShim, installNodeShim, setStateFromRecord, type ParamSpec } from "../shared/effectNode";

type Params = { rate: number; depth: number; stages: number; feedback: number; mix: number };
type State = { schemaVersion: 1; params: Params };
const defaults: Params = { rate: .3, depth: .5, stages: 6, feedback: .2, mix: 0 };
const SPECS: readonly ParamSpec<keyof Params & string>[] = [
  { key: "rate", min: .05, max: 10 },
  { key: "depth", min: 0, max: 1 },
  { key: "stages", min: 4, max: 8, round: true },
  { key: "feedback", min: -.95, max: .95 },
  { key: "mix", min: 0, max: 1 },
];
class PhaserNode {
  readonly input: GainNode; readonly output: GainNode; readonly limiter: WaveShaperNode; readonly stages: BiquadFilterNode[] = []; readonly taps: GainNode[] = []; readonly wetBus: GainNode; readonly feedbackGain: GainNode; readonly cycleBreak: DelayNode; readonly dry: GainNode; readonly wet: GainNode; readonly lfo: OscillatorNode; readonly modulation: GainNode; readonly offsets: ConstantSourceNode[] = [];
  #state: State = { schemaVersion: 1, params: { ...defaults } }; #destroyed = false; #disconnectInput: () => void;
  constructor(context: AudioContext) {
    this.input = context.createGain(); this.output = context.createGain(); this.limiter = context.createWaveShaper(); this.limiter.curve = PhaserNode.limiterCurve(); this.limiter.oversample = "2x"; this.wetBus = context.createGain(); this.feedbackGain = context.createGain(); this.cycleBreak = context.createDelay(.1); this.cycleBreak.delayTime.value = 1 / context.sampleRate; this.dry = context.createGain(); this.wet = context.createGain(); this.lfo = context.createOscillator(); this.modulation = context.createGain(); this.lfo.type = "sine";
    this.input.connect(this.dry); this.dry.connect(this.output); this.wetBus.connect(this.wet); this.wet.connect(this.output); this.wetBus.connect(this.feedbackGain); this.feedbackGain.connect(this.limiter); this.limiter.connect(this.cycleBreak);
    for (let i = 0; i < 8; i++) { const stage = context.createBiquadFilter(); stage.type = "allpass"; stage.Q.value = .7; const offset = context.createConstantSource(); offset.connect(stage.frequency); this.offsets.push(offset); this.stages.push(stage); if (i) this.stages[i - 1].connect(stage); const tap = context.createGain(); tap.gain.value = 0; stage.connect(tap); tap.connect(this.wetBus); this.taps.push(tap); }
    this.input.connect(this.stages[0]); this.cycleBreak.connect(this.stages[0]); this.lfo.connect(this.modulation); for (const stage of this.stages) this.modulation.connect(stage.frequency); this.#disconnectInput = this.input.disconnect.bind(this.input); for (const source of this.offsets) source.start(); this.lfo.start(); this.apply(this.#state.params);
    installNodeShim(this.input, this.output, this, createParamMgrShim(() => this.#state.params, (state) => this.setState(state)));
  }
  static limiterCurve() { const curve = new Float32Array(2048); for (let i = 0; i < curve.length; i++) { const x = i * 2 / (curve.length - 1) - 1; curve[i] = .55 * Math.tanh(3 * x); } return curve; }
  apply(p: Params) { const now = this.output.context.currentTime, maxHz = Math.min(20000, .45 * this.output.context.sampleRate), span = 800 * p.depth, selected = Math.round(p.stages) - 4; this.lfo.frequency.setTargetAtTime(p.rate, now, .02); this.modulation.gain.setTargetAtTime(span, now, .02); this.feedbackGain.gain.setTargetAtTime(p.feedback, now, .02); this.dry.gain.setTargetAtTime(Math.cos(p.mix * Math.PI / 2), now, .02); this.wet.gain.setTargetAtTime(Math.sin(p.mix * Math.PI / 2), now, .02); for (let i = 0; i < 8; i++) { const center = clamp(200 * 1.34 ** i, 20, maxHz); this.offsets[i].offset.setTargetAtTime(center, now, .02); const target = i === selected ? 1 : 0; this.taps[i].gain.setTargetAtTime(target, now, .015); } }
  async getState(): Promise<State> { return structuredClone(this.#state); }
  async setState(v: unknown) {
    this.#state = setStateFromRecord(v, "phaser", this.#state.params, SPECS);
    this.apply(this.#state.params);
  }
  destroy() { if (this.#destroyed) return; this.#destroyed = true; this.lfo.stop(); for (const source of this.offsets) source.stop(); this.#disconnectInput(); for (const n of [this.lfo, this.modulation, this.wetBus, this.feedbackGain, this.limiter, this.cycleBreak, this.dry, this.wet, this.output, ...this.stages, ...this.taps, ...this.offsets]) n.disconnect(); }
}
class Module { async createInstance(_group: string, context: AudioContext) { const node = new PhaserNode(context); return { audioNode: node.input, createGui: () => createKnobPanel("Orbitronica Phaser", node, [
  { kind: "knob", key: "rate", label: "Rate", min: 0.05, max: 10, scale: "log", format: fmt.hz },
  { kind: "knob", key: "depth", label: "Depth", min: 0, max: 1, format: fmt.pct },
  { kind: "knob", key: "stages", label: "Stages", min: 4, max: 8, step: 1, format: fmt.int },
  { kind: "knob", key: "feedback", label: "Feedback", min: -0.95, max: 0.95, format: fmt.pct },
  { kind: "knob", key: "mix", label: "Mix", min: 0, max: 1, format: fmt.pct },
]), destroyGui: (gui: HTMLElement) => gui.remove() }; } }
export default new Module();
