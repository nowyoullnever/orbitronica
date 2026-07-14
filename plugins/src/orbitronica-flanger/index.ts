import { createKnobPanel, fmt } from "../shared/knobPanel";
import { createParamMgrShim, installNodeShim, setStateFromRecord, type ParamSpec } from "../shared/effectNode";

type Params = { rate: number; depth: number; feedback: number; mix: number };
type State = { schemaVersion: 1; params: Params };
const defaults: Params = { rate: .25, depth: .003, feedback: .25, mix: 0 };
const SPECS: readonly ParamSpec<keyof Params & string>[] = [
  { key: "rate", min: .05, max: 10 },
  { key: "depth", min: 0, max: .009 },
  { key: "feedback", min: -.95, max: .95 },
  { key: "mix", min: 0, max: 1 },
];
class FlangerNode {
  readonly input: GainNode; readonly output: GainNode; readonly delay: DelayNode; readonly lfo: OscillatorNode; readonly depth: GainNode; readonly offset: ConstantSourceNode; readonly feedbackNode: GainNode; readonly wet: GainNode; readonly dry: GainNode;
  #state: State = { schemaVersion: 1, params: { ...defaults } }; #destroyed = false; #disconnectInput: () => void;
  constructor(context: AudioContext) {
    this.input = context.createGain(); this.output = context.createGain(); this.delay = context.createDelay(.02); this.lfo = context.createOscillator(); this.depth = context.createGain(); this.offset = context.createConstantSource(); this.feedbackNode = context.createGain(); this.wet = context.createGain(); this.dry = context.createGain();
    this.lfo.type = "sine"; this.offset.connect(this.delay.delayTime); this.lfo.connect(this.depth); this.depth.connect(this.delay.delayTime);
    this.input.connect(this.dry); this.dry.connect(this.output); this.input.connect(this.delay); this.delay.connect(this.wet); this.wet.connect(this.output); this.delay.connect(this.feedbackNode); this.feedbackNode.connect(this.delay);
    this.#disconnectInput = this.input.disconnect.bind(this.input); this.offset.start(); this.lfo.start(); this.apply(this.#state.params);
    installNodeShim(this.input, this.output, this, createParamMgrShim(() => this.#state.params, (state) => this.setState(state)));
  }
  apply(p: Params) { const now = this.delay.context.currentTime; this.lfo.frequency.setTargetAtTime(p.rate, now, .02); this.offset.offset.setTargetAtTime(.01, now, .02); this.depth.gain.setTargetAtTime(p.depth, now, .02); this.feedbackNode.gain.setTargetAtTime(p.feedback, now, .02); this.dry.gain.setTargetAtTime(Math.cos(p.mix * Math.PI / 2), now, .02); this.wet.gain.setTargetAtTime(Math.sin(p.mix * Math.PI / 2), now, .02); }
  async getState(): Promise<State> { return structuredClone(this.#state); }
  async setState(v: unknown) {
    this.#state = setStateFromRecord(v, "flanger", this.#state.params, SPECS);
    this.apply(this.#state.params);
  }
  destroy() { if (this.#destroyed) return; this.#destroyed = true; this.lfo.stop(); this.offset.stop(); this.#disconnectInput(); for (const n of [this.delay, this.lfo, this.depth, this.offset, this.feedbackNode, this.wet, this.dry, this.output]) n.disconnect(); }
}
class Module { async createInstance(_group: string, context: AudioContext) { const node = new FlangerNode(context); return { audioNode: node.input, createGui: () => createKnobPanel("Orbitronica Flanger", node, [
  { kind: "knob", key: "rate", label: "Rate", min: 0.05, max: 10, scale: "log", format: fmt.hz },
  { kind: "knob", key: "depth", label: "Depth", min: 0, max: 0.009, format: fmt.ms },
  { kind: "knob", key: "feedback", label: "Feedback", min: -0.95, max: 0.95, format: fmt.pct },
  { kind: "knob", key: "mix", label: "Mix", min: 0, max: 1, format: fmt.pct },
]), destroyGui: (gui: HTMLElement) => gui.remove() }; } }
export default new Module();
