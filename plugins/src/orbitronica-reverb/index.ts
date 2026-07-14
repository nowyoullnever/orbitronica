/*
 * Orbitronica's clean-room Schroeder/Moorer-style reverb.  The topology and
 * public-domain attribution are documented in clean-room-evidence.md.  The
 * delay-frame choices below are newly selected Orbitronica constants, not
 * recovered from any implementation or derivative port.
 */

import { createKnobPanel, fmt } from "../shared/knobPanel";
import { clamp, createParamMgrShim, hasDangerousKey as dangerous, installNodeShim, isStateRecord as stateRecord } from "../shared/effectNode";

type Params = { roomSize: number; damping: number; width: number; mix: number };
type State = { schemaVersion: 1; params: Params };

const defaults: Params = { roomSize: .5, damping: .35, width: 1, mix: 0 };
const COMB_REFERENCE_FRAMES = {
  left: [1371, 1672, 1927, 2306, 2721, 3171, 3674, 4281],
  right: [1473, 1755, 2033, 2456, 2881, 3378, 3934, 4582],
};
const ALLPASS_REFERENCE_FRAMES = { left: [181, 322, 525, 781], right: [207, 379, 578, 851] };
const scaledDelay = (referenceFrames: number, sampleRate: number) => {
  // Scale the 44.1 kHz tuning in frames, then clamp to a valid native delay.
  const scaledFrames = referenceFrames * sampleRate / 44_100;
  return clamp(scaledFrames / sampleRate, 1 / sampleRate, .2);
};

type Comb = { delay: DelayNode; damper: BiquadFilterNode; feedback: GainNode; output: GainNode };
type Allpass = { input: GainNode; delay: DelayNode; feedback: GainNode; direct: GainNode; output: GainNode };

class ReverbNode {
  readonly input: GainNode; readonly output: GainNode; readonly splitter: ChannelSplitterNode; readonly merger: ChannelMergerNode;
  readonly dry: GainNode; readonly wet: GainNode; readonly wetLeft: GainNode; readonly wetRight: GainNode;
  readonly combs: Comb[] = []; readonly allpasses: Allpass[] = []; readonly widthGains: GainNode[] = [];
  #state: State = { schemaVersion: 1, params: { ...defaults } }; #destroyed = false; #disconnectInput: () => void;

  constructor(context: AudioContext) {
    this.input = context.createGain(); this.output = context.createGain(); this.splitter = context.createChannelSplitter(2); this.merger = context.createChannelMerger(2);
    this.dry = context.createGain(); this.wet = context.createGain(); this.wetLeft = context.createGain(); this.wetRight = context.createGain();
    this.input.connect(this.dry); this.dry.connect(this.output); this.input.connect(this.splitter);
    this.merger.connect(this.wet); this.wet.connect(this.output);
    this.wetLeft.connect(this.merger, 0, 0); this.wetRight.connect(this.merger, 0, 1);
    for (const side of ["left", "right"] as const) {
      const combSum = context.createGain();
      for (const frames of COMB_REFERENCE_FRAMES[side]) {
        const comb = this.createComb(context, scaledDelay(frames, context.sampleRate));
        this.combs.push(comb); this.splitter.connect(comb.delay, side === "left" ? 0 : 1, 0); comb.output.connect(combSum);
      }
      let stageOutput: AudioNode = combSum;
      for (const frames of ALLPASS_REFERENCE_FRAMES[side]) {
        const stage = this.createAllpass(context, scaledDelay(frames, context.sampleRate));
        this.allpasses.push(stage); stageOutput.connect(stage.input); stageOutput = stage.output;
      }
      const own = context.createGain(), cross = context.createGain();
      this.widthGains.push(own, cross); stageOutput.connect(own); stageOutput.connect(cross);
      if (side === "left") { own.connect(this.wetLeft); cross.connect(this.wetRight); }
      else { own.connect(this.wetRight); cross.connect(this.wetLeft); }
    }
    this.#disconnectInput = this.input.disconnect.bind(this.input); this.apply(this.#state.params);
    installNodeShim(this.input, this.output, this, createParamMgrShim(() => this.#state.params, (state) => this.setState(state)));
  }

  createComb(context: AudioContext, delayTime: number): Comb {
    const delay = context.createDelay(.2), damper = context.createBiquadFilter(), feedback = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime; damper.type = "lowpass"; damper.Q.value = .707;
    delay.connect(damper); damper.connect(output); damper.connect(feedback); feedback.connect(delay);
    return { delay, damper, feedback, output };
  }

  createAllpass(context: AudioContext, delayTime: number): Allpass {
    const input = context.createGain(), delay = context.createDelay(.2), feedback = context.createGain(), direct = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime; feedback.gain.value = .5; direct.gain.value = -.5;
    input.connect(delay); input.connect(direct); direct.connect(output); delay.connect(output); delay.connect(feedback); feedback.connect(input);
    return { input, delay, feedback, direct, output };
  }

  apply(params: Params) {
    const now = this.output.context.currentTime;
    const feedback = .3 + params.roomSize * .6;
    // Exponential cutoff mapping gives the damping control a reliable,
    // perceptually meaningful high-frequency-tail reduction across rates.
    const dampingHz = clamp(20_000 * .015 ** params.damping, 300, 20_000);
    const own = .5 + .5 * params.width, cross = .5 - .5 * params.width;
    for (const comb of this.combs) { comb.feedback.gain.setTargetAtTime(feedback, now, .03); comb.damper.frequency.setTargetAtTime(dampingHz, now, .03); }
    for (let index = 0; index < this.widthGains.length; index += 2) { this.widthGains[index].gain.setTargetAtTime(own, now, .03); this.widthGains[index + 1].gain.setTargetAtTime(cross, now, .03); }
    this.dry.gain.setTargetAtTime(Math.cos(params.mix * Math.PI / 2), now, .03); this.wet.gain.setTargetAtTime(Math.sin(params.mix * Math.PI / 2), now, .03);
  }

  async getState(): Promise<State> { return structuredClone(this.#state); }
  async setState(value: unknown) {
    if (!stateRecord(value) || dangerous(value)) throw new Error("invalid-reverb-state");
    const source = value as { schemaVersion?: unknown; params?: unknown };
    if (source.schemaVersion !== undefined && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-reverb-state");
    const incoming = source.params === undefined ? source : source.params;
    if (!stateRecord(incoming) || dangerous(incoming)) throw new Error("invalid-reverb-state");
    const old = this.#state.params;
    const raw = { roomSize: incoming.roomSize ?? old.roomSize, damping: incoming.damping ?? old.damping, width: incoming.width ?? old.width, mix: incoming.mix ?? old.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-reverb-state");
    this.#state = { schemaVersion: 1, params: { roomSize: clamp(raw.roomSize as number, 0, 1), damping: clamp(raw.damping as number, 0, 1), width: clamp(raw.width as number, 0, 1), mix: clamp(raw.mix as number, 0, 1) } }; this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return; this.#destroyed = true; this.#disconnectInput();
    for (const comb of this.combs) for (const node of [comb.delay, comb.damper, comb.feedback, comb.output]) node.disconnect();
    for (const stage of this.allpasses) for (const node of [stage.input, stage.delay, stage.feedback, stage.direct, stage.output]) node.disconnect();
    for (const node of [this.splitter, this.merger, this.dry, this.wet, this.wetLeft, this.wetRight, ...this.widthGains, this.output]) node.disconnect();
  }
}

class Module {
  async createInstance(_group: string, context: AudioContext) {
    const node = new ReverbNode(context);
    return { audioNode: node.input, createGui: () => createKnobPanel("Orbitronica Reverb", node, [
      { kind: "knob", key: "roomSize", label: "Room", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "damping", label: "Damping", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "width", label: "Width", min: 0, max: 1, format: fmt.pct },
      { kind: "knob", key: "mix", label: "Mix", min: 0, max: 1, format: fmt.pct },
    ]), destroyGui: (gui: HTMLElement) => gui.remove() };
  }
}
export default new Module();
