// plugins/src/orbitronica-reverb/index.ts
var stateRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
var defaults = { roomSize: 0.5, damping: 0.35, width: 1, mix: 0 };
var COMB_REFERENCE_FRAMES = {
  left: [1371, 1672, 1927, 2306, 2721, 3171, 3674, 4281],
  right: [1473, 1755, 2033, 2456, 2881, 3378, 3934, 4582]
};
var ALLPASS_REFERENCE_FRAMES = { left: [181, 322, 525, 781], right: [207, 379, 578, 851] };
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
var scaledDelay = (referenceFrames, sampleRate) => {
  const scaledFrames = referenceFrames * sampleRate / 44100;
  return clamp(scaledFrames / sampleRate, 1 / sampleRate, 0.2);
};
var dangerous = (value) => !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => ["__proto__", "constructor", "prototype"].includes(key) || dangerous(child));
var ReverbNode = class {
  input;
  output;
  splitter;
  merger;
  dry;
  wet;
  wetLeft;
  wetRight;
  combs = [];
  allpasses = [];
  widthGains = [];
  #state = { schemaVersion: 1, params: { ...defaults } };
  #destroyed = false;
  #disconnectInput;
  constructor(context) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.splitter = context.createChannelSplitter(2);
    this.merger = context.createChannelMerger(2);
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.wetLeft = context.createGain();
    this.wetRight = context.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.splitter);
    this.merger.connect(this.wet);
    this.wet.connect(this.output);
    this.wetLeft.connect(this.merger, 0, 0);
    this.wetRight.connect(this.merger, 0, 1);
    for (const side of ["left", "right"]) {
      const combSum = context.createGain();
      for (const frames of COMB_REFERENCE_FRAMES[side]) {
        const comb = this.createComb(context, scaledDelay(frames, context.sampleRate));
        this.combs.push(comb);
        this.splitter.connect(comb.delay, side === "left" ? 0 : 1, 0);
        comb.output.connect(combSum);
      }
      let stageOutput = combSum;
      for (const frames of ALLPASS_REFERENCE_FRAMES[side]) {
        const stage = this.createAllpass(context, scaledDelay(frames, context.sampleRate));
        this.allpasses.push(stage);
        stageOutput.connect(stage.input);
        stageOutput = stage.output;
      }
      const own = context.createGain(), cross = context.createGain();
      this.widthGains.push(own, cross);
      stageOutput.connect(own);
      stageOutput.connect(cross);
      if (side === "left") {
        own.connect(this.wetLeft);
        cross.connect(this.wetRight);
      } else {
        own.connect(this.wetRight);
        cross.connect(this.wetLeft);
      }
    }
    this.#disconnectInput = this.input.disconnect.bind(this.input);
    this.apply(this.#state.params);
    Object.defineProperties(this.input, {
      connect: { value: this.output.connect.bind(this.output) },
      disconnect: { value: this.output.disconnect.bind(this.output) },
      destroy: { value: () => this.destroy() },
      getState: { value: () => this.getState() },
      setState: { value: (value) => this.setState(value) },
      paramMgr: { value: { getState: async () => structuredClone(this.#state.params), getParamsValues: () => structuredClone(this.#state.params), setState: async (params) => this.setState({ schemaVersion: 1, params }) } }
    });
  }
  createComb(context, delayTime) {
    const delay = context.createDelay(0.2), damper = context.createBiquadFilter(), feedback = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime;
    damper.type = "lowpass";
    damper.Q.value = 0.707;
    delay.connect(damper);
    damper.connect(output);
    damper.connect(feedback);
    feedback.connect(delay);
    return { delay, damper, feedback, output };
  }
  createAllpass(context, delayTime) {
    const input = context.createGain(), delay = context.createDelay(0.2), feedback = context.createGain(), direct = context.createGain(), output = context.createGain();
    delay.delayTime.value = delayTime;
    feedback.gain.value = 0.5;
    direct.gain.value = -0.5;
    input.connect(delay);
    input.connect(direct);
    direct.connect(output);
    delay.connect(output);
    delay.connect(feedback);
    feedback.connect(input);
    return { input, delay, feedback, direct, output };
  }
  apply(params) {
    const now = this.output.context.currentTime;
    const feedback = 0.3 + params.roomSize * 0.6;
    const dampingHz = clamp(2e4 * 0.015 ** params.damping, 300, 2e4);
    const own = 0.5 + 0.5 * params.width, cross = 0.5 - 0.5 * params.width;
    for (const comb of this.combs) {
      comb.feedback.gain.setTargetAtTime(feedback, now, 0.03);
      comb.damper.frequency.setTargetAtTime(dampingHz, now, 0.03);
    }
    for (let index = 0; index < this.widthGains.length; index += 2) {
      this.widthGains[index].gain.setTargetAtTime(own, now, 0.03);
      this.widthGains[index + 1].gain.setTargetAtTime(cross, now, 0.03);
    }
    this.dry.gain.setTargetAtTime(Math.cos(params.mix * Math.PI / 2), now, 0.03);
    this.wet.gain.setTargetAtTime(Math.sin(params.mix * Math.PI / 2), now, 0.03);
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!stateRecord(value) || dangerous(value)) throw new Error("invalid-reverb-state");
    const source = value;
    if (source.schemaVersion !== void 0 && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-reverb-state");
    const incoming = source.params === void 0 ? source : source.params;
    if (!stateRecord(incoming) || dangerous(incoming)) throw new Error("invalid-reverb-state");
    const old = this.#state.params;
    const raw = { roomSize: incoming.roomSize ?? old.roomSize, damping: incoming.damping ?? old.damping, width: incoming.width ?? old.width, mix: incoming.mix ?? old.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-reverb-state");
    this.#state = { schemaVersion: 1, params: { roomSize: clamp(raw.roomSize, 0, 1), damping: clamp(raw.damping, 0, 1), width: clamp(raw.width, 0, 1), mix: clamp(raw.mix, 0, 1) } };
    this.apply(this.#state.params);
  }
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#disconnectInput();
    for (const comb of this.combs) for (const node of [comb.delay, comb.damper, comb.feedback, comb.output]) node.disconnect();
    for (const stage of this.allpasses) for (const node of [stage.input, stage.delay, stage.feedback, stage.direct, stage.output]) node.disconnect();
    for (const node of [this.splitter, this.merger, this.dry, this.wet, this.wetLeft, this.wetRight, ...this.widthGains, this.output]) node.disconnect();
  }
};
var Module = class {
  async createInstance(_group, context) {
    const node = new ReverbNode(context);
    return { audioNode: node.input, createGui: () => {
      const root = document.createElement("div");
      root.textContent = "Orbitronica Reverb";
      return root;
    }, destroyGui: (gui) => gui.remove() };
  }
};
var index_default = new Module();
export {
  index_default as default
};
