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

async function run() {
  try {
    await controlMetrics(44_100); await controlMetrics(48_000); await safetyMetrics(); await bitcrusherMetrics();
    const status = metrics.every((metric) => metric.ok) ? "pass" : "fail";
    const payload = { status, results: metrics };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  } catch (error) {
    const payload = { status: "fail", results: metrics, error: error instanceof Error ? error.message : String(error) };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  }
}
void run();
