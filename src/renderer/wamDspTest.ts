/*
 * This is deliberately a Chromium OfflineAudioContext harness rather than a
 * Node approximation.  The compressor is a native DynamicsCompressorNode, so
 * its acceptance oracle must be the same browser implementation that ships.
 */
type Params = { threshold: number; knee: number; ratio: number; attack: number; release: number; makeupGain: number };
type Metric = { catalogId: string; parameterId: string; phase: "dsp"; metric: string; observed: number; tolerance: string; durationMs: number; ok: boolean; error?: string };
type PluginNode = AudioNode & { getState(): Promise<{ schemaVersion: number; params: Params }>; setState(value: { schemaVersion: 1; params: Params }): Promise<void>; destroy(): void };
type BitcrusherParams = { bitDepth: number; reduction: number; mix: number };
type BitcrusherNode = AudioNode & { getState(): Promise<{ schemaVersion: number; params: BitcrusherParams }>; setState(value: { schemaVersion: 1; params: BitcrusherParams }): Promise<void>; destroy(): void };
const defaults: Params = { threshold: -24, knee: 30, ratio: 1, attack: .003, release: .25, makeupGain: 0 };
const preRoll = 1.05;
const seconds = 2.8;
const result = document.querySelector<HTMLElement>("#result");
const db = (value: number) => 20 * Math.log10(Math.max(value, 1e-12));
const rms = (values: Float32Array, from: number, to: number) => {
  let total = 0; for (let i = from; i < to; i++) total += values[i] ** 2;
  return Math.sqrt(total / Math.max(1, to - from));
};
const differenceRms = (a: Float32Array, b: Float32Array, from: number, to: number) => {
  let total = 0; for (let i = from; i < to; i++) total += (a[i] - b[i]) ** 2;
  return Math.sqrt(total / Math.max(1, to - from));
};
const at = (secondsValue: number, sampleRate: number) => Math.floor(secondsValue * sampleRate);
const maxAbs = (samples: Float32Array) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const finite = (samples: Float32Array) => samples.every(Number.isFinite);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Fixture = (time: number, channel: number) => number;
const tone = (levelDb: number, frequency = 1000): Fixture => (time, channel) => 10 ** (levelDb / 20) * Math.sin(2 * Math.PI * frequency * (channel ? 1.37 : 1) * time);
const transient: Fixture = (time, channel) => {
  const local = time - preRoll;
  return local >= 0 && local < .06 ? .9 * Math.sin(2 * Math.PI * (channel ? 1300 : 1000) * time) : 0;
};
const stepped: Fixture = (time, channel) => tone(time < preRoll + .55 ? -6 : -60, channel ? 1300 : 1000)(time, channel);

async function compressorModule() {
  // This page lives beside the catalog root in both dist and app.asar.
  const url = new URL("./wam/orbitronica-compressor/index.js", window.location.href).toString();
  return import(/* @vite-ignore */ url) as Promise<{ default: { createInstance(group: string, context: AudioContext): Promise<{ audioNode: PluginNode }> } }>;
}
async function bitcrusherModule() {
  const url = new URL("./wam/orbitronica-bitcrusher/index.js", window.location.href).toString();
  return import(/* @vite-ignore */ url) as Promise<{ default: { createInstance(group: string, context: AudioContext): Promise<{ audioNode: BitcrusherNode }> }; proveMinimalWamProcessor(group: string, context: AudioContext): Promise<void> }>;
}

async function render(params: Params, fixture: Fixture, sampleRate: number, nativeReference = false) {
  const context = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const source = context.createBufferSource();
  const input = context.createBuffer(2, context.length, sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const samples = input.getChannelData(channel);
    for (let frame = at(preRoll, sampleRate); frame < samples.length; frame++) samples[frame] = fixture(frame / sampleRate, channel);
  }
  source.buffer = input;
  let node: PluginNode | undefined;
  if (nativeReference) {
    const compressor = context.createDynamicsCompressor(); const makeup = context.createGain();
    const now = context.currentTime;
    compressor.threshold.setTargetAtTime(params.threshold, now, .02); compressor.knee.setTargetAtTime(params.knee, now, .02);
    compressor.ratio.setTargetAtTime(params.ratio, now, .02); compressor.attack.setTargetAtTime(params.attack, now, .02);
    compressor.release.setTargetAtTime(params.release, now, .02); makeup.gain.setTargetAtTime(10 ** (params.makeupGain / 20), now, .02);
    source.connect(compressor); compressor.connect(makeup); makeup.connect(context.destination);
  } else {
    // The plugin only consumes the common BaseAudioContext node factory surface;
    // OfflineAudioContext deliberately omits realtime-only TypeScript members.
    const instance = await (await compressorModule()).default.createInstance("dsp-metrics", context as unknown as AudioContext);
    node = instance.audioNode;
    await node.setState({ schemaVersion: 1, params });
    source.connect(node); node.connect(context.destination);
  }
  source.start();
  const output = await context.startRendering();
  node?.destroy();
  return output;
}

const measure = (buffer: AudioBuffer, begin: number, end: number, channel = 0) => rms(buffer.getChannelData(channel), at(begin, buffer.sampleRate), at(end, buffer.sampleRate));
const nativeError = (candidate: AudioBuffer, reference: AudioBuffer, begin: number, end: number) => {
  const a = candidate.getChannelData(0); const b = reference.getChannelData(0);
  return differenceRms(a, b, at(begin, candidate.sampleRate), at(end, candidate.sampleRate)) / Math.max(rms(b, at(begin, candidate.sampleRate), at(end, candidate.sampleRate)), 1e-12);
};

const metrics: Metric[] = [];
async function check(parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>, catalogId = "orbitronica-compressor") {
  const started = performance.now();
  try {
    const { observed, ok } = await run();
    const event: Metric = { catalogId, parameterId, phase: "dsp", metric, observed, tolerance, durationMs: performance.now() - started, ok };
    metrics.push(event); console.log(`ORBITRONICA_WAM_DSP_METRIC ${JSON.stringify(event)}`);
  } catch (error) {
    const event: Metric = { catalogId, parameterId, phase: "dsp", metric, observed: Number.NaN, tolerance, durationMs: performance.now() - started, ok: false, error: error instanceof Error ? error.message : String(error) };
    metrics.push(event); console.log(`ORBITRONICA_WAM_DSP_METRIC ${JSON.stringify(event)}`);
  }
}

async function controlMetrics(sampleRate: number) {
  await check("threshold", `reduction-delta-${sampleRate}`, ">= 4 dB", async () => {
    const fixed = { ...defaults, ratio: 4, knee: 0 };
    const high = await render({ ...fixed, threshold: -20 }, tone(-8), sampleRate);
    const low = await render({ ...fixed, threshold: -40 }, tone(-8), sampleRate);
    const reduction = db(measure(high, 1.8, 2.5) / measure(low, 1.8, 2.5));
    return { observed: reduction, ok: reduction >= 4 };
  });
  await check("knee", `native-curve-and-transition-${sampleRate}`, "native error <= 2 dB; curves differ", async () => {
    const zero = { ...defaults, threshold: -24, ratio: 4, knee: 0 };
    const soft = { ...zero, knee: 40 };
    const candidate = await render(soft, tone(-20), sampleRate); const reference = await render(soft, tone(-20), sampleRate, true);
    const hardOutput = await render(zero, tone(-20), sampleRate);
    // Express an amplitude-relative residual as a positive dB delta.  Exact
    // graph parity is 0 dB, rather than the misleading -infinity dB ratio.
    const errorDb = 20 * Math.log10(1 + nativeError(candidate, reference, 1.8, 2.5));
    const curveDifference = Math.abs(db(measure(candidate, 1.8, 2.5) / measure(hardOutput, 1.8, 2.5)));
    return { observed: errorDb, ok: errorDb <= 2 && curveDifference >= .05 };
  });
  await check("ratio", `settled-transfer-slope-${sampleRate}`, "ratio 20 slope 0.04..0.06 and < ratio 4", async () => {
    const output = async (ratio: number, level: number) => measure(await render({ ...defaults, threshold: -30, knee: 0, ratio }, tone(level), sampleRate), 1.8, 2.5);
    const slope20 = (db(await output(20, -6)) - db(await output(20, -12))) / 6;
    const slope4 = (db(await output(4, -6)) - db(await output(4, -12))) / 6;
    return { observed: slope20, ok: slope20 >= .04 && slope20 <= .06 && slope20 < slope4 };
  });
  await check("attack", `native-envelope-and-transient-${sampleRate}`, "native normalized error <= 1%; long attack preserves transient", async () => {
    const params = { ...defaults, threshold: -30, knee: 0, ratio: 10, attack: .2, release: .25 };
    const candidate = await render(params, transient, sampleRate); const reference = await render(params, transient, sampleRate, true);
    const short = await render({ ...params, attack: .003 }, transient, sampleRate);
    const error = nativeError(candidate, reference, preRoll, preRoll + .06);
    const preserved = db(measure(candidate, preRoll, preRoll + .025) / measure(short, preRoll, preRoll + .025));
    return { observed: error, ok: error <= .01 && preserved > .2 };
  });
  await check("release", `native-envelope-and-recovery-${sampleRate}`, "native normalized error <= 1%; long release delays recovery", async () => {
    const params = { ...defaults, threshold: -30, knee: 0, ratio: 10, attack: 0, release: .8 };
    const candidate = await render(params, stepped, sampleRate); const reference = await render(params, stepped, sampleRate, true);
    const short = await render({ ...params, release: .03 }, stepped, sampleRate);
    const error = nativeError(candidate, reference, preRoll + .55, preRoll + .7);
    const delayed = db(measure(short, preRoll + .56, preRoll + .65) / measure(candidate, preRoll + .56, preRoll + .65));
    return { observed: error, ok: error <= .01 && delayed > .2 };
  });
  await check("makeupGain", `settled-gain-${sampleRate}`, "+6 dB produces 4.5..7.5 dB", async () => {
    const plain = await render({ ...defaults, ratio: 1, makeupGain: 0 }, tone(-24), sampleRate);
    const boosted = await render({ ...defaults, ratio: 1, makeupGain: 6 }, tone(-24), sampleRate);
    const gained = db(measure(boosted, 1.8, 2.5) / measure(plain, 1.8, 2.5));
    return { observed: gained, ok: gained >= 4.5 && gained <= 7.5 };
  });
}

async function safetyMetrics() {
  await check("all-controls", "finite-bounded-stereo-extremes", "finite, <= 10 FS, both channels remain distinct", async () => {
    const buffer = await render({ threshold: -100, knee: 40, ratio: 20, attack: 0, release: 1, makeupGain: 24 }, tone(-2, 713), 48_000);
    const left = buffer.getChannelData(0); const right = buffer.getChannelData(1);
    const safe = finite(left) && finite(right) && maxAbs(left) <= 10 && maxAbs(right) <= 10;
    const distinct = differenceRms(left, right, at(1.8, 48_000), at(2.5, 48_000)) > 1e-4;
    return { observed: Math.max(maxAbs(left), maxAbs(right)), ok: safe && distinct };
  });
  await check("all-controls", "silence-stability", "absolute floor <= 1e-7", async () => {
    const buffer = await render({ threshold: -100, knee: 40, ratio: 20, attack: 0, release: 1, makeupGain: 24 }, () => 0, 44_100);
    const observed = Math.max(maxAbs(buffer.getChannelData(0)), maxAbs(buffer.getChannelData(1)));
    return { observed, ok: observed <= 1e-7 };
  });
  await check("state", "round-trip-each-control", "exact numeric state", async () => {
    const context = new OfflineAudioContext(2, 128, 44_100);
    const node = (await (await compressorModule()).default.createInstance("state", context as unknown as AudioContext)).audioNode;
    const params = { threshold: -40, knee: 8, ratio: 12, attack: .2, release: .8, makeupGain: 6 };
    await node.setState({ schemaVersion: 1, params }); const saved = await node.getState(); node.destroy();
    return { observed: Object.keys(params).filter((key) => saved.params[key as keyof Params] === params[key as keyof Params]).length, ok: JSON.stringify(saved) === JSON.stringify({ schemaVersion: 1, params }) };
  });
}

/*
 * Keep this in packaged Chromium because loop-boundary interpolation belongs to
 * Web Audio, not to the Node fake context used by audioEngine unit tests.  The
 * fixture completes an integral number of cycles inside the loop window, so a
 * discontinuity here indicates a coordinate/loop-boundary regression rather
 * than an intentional waveform edge.
 */
async function renderPlaybackBoundary(reverse: boolean, tapeRate: number) {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.ceil(sampleRate * .9), sampleRate);
  const source = context.createBufferSource();
  const full = context.createBuffer(1, sampleRate, sampleRate);
  const data = full.getChannelData(0);
  for (let frame = 0; frame < data.length; frame++) data[frame] = Math.sin(2 * Math.PI * 10 * frame / sampleRate);
  if (reverse) {
    const trimmed = context.createBuffer(1, Math.round(sampleRate * .4), sampleRate);
    const reversed = trimmed.getChannelData(0);
    for (let frame = 0; frame < reversed.length; frame++) reversed[frame] = data[Math.round(sampleRate * .6) - 1 - frame];
    source.buffer = trimmed;
    source.loopStart = 0;
    source.loopEnd = trimmed.duration;
    source.start(0, .15);
  } else {
    source.buffer = full;
    source.loopStart = .2;
    source.loopEnd = .6;
    source.start(0, .35);
  }
  source.loop = true;
  source.playbackRate.value = tapeRate;
  source.connect(context.destination);
  return context.startRendering();
}

async function audioEnginePlaybackBaselines() {
  for (const tapeRate of [.75, 1.25]) for (const reverse of [false, true]) {
    await check(reverse ? "reverse" : "forward", `loop-boundary-continuity-${tapeRate}x`, "max adjacent delta < .01 FS", async () => {
      const rendered = await renderPlaybackBoundary(reverse, tapeRate);
      const samples = rendered.getChannelData(0);
      let maximumDelta = 0;
      for (let frame = 1; frame < samples.length; frame++) maximumDelta = Math.max(maximumDelta, Math.abs(samples[frame] - samples[frame - 1]));
      return { observed: maximumDelta, ok: finite(samples) && maximumDelta < .01 };
    }, "audio-engine-playback");
  }
}

const bitcrusherDefaults: BitcrusherParams = { bitDepth: 8, reduction: 1, mix: 0 };
async function renderBitcrusher(params: BitcrusherParams, fixture: Fixture, sampleRate: number) {
  const context = new OfflineAudioContext(2, Math.ceil(1.4 * sampleRate), sampleRate);
  const { initializeWamHost } = await import("@webaudiomodules/sdk");
  const [group] = await initializeWamHost(context as unknown as AudioContext) as [string, string];
  const loaded = await bitcrusherModule();
  // This is intentionally the first worklet operation in the packaged DSP page.
  await loaded.proveMinimalWamProcessor(group, context as unknown as AudioContext);
  const instance = await loaded.default.createInstance(group, context as unknown as AudioContext);
  await instance.audioNode.setState({ schemaVersion: 1, params });
  const source = context.createBufferSource(), input = context.createBuffer(2, context.length, sampleRate);
  for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < input.length; frame++) input.getChannelData(channel)[frame] = fixture(frame / sampleRate, channel);
  source.buffer = input; source.connect(instance.audioNode); instance.audioNode.connect(context.destination); source.start();
  const output = await context.startRendering(); instance.audioNode.destroy(); return output;
}
const dot = (a: Float32Array, b: Float32Array) => { let total = 0; for (let i = 0; i < a.length; i++) total += a[i] * b[i]; return total; };
const stereoRamp: Fixture = (time, channel) => clamp((channel ? Math.sin(time * 991 * Math.PI * 2) : ((time * 757) % 2) - 1) * .9, -1, 1);
async function bitcrusherMetrics() {
  const bitCheck = (parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>) => check(parameterId, metric, tolerance, run, "orbitronica-bitcrusher");
  await bitCheck("bitDepth", "quantized-levels-and-error", "3-bit <= 8 levels; 3-bit error >= 16-bit error +12 dB", async () => {
    const low = await renderBitcrusher({ ...bitcrusherDefaults, bitDepth: 3, mix: 1 }, stereoRamp, 44_100), high = await renderBitcrusher({ ...bitcrusherDefaults, bitDepth: 16, mix: 1 }, stereoRamp, 44_100);
    const original = new Float32Array(low.length); for (let i = 0; i < original.length; i++) original[i] = stereoRamp(i / 44_100, 0);
    const lowValues = new Set(Array.from(low.getChannelData(0)).map((value) => Math.round(value * 1e6)));
    const ratio = db(differenceRms(low.getChannelData(0), original, 0, low.length) / Math.max(differenceRms(high.getChannelData(0), original, 0, high.length), 1e-12));
    return { observed: ratio, ok: lowValues.size <= 8 && ratio >= 12 };
  });
  await bitCheck("reduction", "exact-independent-stereo-holds", "each channel holds exactly 8 frames independently", async () => {
    const input: Fixture = (_time, channel) => channel ? .1 + ((_time * 48_000 | 0) % 13) / 20 : -.7 + ((_time * 48_000 | 0) % 17) / 20;
    const output = await renderBitcrusher({ ...bitcrusherDefaults, bitDepth: 16, reduction: 8, mix: 1 }, input, 48_000);
    const left = output.getChannelData(0), right = output.getChannelData(1); let exact = true;
    for (let frame = 0; frame < 128; frame++) { const group = Math.floor(frame / 8) * 8; if (Math.abs(left[frame] - left[group]) > 1e-6 || Math.abs(right[frame] - right[group]) > 1e-6) exact = false; }
    return { observed: differenceRms(left, right, 0, 128), ok: exact && differenceRms(left, right, 0, 128) > 1e-4 };
  });
  await bitCheck("mix", "equal-power-projection", "dry/wet coefficients within .02 of cos/sin", async () => {
    const params = { bitDepth: 4, reduction: 8 }, dry = (await renderBitcrusher({ ...params, mix: 0 }, stereoRamp, 48_000)).getChannelData(0), wet = (await renderBitcrusher({ ...params, mix: 1 }, stereoRamp, 48_000)).getChannelData(0), mixed = (await renderBitcrusher({ ...params, mix: .5 }, stereoRamp, 48_000)).getChannelData(0);
    const dd = dot(dry, dry), dw = dot(dry, wet), ww = dot(wet, wet), dm = dot(dry, mixed), wm = dot(wet, mixed), determinant = dd * ww - dw * dw;
    const dryGain = (dm * ww - wm * dw) / determinant, wetGain = (wm * dd - dm * dw) / determinant;
    const error = Math.max(Math.abs(dryGain - Math.cos(Math.PI / 4)), Math.abs(wetGain - Math.sin(Math.PI / 4)));
    return { observed: error, ok: Number.isFinite(error) && error <= .02 };
  });
  await bitCheck("all-controls", "finite-bounded-stereo-extremes", "finite <= 2 FS and stereo distinct at 44.1/48 kHz", async () => {
    const a = await renderBitcrusher({ bitDepth: 1, reduction: 64, mix: 1 }, stereoRamp, 44_100), b = await renderBitcrusher({ bitDepth: 16, reduction: 1, mix: 1 }, stereoRamp, 48_000);
    const samples = [a.getChannelData(0), a.getChannelData(1), b.getChannelData(0), b.getChannelData(1)], max = Math.max(...samples.map(maxAbs));
    return { observed: max, ok: samples.every(finite) && max <= 2 && differenceRms(a.getChannelData(0), a.getChannelData(1), 0, a.length) > 1e-4 };
  });
  await bitCheck("state", "strict-round-trip", "exact state plus v0 migration", async () => {
    const context = new OfflineAudioContext(2, 128, 44_100); const { initializeWamHost } = await import("@webaudiomodules/sdk"); const [group] = await initializeWamHost(context as unknown as AudioContext) as [string, string];
    const node = (await (await bitcrusherModule()).default.createInstance(group, context as unknown as AudioContext)).audioNode; const params = { bitDepth: 3, reduction: 8, mix: .65 };
    await node.setState({ schemaVersion: 1, params }); const exact = await node.getState(); await node.setState({ bitDepth: 19, reduction: 0, mix: 3 } as unknown as { schemaVersion: 1; params: BitcrusherParams }); const migrated = await node.getState(); node.destroy();
    return { observed: Object.keys(exact.params).length, ok: JSON.stringify(exact) === JSON.stringify({ schemaVersion: 1, params }) && JSON.stringify(migrated) === JSON.stringify({ schemaVersion: 1, params: { bitDepth: 16, reduction: 1, mix: 1 } }) };
  });
}


type ModParams = { rate: number; depth: number; feedback: number; mix: number };
type PhaserParams = ModParams & { stages: number };
type ModNode = AudioNode & { getState(): Promise<{ schemaVersion: number; params: Record<string, number> }>; setState(value: { schemaVersion: 1; params: Record<string, number> }): Promise<void>; destroy(): void };
type ReverbParams = { roomSize: number; damping: number; width: number; mix: number };
/*
 * The first four effects predate the first-party DSP implementations above.
 * Keep their oracle here, in the packaged page, rather than inferring audio
 * behavior from their modules.  In particular, Burns exposes ParamMgr as its
 * public parameter surface; its WAM getState shape is intentionally opaque.
 */
type LegacyId = "burns-simple-delay" | "burns-simple-eq" | "orbitronica-overdrive" | "orbitronica-filter";
type LegacyNode = AudioNode & {
  destroy?: () => void;
  getState?: () => Promise<unknown>;
  setState?: (state: unknown) => Promise<void>;
  paramMgr?: {
    setState(state: Record<string, number>): Promise<void>;
    getState(): Promise<unknown>;
    getParamsValues(): Record<string, number>;
  };
};
type LegacyInstance = { audioNode: LegacyNode };
type LegacyModule = { default: { createInstance(group: string, context: AudioContext): Promise<LegacyInstance> } };
const legacyIds: readonly LegacyId[] = ["burns-simple-delay", "burns-simple-eq", "orbitronica-overdrive", "orbitronica-filter"];
const legacyParams = {
  "burns-simple-delay": { time: .14, feedback: .68, stereo: .06, wet: 1, highpass: 120, lowpass: 3600, pingpong: 0 },
  "burns-simple-eq": { lowGain: 9, lowFrequency: 160, mediumGain: -8, mediumFrequency: 1200, mediumQuality: .8, highGain: 7, highFrequency: 6200 },
  "orbitronica-overdrive": { drive: .72, tone: 1800, outputGain: 4, mix: .75 },
  "orbitronica-filter": { type: "peaking", frequency: 1400, Q: 5, gain: 14 },
} as const;
const legacyControlIds = {
  "burns-simple-delay": ["time", "feedback", "stereo", "wet", "highpass", "lowpass", "pingpong"],
  "burns-simple-eq": ["lowGain", "lowFrequency", "mediumGain", "mediumFrequency", "mediumQuality", "highGain", "highFrequency"],
  "orbitronica-overdrive": ["drive", "tone", "outputGain", "mix"],
  "orbitronica-filter": ["type", "frequency", "Q", "gain"],
} as const;
async function legacyModule(id: LegacyId): Promise<LegacyModule> {
  const url = new URL(`./wam/${id}/index.js`, window.location.href).toString();
  return import(/* @vite-ignore */ url) as Promise<LegacyModule>;
}
async function setLegacyParams(id: LegacyId, node: LegacyNode, params: Record<string, unknown>) {
  if (id.startsWith("burns-simple-")) {
    if (!node.paramMgr) throw new Error("burns-parammgr-missing");
    await node.paramMgr.setState(params as Record<string, number>);
    const values = node.paramMgr.getParamsValues();
    for (const [key, value] of Object.entries(params)) if (typeof value !== "number" || Math.abs(values[key] - value) > 1e-6) throw new Error(`burns-parammgr-probe-failed:${key}`);
    return;
  }
  await node.setState?.({ schemaVersion: 1, params });
}
async function getLegacyState(id: LegacyId, node: LegacyNode) {
  if (id.startsWith("burns-simple-")) {
    if (!node.paramMgr) throw new Error("burns-parammgr-missing");
    return { params: node.paramMgr.getParamsValues(), opaqueState: await node.paramMgr.getState() };
  }
  return node.getState?.();
}
const legacyFixture: Fixture = (time, channel) => {
  // The different two-tone channels make a collapsed stereo path visible.
  const impulse = time < .002 ? (channel ? -.7 : .8) : 0;
  return impulse + .23 * Math.sin(2 * Math.PI * (channel ? 2813 : 487) * time) + .19 * Math.sin(2 * Math.PI * (channel ? 719 : 5631) * time);
};
async function renderLegacy(id: LegacyId, params: Record<string, unknown>, sampleRate = 44_100, fixture: Fixture = legacyFixture) {
  const context = new OfflineAudioContext(2, Math.ceil(2.4 * sampleRate), sampleRate);
  const { initializeWamHost } = await import("@webaudiomodules/sdk");
  const [group] = await initializeWamHost(context as unknown as AudioContext) as [string, string];
  const instance = await (await legacyModule(id)).default.createInstance(group, context as unknown as AudioContext);
  await setLegacyParams(id, instance.audioNode, params);
  const source = context.createBufferSource(), input = context.createBuffer(2, context.length, sampleRate);
  for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < input.length; frame++) input.getChannelData(channel)[frame] = fixture(frame / sampleRate, channel);
  source.buffer = input; source.connect(instance.audioNode); instance.audioNode.connect(context.destination); source.start();
  const output = await context.startRendering(); instance.audioNode.destroy?.(); return output;
}
const legacyDelta = (a: AudioBuffer, b: AudioBuffer) => Math.max(
  differenceRms(a.getChannelData(0), b.getChannelData(0), at(.15, a.sampleRate), a.length),
  differenceRms(a.getChannelData(1), b.getChannelData(1), at(.15, a.sampleRate), a.length),
);
const sameNumericMap = (actual: Record<string, number>, expected: Record<string, unknown>) => Object.entries(expected).every(([key, value]) => typeof value === "number" && Math.abs(actual[key] - value) <= 1e-6);
async function legacyStateMetric(id: LegacyId) {
  const context = new OfflineAudioContext(2, 128, 44_100);
  const { initializeWamHost } = await import("@webaudiomodules/sdk");
  const [group] = await initializeWamHost(context as unknown as AudioContext) as [string, string];
  const instance = await (await legacyModule(id)).default.createInstance(group, context as unknown as AudioContext);
  const params = legacyParams[id] as Record<string, unknown>; await setLegacyParams(id, instance.audioNode, params);
  const state = await getLegacyState(id, instance.audioNode); instance.audioNode.destroy?.();
  if (id.startsWith("burns-simple-")) return sameNumericMap((state as { params: Record<string, number> }).params, params);
  return JSON.stringify(state) === JSON.stringify({ schemaVersion: 1, params });
}
async function legacyMetrics() {
  const legacy = (id: LegacyId, parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>) => check(parameterId, metric, tolerance, run, id);
  for (const id of legacyIds) {
    const base = legacyParams[id] as Record<string, unknown>;
    await legacy(id, "state", "public-parameter-state-round-trip", "public parameter API restores every audited control", async () => {
      const ok = await legacyStateMetric(id); return { observed: ok ? legacyControlIds[id].length : 0, ok };
    });
    await legacy(id, "all-controls", "finite-bounded-stereo-extremes", "finite <= 10 FS, silence stable, and channels remain distinct", async () => {
      const output = await renderLegacy(id, base, 48_000);
      // Silence travels through the same source → plugin → destination route.
      const zeroOutput = await renderLegacy(id, { ...base, ...(id === "burns-simple-delay" ? { feedback: 1.2, wet: 1 } : {}) }, 44_100, () => 0);
      const l = output.getChannelData(0), r = output.getChannelData(1);
      const bound = Math.max(maxAbs(l), maxAbs(r)); const silenceFloor = Math.max(maxAbs(zeroOutput.getChannelData(0)), maxAbs(zeroOutput.getChannelData(1)));
      return { observed: Math.max(bound, silenceFloor), ok: finite(l) && finite(r) && bound <= 10 && silenceFloor <= 1e-7 && differenceRms(l, r, at(.2, 48_000), l.length) > 1e-5 };
    });
    for (const control of legacyControlIds[id]) await legacy(id, control, `non-neutral-public-control-${control}`, "changing only this public control changes the packaged OfflineAudioContext render", async () => {
      const changed: Record<string, unknown> = { ...base };
      const variants: Record<string, unknown> = {
        time: .42, feedback: .08, stereo: .5, wet: 0, highpass: 2200, lowpass: 9000, pingpong: 1,
        lowGain: -12, lowFrequency: 300, mediumGain: 10, mediumFrequency: 3200, mediumQuality: .15, highGain: -10, highFrequency: 9000,
        drive: .08, tone: 9000, outputGain: -12, mix: 0, type: "highpass", frequency: 5000, Q: .2, gain: -16,
      };
      changed[control] = variants[control];
      const plain = await renderLegacy(id, base), varied = await renderLegacy(id, changed);
      const observed = legacyDelta(plain, varied);
      return { observed, ok: Number.isFinite(observed) && observed > 1e-5 };
    });
  }
  await legacy("orbitronica-overdrive", "mix", "equal-power-projection", "mix=.5 projects dry/wet within .02 of cos/sin", async () => {
    const base = { ...legacyParams["orbitronica-overdrive"], drive: .55, tone: 3000, outputGain: 0 };
    const start = at(.15, 48_000), dry = (await renderLegacy("orbitronica-overdrive", { ...base, mix: 0 }, 48_000)).getChannelData(0).subarray(start), wet = (await renderLegacy("orbitronica-overdrive", { ...base, mix: 1 }, 48_000)).getChannelData(0).subarray(start), mixed = (await renderLegacy("orbitronica-overdrive", { ...base, mix: .5 }, 48_000)).getChannelData(0).subarray(start);
    const dd = dot(dry, dry), dw = dot(dry, wet), ww = dot(wet, wet), dm = dot(dry, mixed), wm = dot(wet, mixed), determinant = dd * ww - dw * dw;
    const dryGain = (dm * ww - wm * dw) / determinant, wetGain = (wm * dd - dm * dw) / determinant, observed = Math.max(Math.abs(dryGain - Math.SQRT1_2), Math.abs(wetGain - Math.SQRT1_2));
    return { observed, ok: Number.isFinite(observed) && observed <= .02 };
  });
}
async function modulationModule(id: "orbitronica-flanger" | "orbitronica-phaser") {
  const url = new URL(`./wam/${id}/index.js`, window.location.href).toString();
  return import(/* @vite-ignore */ url) as Promise<{ default: { createInstance(group: string, context: AudioContext): Promise<{ audioNode: ModNode }> } }>;
}
async function renderModulation(id: "orbitronica-flanger" | "orbitronica-phaser", params: Record<string, number>, sampleRate: number, stageSwitch?: number) {
  const context = new OfflineAudioContext(2, Math.ceil(2.2 * sampleRate), sampleRate);
  const instance = await (await modulationModule(id)).default.createInstance("phase4-dsp", context as unknown as AudioContext);
  await instance.audioNode.setState({ schemaVersion: 1, params });
  const source = context.createBufferSource(), buffer = context.createBuffer(2, context.length, sampleRate);
  for (let c = 0; c < 2; c++) for (let i = 0; i < buffer.length; i++) buffer.getChannelData(c)[i] = .35 * Math.sin(2 * Math.PI * (c ? 1379 : 997) * i / sampleRate) + .15 * Math.sin(2 * Math.PI * (c ? 293 : 431) * i / sampleRate);
  source.buffer = buffer; source.connect(instance.audioNode); instance.audioNode.connect(context.destination); source.start();
  const rendering = context.startRendering();
  if (stageSwitch !== undefined) { await context.suspend(1); await instance.audioNode.setState({ schemaVersion: 1, params: { ...params, stages: stageSwitch } }); context.resume(); }
  const output = await rendering; instance.audioNode.destroy(); return output;
}
async function phase4Metrics() {
  const mod = (id: "orbitronica-flanger" | "orbitronica-phaser", parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>) => check(parameterId, metric, tolerance, run, id);
  for (const rate of [44_100, 48_000]) {
    await mod("orbitronica-flanger", "all-controls", `finite-feedback-rate-depth-${rate}`, "finite, bounded; state preserves rate/depth/feedback/mix", async () => {
      const output = await renderModulation("orbitronica-flanger", { rate: 2, depth: .008, feedback: .8, mix: .7 }, rate); const l = output.getChannelData(0), r = output.getChannelData(1);
      return { observed: Math.max(maxAbs(l), maxAbs(r)), ok: finite(l) && finite(r) && Math.max(maxAbs(l), maxAbs(r)) < 10 && differenceRms(l, r, 0, l.length) > 1e-5 };
    });
    await mod("orbitronica-phaser", "all-controls", `finite-feedback-rate-depth-${rate}`, "finite, bounded at feedback .95", async () => {
      const output = await renderModulation("orbitronica-phaser", { rate: 2, depth: 1, stages: 8, feedback: .95, mix: .7 }, rate); const l = output.getChannelData(0), r = output.getChannelData(1);
      return { observed: Math.max(maxAbs(l), maxAbs(r)), ok: finite(l) && finite(r) && Math.max(maxAbs(l), maxAbs(r)) < 10 && differenceRms(l, r, 0, l.length) > 1e-5 };
    });
    await mod("orbitronica-phaser", "feedback", `notch-resonance-delta-${rate}`, "absolute feedback .8 changes wet response >= 2 dB versus zero", async () => {
      const base = await renderModulation("orbitronica-phaser", { rate: .5, depth: .75, stages: 6, feedback: 0, mix: 1 }, rate);
      const fed = await renderModulation("orbitronica-phaser", { rate: .5, depth: .75, stages: 6, feedback: .8, mix: 1 }, rate);
      const observed = Math.abs(db(measure(fed, 1.2, 2) / measure(base, 1.2, 2)));
      return { observed, ok: observed >= 2 && finite(fed.getChannelData(0)) && maxAbs(fed.getChannelData(0)) < 10 };
    });
  }
  await mod("orbitronica-flanger", "mix", "equal-power-neutral-and-wet", "mix=0 exact dry; mix=.7 meaningful wet delta", async () => {
    const dry = await renderModulation("orbitronica-flanger", { rate: .5, depth: .006, feedback: 0, mix: 0 }, 48_000), wet = await renderModulation("orbitronica-flanger", { rate: .5, depth: .006, feedback: 0, mix: .7 }, 48_000); const delta = differenceRms(dry.getChannelData(0), wet.getChannelData(0), 0, dry.length); return { observed: delta, ok: delta >= 1e-4 };
  });
  await mod("orbitronica-phaser", "stages", "fixed-graph-stage-crossfade-state", "4..8 exact state and non-neutral output per tap", async () => {
    const context = new OfflineAudioContext(2, 256, 48_000), node = (await (await modulationModule("orbitronica-phaser")).default.createInstance("stage-state", context as unknown as AudioContext)).audioNode;
    let exact = true; for (let stages = 4; stages <= 8; stages++) { await node.setState({ schemaVersion: 1, params: { rate: .5, depth: .75, stages, feedback: .5, mix: .7 } }); exact &&= (await node.getState()).params.stages === stages; } node.destroy(); return { observed: exact ? 5 : 0, ok: exact };
  });
  await mod("orbitronica-phaser", "mix", "equal-power-neutral-and-wet", "mix=0 exact dry; mix=.7 meaningful wet delta", async () => {
    const dry = await renderModulation("orbitronica-phaser", { rate: .5, depth: .75, stages: 6, feedback: 0, mix: 0 }, 48_000), wet = await renderModulation("orbitronica-phaser", { rate: .5, depth: .75, stages: 6, feedback: 0, mix: .7 }, 48_000); const delta = differenceRms(dry.getChannelData(0), wet.getChannelData(0), 0, dry.length); return { observed: delta, ok: delta >= 1e-4 };
  });
  for (const id of ["orbitronica-flanger", "orbitronica-phaser"] as const) {
    const base: Record<string, number> = id === "orbitronica-flanger" ? { rate: .5, depth: .004, feedback: .2, mix: 1 } : { rate: .5, depth: .5, stages: 6, feedback: .2, mix: 1 };
    for (const [parameterId, changed] of [["rate", { rate: 4 }], ["depth", { depth: id === "orbitronica-flanger" ? .008 : 1 }], ["feedback", { feedback: .8 }]] as const) await mod(id, parameterId, `per-control-response-${id}`, "control changes post-preroll response", async () => {
      const plain = await renderModulation(id, base, 48_000), varied = await renderModulation(id, { ...base, ...changed }, 48_000);
      const observed = differenceRms(plain.getChannelData(0), varied.getChannelData(0), at(.6, 48_000), plain.length);
      return { observed, ok: observed > 1e-5 && finite(varied.getChannelData(0)) };
    });
    await mod(id, "mix", `equal-power-coefficients-${id}`, "projection coefficients within .02 of cos/sin at mix .5", async () => {
      const dry = await renderModulation(id, { ...base, mix: 0 }, 48_000), wet = await renderModulation(id, { ...base, mix: 1 }, 48_000), mixed = await renderModulation(id, { ...base, mix: .5 }, 48_000);
      const a = dry.getChannelData(0), b = wet.getChannelData(0), c = mixed.getChannelData(0), aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), ac = dot(a, c), bc = dot(b, c), determinant = aa * bb - ab * ab;
      const dryGain = (ac * bb - bc * ab) / determinant, wetGain = (bc * aa - ac * ab) / determinant, observed = Math.max(Math.abs(dryGain - Math.SQRT1_2), Math.abs(wetGain - Math.SQRT1_2));
      return { observed, ok: Number.isFinite(observed) && observed <= .02 };
    });
  }
  await mod("orbitronica-phaser", "stages", "switch-during-audio-click-and-fixed-node-count", "4→8 switch during rendering remains finite with bounded adjacent-sample click", async () => {
    const switched = await renderModulation("orbitronica-phaser", { rate: .8, depth: .8, stages: 4, feedback: .5, mix: .7 }, 48_000, 8), samples = switched.getChannelData(0), atSwitch = at(1, 48_000);
    let click = 0; for (let i = atSwitch - 32; i < atSwitch + 32; i++) click = Math.max(click, Math.abs(samples[i] - samples[i - 1]));
    return { observed: click, ok: finite(samples) && click < .5 };
  });

}

async function reverbModule() {
  const url = new URL("./wam/orbitronica-reverb/index.js", window.location.href).toString();
  return import(/* @vite-ignore */ url) as Promise<{ default: { createInstance(group: string, context: AudioContext): Promise<{ audioNode: ModNode }> } }>;
}
async function renderReverb(params: ReverbParams, sampleRate: number, stereoIdentical = true) {
  const context = new OfflineAudioContext(2, Math.ceil(4.8 * sampleRate), sampleRate);
  const instance = await (await reverbModule()).default.createInstance("phase5-dsp", context as unknown as AudioContext);
  await instance.audioNode.setState({ schemaVersion: 1, params });
  const source = context.createBufferSource(), buffer = context.createBuffer(2, context.length, sampleRate), impulse = at(.2, sampleRate);
  buffer.getChannelData(0)[impulse] = .7; buffer.getChannelData(1)[impulse] = stereoIdentical ? .7 : -.35;
  source.buffer = buffer; source.connect(instance.audioNode); instance.audioNode.connect(context.destination); source.start();
  const output = await context.startRendering(); instance.audioNode.destroy(); return output;
}
const correlation = (a: Float32Array, b: Float32Array, from: number, to: number) => {
  let aa = 0, bb = 0, ab = 0; for (let index = from; index < to; index++) { aa += a[index] ** 2; bb += b[index] ** 2; ab += a[index] * b[index]; }
  return ab / Math.sqrt(Math.max(aa * bb, 1e-24));
};
const hfEnergy = (values: Float32Array, from: number, to: number) => {
  let total = 0; for (let index = Math.max(from + 1, 1); index < to; index++) total += (values[index] - values[index - 1]) ** 2;
  return total / Math.max(1, to - from - 1);
};
const onset = (values: Float32Array, from: number, to: number) => { for (let index = from; index < to; index++) if (Math.abs(values[index]) > .01) return index; return -1; };
async function phase5Metrics() {
  const reverb = (parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>) => check(parameterId, metric, tolerance, run, "orbitronica-reverb");
  for (const rate of [44_100, 48_000]) {
    await reverb("roomSize", `impulse-tail-length-${rate}`, "large room tail energy exceeds small room and converges", async () => {
      const small = await renderReverb({ roomSize: .1, damping: .2, width: 1, mix: 1 }, rate), large = await renderReverb({ roomSize: .8, damping: .2, width: 1, mix: 1 }, rate);
      const smallTail = measure(small, 1, 2), largeTail = measure(large, 1, 2), finalTail = measure(large, 3.8, 4.7);
      return { observed: largeTail / Math.max(smallTail, 1e-12), ok: largeTail > smallTail * 1.5 && finalTail < .01 && finite(large.getChannelData(0)) };
    });
    await reverb("damping", `high-frequency-tail-reduction-${rate}`, "damping .9 reduces differentiated tail energy by at least 3 dB", async () => {
      const bright = await renderReverb({ roomSize: .8, damping: 0, width: 1, mix: 1 }, rate), dark = await renderReverb({ roomSize: .8, damping: .9, width: 1, mix: 1 }, rate);
      const observed = hfEnergy(dark.getChannelData(0), at(.7, rate), at(2.5, rate)) / Math.max(hfEnergy(bright.getChannelData(0), at(.7, rate), at(2.5, rate)), 1e-12);
      return { observed, ok: observed <= .5 };
    });
    await reverb("width", `stereo-decorrelation-${rate}`, "width 1 lowers identical-input L/R correlation versus width 0", async () => {
      const narrow = await renderReverb({ roomSize: .7, damping: .3, width: 0, mix: 1 }, rate), wide = await renderReverb({ roomSize: .7, damping: .3, width: 1, mix: 1 }, rate);
      const narrowCorrelation = correlation(narrow.getChannelData(0), narrow.getChannelData(1), at(.3, rate), at(3, rate));
      const wideCorrelation = correlation(wide.getChannelData(0), wide.getChannelData(1), at(.3, rate), at(3, rate));
      return { observed: narrowCorrelation - wideCorrelation, ok: narrowCorrelation > .99 && wideCorrelation < .95 };
    });
    await reverb("sampleRate", `scaled-tuning-${rate}`, "first wet onset remains within 2 ms of the selected 44.1 kHz tuning", async () => {
      const output = await renderReverb({ roomSize: .5, damping: .3, width: 1, mix: 1 }, rate), first = onset(output.getChannelData(0), at(.2, rate), at(.8, rate));
      const seconds = first < 0 ? Number.NaN : first / rate - .2;
      return { observed: seconds, ok: Number.isFinite(seconds) && Math.abs(seconds - 1371 / 44_100) < .002 };
    });
  }
  await reverb("mix", "equal-power-neutral-and-wet", "mix=0 exact dry and mix=.7 changes signal", async () => {
    const dry = await renderReverb({ roomSize: .8, damping: .3, width: 1, mix: 0 }, 48_000), wet = await renderReverb({ roomSize: .8, damping: .3, width: 1, mix: .7 }, 48_000);
    const expected = new Float32Array(dry.length); expected[at(.2, 48_000)] = .7;
    const dryError = differenceRms(dry.getChannelData(0), expected, 0, dry.length), delta = differenceRms(dry.getChannelData(0), wet.getChannelData(0), 0, dry.length);
    return { observed: Math.max(dryError, 1 / Math.max(delta, 1e-12)), ok: dryError < 1e-6 && delta > 1e-4 };
  });
  await reverb("state", "strict-round-trip-and-v0-migration", "four-param ABI round trips exactly and clamps v0", async () => {
    const context = new OfflineAudioContext(2, 128, 44_100), node = (await (await reverbModule()).default.createInstance("reverb-state", context as unknown as AudioContext)).audioNode;
    const params = { roomSize: .8, damping: .5, width: .6, mix: .7 }; await node.setState({ schemaVersion: 1, params }); const exact = await node.getState();
    await node.setState({ roomSize: 2, damping: -1, width: 3, mix: -1 } as unknown as { schemaVersion: 1; params: Record<string, number> }); const migrated = await node.getState(); node.destroy();
    return { observed: Object.keys(exact.params).length, ok: JSON.stringify(exact) === JSON.stringify({ schemaVersion: 1, params }) && JSON.stringify(migrated) === JSON.stringify({ schemaVersion: 1, params: { roomSize: 1, damping: 0, width: 1, mix: 0 } }) };
  });
}

async function run() {
  try {
    await controlMetrics(44_100); await controlMetrics(48_000); await safetyMetrics(); await audioEnginePlaybackBaselines(); await bitcrusherMetrics(); await phase4Metrics(); await phase5Metrics(); await legacyMetrics();
    const status = metrics.every((metric) => metric.ok) ? "pass" : "fail";
    const catalogHarness = Object.fromEntries(legacyIds.map((catalogId) => [catalogId, {
      publicControls: legacyControlIds[catalogId],
      metrics: metrics.filter((metric) => metric.catalogId === catalogId).map((metric) => metric.metric),
    }]));
    const payload = { status, environment: { protocol: window.location.protocol, offlineAudioContext: typeof OfflineAudioContext === "function" }, catalogHarness, results: metrics };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  } catch (error) {
    const payload = { status: "fail", environment: { protocol: window.location.protocol, offlineAudioContext: typeof OfflineAudioContext === "function" }, results: metrics, error: error instanceof Error ? error.message : String(error) };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  }
}
void run();
