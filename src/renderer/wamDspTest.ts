/*
 * This is deliberately a Chromium OfflineAudioContext harness rather than a
 * Node approximation.  The compressor is a native DynamicsCompressorNode, so
 * its acceptance oracle must be the same browser implementation that ships.
 */
type Params = { threshold: number; knee: number; ratio: number; attack: number; release: number; makeupGain: number };
type Metric = { catalogId: string; parameterId: string; phase: "dsp"; metric: string; observed: number; tolerance: string; durationMs: number; ok: boolean; error?: string };
type PluginNode = AudioNode & { getState(): Promise<{ schemaVersion: number; params: Params }>; setState(value: { schemaVersion: 1; params: Params }): Promise<void>; destroy(): void };
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
async function check(parameterId: string, metric: string, tolerance: string, run: () => Promise<{ observed: number; ok: boolean }>) {
  const started = performance.now();
  try {
    const { observed, ok } = await run();
    const event: Metric = { catalogId: "orbitronica-compressor", parameterId, phase: "dsp", metric, observed, tolerance, durationMs: performance.now() - started, ok };
    metrics.push(event); console.log(`ORBITRONICA_WAM_DSP_METRIC ${JSON.stringify(event)}`);
  } catch (error) {
    const event: Metric = { catalogId: "orbitronica-compressor", parameterId, phase: "dsp", metric, observed: Number.NaN, tolerance, durationMs: performance.now() - started, ok: false, error: error instanceof Error ? error.message : String(error) };
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

async function run() {
  try {
    await controlMetrics(44_100); await controlMetrics(48_000); await safetyMetrics();
    const status = metrics.every((metric) => metric.ok) ? "pass" : "fail";
    const payload = { status, results: metrics };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  } catch (error) {
    const payload = { status: "fail", results: metrics, error: error instanceof Error ? error.message : String(error) };
    result!.textContent = JSON.stringify(payload); console.log(`ORBITRONICA_WAM_DSP ${JSON.stringify(payload)}`);
  }
}
void run();
