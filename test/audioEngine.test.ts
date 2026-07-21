import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
}

class FakeNode {
  connect() { return this; }
  disconnect() {}
}

class FakeBufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = new FakeParam();
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  starts: Array<{ when: number; offset: number; duration?: number }> = [];
  start(when: number, offset: number, duration?: number) { this.starts.push({ when, offset, duration }); }
  stop() { this.onended?.(); }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakePanner extends FakeNode { pan = new FakeParam(); }
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(0); }
}

class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private channels: Float32Array[];
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() { return this.sampleRate > 0 ? this.length / this.sampleRate : 0; }
  getChannelData(channel: number) { return this.channels[channel]; }
  copyToChannel(source: Float32Array, channel: number) { this.channels[channel].set(source); }
}

let contextCount = 0;
let masterGain: FakeGain | undefined;
let masterPanner: FakePanner | undefined;
const createdSources: FakeBufferSource[] = [];

class FakeAudioContext {
  currentTime = 0;
  state = "suspended";
  destination = new FakeNode();
  constructor() { contextCount++; }
  createGain() {
    const gain = new FakeGain();
    if (!masterGain) masterGain = gain;
    return gain;
  }
  createStereoPanner() {
    masterPanner = new FakePanner();
    return masterPanner;
  }
  createMediaStreamDestination() { return Object.assign(new FakeNode(), { stream: {} }); }
  createChannelSplitter() { return new FakeNode(); }
  createChannelMerger() { return new FakeNode(); }
  createAnalyser() { return new FakeAnalyser(); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    createdSources.push(source);
    return source;
  }
  async decodeAudioData(raw: ArrayBuffer) {
    if (new Uint8Array(raw)[0] === 255) throw new Error("bad audio");
    return { length: 0, numberOfChannels: 0 };
  }
  async resume() { this.state = "running"; }
}

// processPlanetBuffer yields between chunks via `window.setTimeout`; the LRU cache tests
// below drive that real pipeline (deterministic recomputation is the behavior under test),
// so a minimal window polyfill is needed in this Node harness that otherwise has no DOM.
Object.assign(globalThis, {
  AudioContext: FakeAudioContext,
  window: {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id)
  }
});
const { audioEngine } = await import("../src/renderer/audio/audioEngine.ts");
const { OrbitWamRack } = await import("../src/renderer/audio/wamRack.ts");

type PrivateAudioEngine = Record<string, unknown>;

function privateAudioEngine(): PrivateAudioEngine {
  return audioEngine as unknown as PrivateAudioEngine;
}

test("recording path is lazy AudioWorklet PCM capture with acknowledged session protocol", () => {
  const source = fs.readFileSync(new URL("../src/renderer/audio/audioEngine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /MediaRecorder|createMediaStreamDestination/);
  for (const token of ["AudioWorkletNode", "recordingId", "started", "stopped", "processorerror", "URL.revokeObjectURL", "recordingModuleLoads", "recorderProcessorAssetUrl"]) {
    assert.ok(source.includes(token), `missing recording protocol token: ${token}`);
  }
  assert.match(source, /this\.frames >= 2048/);
  assert.match(source, /this\.recordingSession = session;[\s\S]*await this\.ensureRecordingNode/);
  assert.match(source, /addModule\(blobUrl\)[\s\S]*addModule\(recorderProcessorAssetUrl\)/);
  assert.match(source, /export type RecordedPcm = \{ channels: Float32Array\[\]\; sampleRate: number \}/);
  assert.doesNotMatch(source, /RecordedPcm = Blob/);
  assert.match(source, /if \(this\.recordingNode === node\) this\.failRecording/);
});

test("master setters remain lazy and initialize the first graph with stored values", async () => {
  audioEngine.setMasterVolume(.4);
  audioEngine.setMasterPan(-.25);
  assert.equal(contextCount, 0);

  await audioEngine.resume();
  assert.equal(contextCount, 1);
  assert.equal(masterGain?.gain.value, .4);
  assert.equal(masterPanner?.pan.value, -.25);
});

test("prunes only audio assets not retained by project history", async () => {
  await audioEngine.decodeBytes("keep", "keep.wav", new Uint8Array([1]));
  await audioEngine.decodeBytes("drop", "drop.wav", new Uint8Array([2]));

  audioEngine.pruneOrbits(new Set(["keep"]));

  assert.ok(audioEngine.getProjectAsset("keep"));
  assert.equal(audioEngine.getProjectAsset("drop"), undefined);
});

test("identical encoded content shares canonical bytes and decoded buffers across ingestion paths", async () => {
  const engine = privateAudioEngine();
  const bytes = new Uint8Array([7, 8, 9]);
  await audioEngine.decodeBytes("dedup-a", "first.wav", bytes);
  const staged = await audioEngine.stageProjectAudio([{ orbitId: "dedup-b", fileName: "second.wav", bytes: new Uint8Array(bytes), volume: 1, pan: 0 }]);
  audioEngine.installStagedOrbitAudio(staged[0]);
  try {
    assert.equal(engine.buffers.get("dedup-a"), engine.buffers.get("dedup-b"));
    assert.equal(audioEngine.getProjectAsset("dedup-a")?.bytes, audioEngine.getProjectAsset("dedup-b")?.bytes);
    assert.equal(audioEngine.getProjectAsset("dedup-a")?.fileName, "first.wav");
    assert.equal(audioEngine.getProjectAsset("dedup-b")?.fileName, "second.wav");
  } finally {
    audioEngine.removeOrbit("dedup-a");
    audioEngine.removeOrbit("dedup-b");
  }
});

test("project audio staging is non-mutating, supports same IDs, and rejects a partial batch atomically", async () => {
  await audioEngine.decodeBytes("same", "old.wav", new Uint8Array([1]));
  await assert.rejects(audioEngine.stageProjectAudio([
    { orbitId: "same", fileName: "new.wav", bytes: new Uint8Array([2]), volume: .5, pan: .2 },
    { orbitId: "other", fileName: "bad.wav", bytes: new Uint8Array([255]), volume: 1, pan: 0 }
  ]), /bad audio/);
  assert.equal(audioEngine.getProjectAsset("same")?.fileName, "old.wav");

  const staged = await audioEngine.stageProjectAudio([
    { orbitId: "same", fileName: "new.wav", bytes: new Uint8Array([3]), volume: .5, pan: .2 }
  ]);
  assert.equal(audioEngine.getProjectAsset("same")?.fileName, "old.wav");
  audioEngine.replaceProjectAudio(staged);
  assert.equal(audioEngine.getProjectAsset("same")?.fileName, "new.wav");
  assert.deepEqual([...audioEngine.getProjectAsset("same")!.bytes], [3]);
});

test("single-orbit staged install rejects collisions without replacing live audio", async () => {
  await audioEngine.decodeBytes("live", "live.wav", new Uint8Array([4]));
  const [collision, unique] = await audioEngine.stageProjectAudio([
    { orbitId: "live", fileName: "replacement.wav", bytes: new Uint8Array([5]), volume: 1, pan: 0 },
    { orbitId: "unique", fileName: "unique.wav", bytes: new Uint8Array([6]), volume: 1, pan: 0 }
  ]);
  assert.throws(() => audioEngine.installStagedOrbitAudio(collision), /already exists/);
  assert.equal(audioEngine.getProjectAsset("live")?.fileName, "live.wav");
  audioEngine.installStagedOrbitAudio(unique);
  assert.equal(audioEngine.getProjectAsset("unique")?.fileName, "unique.wav");
});

test("scene transition revokes a pending rack create before freezing its orbit", async () => {
  const orbitId = "wam-transition-race";
  await audioEngine.decodeBytes(orbitId, "race.wav", new Uint8Array([7]));
  const engine = privateAudioEngine();
  const runtime = engine.orbitRuntimes.get(orbitId);
  let resolve!: (instance: any) => void;
  let destroys = 0;
  const rack = new OrbitWamRack(runtime.input, runtime.panNode.input, () => new Promise((done) => { resolve = done; }), engine.pluginStateStore);
  engine.orbitWamRacks.set(orbitId, rack);
  const plugin = { id: "race-slot", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };

  const pending = audioEngine.reconcileOrbitPluginRack(orbitId, [plugin]);
  while (!resolve) await new Promise((done) => setTimeout(done, 0));
  // transitionScenePluginRacks must invalidate before freeze's first await.
  const transition = audioEngine.transitionScenePluginRacks([{ id: orbitId, plugins: [plugin] } as any], [], 91, "next-scene");
  resolve({ audioNode: new FakeNode(), destroy: async () => { destroys++; } });
  await pending;
  assert.equal(await transition, true);
  assert.equal(destroys, 1);
  assert.equal(audioEngine.getOrbitPluginStatus(orbitId, plugin.id), "idle");
  audioEngine.removeOrbit(orbitId);
});

test("newest A→B→A scene transition retains an active rack while stale freeze snapshots", async () => {
  const orbitId = "wam-freeze-reconcile-race";
  await audioEngine.decodeBytes(orbitId, "race.wav", new Uint8Array([8]));
  const engine = privateAudioEngine();
  const runtime = engine.orbitRuntimes.get(orbitId);
  const plugin = { id: "freeze-slot", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };
  let releaseSnapshot!: () => void;
  let destroys = 0;
  const rack = new OrbitWamRack(runtime.input, runtime.panNode.input, async () => ({
    audioNode: new FakeNode() as unknown as AudioNode,
    getState: async () => {
      await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      return { fresh: true };
    },
    destroy: async () => { destroys++; }
  }), engine.pluginStateStore, () => undefined, { stateDeadlineMs: 5 });
  engine.orbitWamRacks.set(orbitId, rack);
  await audioEngine.reconcileOrbitPluginRack(orbitId, [plugin], 100);

  const toB = audioEngine.transitionScenePluginRacks([{ id: orbitId, plugins: [plugin] } as any], [], 101, "B");
  while (!releaseSnapshot) await new Promise((done) => setTimeout(done, 0));
  const backToA = audioEngine.transitionScenePluginRacks([], [{ id: orbitId, plugins: [plugin] } as any], 102, "A");
  await backToA;
  releaseSnapshot();
  assert.equal(await toB, false);
  assert.equal(audioEngine.getScenePluginRuntimeOwner(), "A");
  assert.equal(audioEngine.getOrbitPluginStatus(orbitId, plugin.id), "ready");
  assert.equal(destroys, 0, "stale freeze must not destroy the current A runtime");
  audioEngine.removeOrbit(orbitId);
});

test("scene transition publishes its target while outgoing plugin destroy remains pending", async () => {
  const orbitId = "wam-pending-destroy-transition";
  await audioEngine.decodeBytes(orbitId, "pending.wav", new Uint8Array([9]));
  const engine = privateAudioEngine();
  const runtime = engine.orbitRuntimes.get(orbitId);
  const plugin = { id: "pending-destroy-slot", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };
  const never = new Promise<void>(() => undefined);
  let destroys = 0;
  const rack = new OrbitWamRack(
    runtime.input,
    runtime.panNode.input,
    async () => ({
      audioNode: new FakeNode() as unknown as AudioNode,
      getState: async () => ({ feedback: .25 }),
      destroy: () => { destroys++; return never; },
    }),
    engine.pluginStateStore,
    () => undefined,
    { cleanupDeadlineMs: 5 },
  );
  engine.orbitWamRacks.set(orbitId, rack);
  await audioEngine.reconcileOrbitPluginRack(orbitId, [plugin], 110);

  const outcome = await Promise.race([
    audioEngine.transitionScenePluginRacks(
      [{ id: orbitId, plugins: [plugin] } as any],
      [],
      111,
      "target-without-plugin",
    ).then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  assert.equal(outcome, "completed");
  assert.equal(destroys, 1);
  assert.equal(audioEngine.getScenePluginRuntimeOwner(), "target-without-plugin");
  audioEngine.removeOrbit(orbitId);
});

test("scene duplication clones external WAM state by its slot map without aliasing source state", () => {
  const engine = privateAudioEngine();
  engine.pluginStateStore.clear();
  engine.pluginStateStore.set("source-slot", { nested: [1] });
  const copied = audioEngine.copyPluginStatesBySlotMap(new Map([["source-slot", "duplicate-slot"]]));
  assert.deepEqual(copied, ["duplicate-slot"]);
  (engine.pluginStateStore.get("duplicate-slot") as any).nested.push(2);
  assert.deepEqual(engine.pluginStateStore.get("source-slot"), { nested: [1] });
  audioEngine.removePluginSlotStates(copied);
  assert.equal(engine.pluginStateStore.has("duplicate-slot"), false);
  engine.pluginStateStore.clear();
});

test("replacing the plugin state store deep-clones values so later mutation of the source or the store is isolated", () => {
  const engine = privateAudioEngine();
  engine.pluginStateStore.clear();
  const source = new Map([["slot-a", { nested: [1] }]]);
  audioEngine.replacePluginStateStore(source);
  (source.get("slot-a") as any).nested.push(2);
  assert.deepEqual(engine.pluginStateStore.get("slot-a"), { nested: [1] }, "mutating the source after replace must not affect the store");
  (engine.pluginStateStore.get("slot-a") as any).nested.push(3);
  assert.deepEqual(source.get("slot-a"), { nested: [1, 2] }, "mutating the store must not affect the caller's source map");
  engine.pluginStateStore.clear();
});

test("copying plugin slot states between orbit arrays deep-clones so source and destination stay independent", () => {
  const engine = privateAudioEngine();
  engine.pluginStateStore.clear();
  const sourceSlot = { id: "copy-source", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };
  const destSlot = { id: "copy-dest", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };
  engine.pluginStateStore.set(sourceSlot.id, { nested: [1] });
  audioEngine.copyPluginSlotStates([sourceSlot], [destSlot]);
  assert.deepEqual(engine.pluginStateStore.get(destSlot.id), { nested: [1] });
  (engine.pluginStateStore.get(destSlot.id) as any).nested.push(2);
  assert.deepEqual(engine.pluginStateStore.get(sourceSlot.id), { nested: [1] }, "mutating the copied destination state must not affect the source");
  engine.pluginStateStore.clear();
});

/**
 * This is a deterministic signal-level analogue of the live graph:
 * orbit input -> WAM rack -> pan -> orbit gain -> master pan -> PCM recorder.
 * It exercises the real rack rewiring code rather than a separate export path.
 */
class SignalNode {
  edges = new Set<SignalNode>();
  readonly transform: (sample: number) => number;
  constructor(transform: (sample: number) => number = (sample) => sample) { this.transform = transform; }
  connect(node: SignalNode) { this.edges.add(node); return node as unknown as AudioNode; }
  disconnect(node?: SignalNode) { if (node) this.edges.delete(node); else this.edges.clear(); }
}

function captureMasterPcm(source: SignalNode, sample: number, recorder: SignalNode) {
  const visit = (node: SignalNode, value: number, seen = new Set<SignalNode>()): number[] => {
    if (seen.has(node)) return [];
    const next = node.transform(value);
    if (node === recorder) return [next];
    const branch = new Set(seen); branch.add(node);
    return [...node.edges].flatMap((edge) => visit(edge, next, branch));
  };
  return visit(source, sample);
}

test("master PCM export captures the active WAM insert, but bypassed or unavailable slots stay dry", async () => {
  const input = new SignalNode();
  const panInput = new SignalNode();
  const panOutput = new SignalNode();
  const orbitGain = new SignalNode();
  const masterPan = new SignalNode();
  const recorder = new SignalNode();
  panInput.connect(panOutput); panOutput.connect(orbitGain); orbitGain.connect(masterPan); masterPan.connect(recorder);
  const state = new Map();
  const slot = { id: "export-slot", catalogId: "burns-simple-delay", pluginVersion: "0.2.54", bypassed: false };
  const rack = new OrbitWamRack(input as unknown as AudioNode, panInput as unknown as AudioNode,
    async () => ({ audioNode: new SignalNode((sample) => sample * 2) as unknown as AudioNode }), state);

  await rack.reconcile([slot]);
  assert.deepEqual(captureMasterPcm(input, .25, recorder), [.5], "the recorder taps the post-WAM master signal");

  await rack.reconcile([{ ...slot, bypassed: true }]);
  assert.deepEqual(captureMasterPcm(input, .25, recorder), [.25], "bypass restores the native dry route");

  const unavailableInput = new SignalNode();
  unavailableInput.connect(panInput);
  const unavailableRack = new OrbitWamRack(unavailableInput as unknown as AudioNode, panInput as unknown as AudioNode,
    async () => { throw new Error("catalog unavailable"); }, new Map());
  await unavailableRack.reconcile([{ ...slot, id: "unavailable-slot" }]);
  assert.equal(unavailableRack.getStatus("unavailable-slot"), "unavailable");
  assert.deepEqual(captureMasterPcm(unavailableInput, .25, recorder), [.25], "unavailable runtimes remain native and dry");
});

/**
 * Phase 5: the processed/reverse buffer caches are bounded LRUs (see
 * AudioEngine.PROCESSED_BUFFER_CACHE_CAP). These tests reach into the engine's private
 * `buffers`/`processedBuffers`/`active` maps directly (as the rest of this file already
 * does for WAM racks and plugin state) so they can drive the real processPlanetBuffer
 * pipeline without needing a full decode/playback graph.
 */
const PROCESSED_BUFFER_CACHE_CAP = 64; // must match AudioEngine.PROCESSED_BUFFER_CACHE_CAP

function clearOrbitProcessedBuffers(engine: any, ...orbitIds: string[]) {
  for (const cacheName of ["processedBuffers", "reverseBuffers"]) {
    for (const key of [...engine[cacheName].keys()]) {
      if (orbitIds.some((orbitId) => key.startsWith(`${orbitId}:`))) engine[cacheName].delete(key);
    }
  }
  for (const key of [...engine.processedWindows.keys()]) {
    if (orbitIds.some((orbitId) => key.startsWith(`${orbitId}:`))) engine.processedWindows.delete(key);
  }
  for (const orbitId of orbitIds) engine.buffers.delete(orbitId);
}

function setCachePolicyForTesting(policy?: unknown) {
  const method = Reflect.get(Object.getPrototypeOf(audioEngine), "setCachePolicyForTesting") as (...args: unknown[]) => void;
  method.call(audioEngine, policy);
}

function float32Hash(buffer: FakeAudioBuffer | AudioBuffer) {
  const hash = createHash("sha256");
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    hash.update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }
  return hash.digest("hex");
}

let testRenderOwner = 0;
function ensureTestProcessed(
  orbitId: string, planetId: string, speed: number, pitchCents: number,
  sampleStart = 0, sampleEnd = Infinity
) {
  return audioEngine.ensureProcessedBuffer({
    orbitId, planetId, speed, pitchCents, sampleStart, sampleEnd, direction: "forward"
  }, { ownerId: `test-render:${++testRenderOwner}`, priority: "background" });
}

function ensureTestPitch(orbitId: string, planetId: string, pitchCents: number) {
  return ensureTestProcessed(orbitId, planetId, 1, pitchCents);
}

test("packaged cache smoke adapter reports scheduler state and promotes a cold entry without rendering", async () => {
  await audioEngine.resume();
  const adapter = audioEngine.getAudioCacheSmokeAdapter();
  const orbitId = "smoke-adapter-orbit";
  const request = {
    orbitId,
    planetId: "smoke-adapter-planet",
    speed: 1,
    pitchCents: 100,
    sampleStart: 0,
    sampleEnd: Infinity,
    direction: "forward"
  } as const;
  adapter.setCachePolicy({ pcm16Enabled: true, hotByteBudget: 128, hotEntryBudget: 2, coldByteBudget: 128, coldEntryBudget: 2 });
  adapter.registerFixtureBuffer(orbitId, new FakeAudioBuffer(1, 16, 1000), 1);
  try {
    await audioEngine.ensureProcessedBuffer(request, { ownerId: "smoke-adapter", priority: "playback" });
    const warmed = adapter.getDiagnostics();
    assert.ok(warmed.scheduler.running <= 1);
    assert.equal(warmed.scheduler.pendingJobs, 0);
    assert.ok(warmed.processedKeys.some((key) => key.startsWith(`${orbitId}:`)));
    assert.ok(warmed.coldKeys.some((key) => key.startsWith(`${orbitId}:`)));

    const attemptsBeforePromotion = warmed.dspScheduler.renderAttempts;
    assert.equal(adapter.dropHotProcessedBuffer(request), true);
    const afterDrop = adapter.getDiagnostics();
    assert.equal(afterDrop.processedKeys.some((key) => key.startsWith(`${orbitId}:`)), false);
    assert.ok(afterDrop.coldKeys.some((key) => key.startsWith(`${orbitId}:`)));

    assert.equal(audioEngine.hasProcessedBuffer(orbitId, request.planetId, request.speed, request.pitchCents), true);
    const promoted = adapter.getDiagnostics();
    assert.equal(promoted.dspScheduler.renderAttempts, attemptsBeforePromotion);
    assert.ok(promoted.processedKeys.some((key) => key.startsWith(`${orbitId}:`)));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(adapter.getDiagnostics().scheduler.running, 0);
  } finally {
    audioEngine.removeOrbit(orbitId);
    adapter.setCachePolicy();
  }
});

test("audio memory statistics distinguish referenced, unique, and active-only logical residency", () => {
  const engine = privateAudioEngine();
  const baseline = audioEngine.getAudioMemoryStats();
  const original = new FakeAudioBuffer(2, 10, 1000);
  const processed = new FakeAudioBuffer(1, 8, 1000);
  const reverse = new FakeAudioBuffer(1, 4, 1000);
  const activeOnly = new FakeAudioBuffer(1, 6, 1000);
  const bytes = new Uint8Array(7);
  engine.buffers.set("stats-a", original);
  engine.buffers.set("stats-b", original);
  engine.rawFiles.set("stats-a", { fileName: "a.wav", bytes });
  engine.rawFiles.set("stats-b", { fileName: "b.wav", bytes });
  engine.processedBuffers.set("stats-a:p", processed);
  engine.reverseBuffers.set("stats-a:r", reverse);
  engine.active.set("stats-active-owned", { source: { buffer: processed } });
  engine.active.set("stats-active-only", { source: { buffer: activeOnly } });
  try {
    const stats = audioEngine.getAudioMemoryStats();
    assert.deepEqual({
      originalReferencedBytes: stats.originalReferencedBytes - baseline.originalReferencedBytes,
      originalUniqueBytes: stats.originalUniqueBytes - baseline.originalUniqueBytes,
      rawReferencedBytes: stats.rawReferencedBytes - baseline.rawReferencedBytes,
      rawUniqueBytes: stats.rawUniqueBytes - baseline.rawUniqueBytes,
      processedUniqueBytes: stats.processedUniqueBytes - baseline.processedUniqueBytes,
      reverseUniqueBytes: stats.reverseUniqueBytes - baseline.reverseUniqueBytes,
      activeOnlyUniqueBytes: stats.activeOnlyUniqueBytes - baseline.activeOnlyUniqueBytes,
      totalUniqueFloatBytes: stats.totalUniqueFloatBytes - baseline.totalUniqueFloatBytes,
      coldPcmBytes: stats.coldPcmBytes - baseline.coldPcmBytes
    }, {
      originalReferencedBytes: 160,
      originalUniqueBytes: 80,
      rawReferencedBytes: 14,
      rawUniqueBytes: 7,
      processedUniqueBytes: 32,
      reverseUniqueBytes: 16,
      activeOnlyUniqueBytes: 24,
      totalUniqueFloatBytes: 152,
      coldPcmBytes: 0
    });
  } finally {
    for (const id of ["stats-a", "stats-b"]) { engine.buffers.delete(id); engine.rawFiles.delete(id); }
    engine.processedBuffers.delete("stats-a:p");
    engine.reverseBuffers.delete("stats-a:r");
    engine.active.delete("stats-active-owned");
    engine.active.delete("stats-active-only");
  }
});

test("PCM16 cold conversion is opt-in, preserves silence, and inflates within one LSB", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  assert.equal(engine.pcm16ColdCacheEnabled, false, "the cold tier must be startup-default off");
  const electron = fs.readFileSync(new URL("../src/main/electron.ts", import.meta.url), "utf8");
  const rendererLaunchQuery = fs.readFileSync(new URL("../src/main/rendererLaunchQuery.ts", import.meta.url), "utf8");
  assert.match(electron, /--pcm16-cold-cache/);
  assert.match(electron, /getRendererLaunchQuery\(\{ pcm16ColdCache, wamDspTest, wamSmoke, audioCacheSmoke \}\)/);
  assert.match(rendererLaunchQuery, /pcm16ColdCache: "1"/);
  const source = new FakeAudioBuffer(1, 5, 1000);
  source.getChannelData(0).set([-1, -.25, 0, .25, 1]);
  const cold = engine.toColdPcm16(source);
  engine.coldProcessedBuffers.set("pcm16-test", cold);
  try {
    const inflated = engine.inflateColdProcessedBuffer("pcm16-test") as FakeAudioBuffer;
    const values = inflated.getChannelData(0);
    assert.equal(values[2], 0);
    for (let index = 0; index < values.length; index++) assert.ok(Math.abs(values[index] - source.getChannelData(0)[index]) <= 1 / 32768 + 1e-7);
  } finally {
    engine.coldProcessedBuffers.delete("pcm16-test");
    engine.processedBuffers.delete("pcm16-test");
  }
});

test("PCM16 byte budgets use one weighted hot LRU and promote cold data without re-encoding", async () => {
  await audioEngine.resume();
  const engine = audioEngine as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(audioEngine);
  const requestFor = Reflect.get(prototype, "processedBufferRequest") as (...args: unknown[]) => unknown;
  const describe = Reflect.get(prototype, "describeProcessedBuffer") as (request: unknown) => { key: string };
  const cache = Reflect.get(prototype, "cacheProcessedBuffer") as (...args: unknown[]) => void;
  const touch = Reflect.get(prototype, "touchCachedBuffer") as (...args: unknown[]) => unknown;
  const buffers = Reflect.get(audioEngine, "buffers") as Map<string, FakeAudioBuffer>;
  const processed = Reflect.get(audioEngine, "processedBuffers") as Map<string, FakeAudioBuffer>;
  const cold = Reflect.get(audioEngine, "coldProcessedBuffers") as Map<string, unknown>;
  const orbitId = "byte-lru-orbit";
  const source = new FakeAudioBuffer(1, 64, 1000);
  buffers.set(orbitId, source);
  setCachePolicyForTesting({ pcm16Enabled: true, hotByteBudget: 48, hotEntryBudget: 2, coldByteBudget: 32, coldEntryBudget: 4 });
  const insert = (planetId: string, channels: number, length: number, sampleRate: number) => {
    const request = requestFor.call(audioEngine, orbitId, planetId, 1, 100, 0, Infinity, "forward");
    const descriptor = describe.call(audioEngine, request);
    cache.call(audioEngine, processed, descriptor.key, new FakeAudioBuffer(channels, length, sampleRate), descriptor);
    return { descriptor, key: descriptor.key };
  };
  try {
    const first = insert("first", 1, 4, 1000);
    const second = insert("second", 2, 4, 11025);
    touch.call(audioEngine, processed, first.key, first.descriptor);
    const third = insert("third", 1, 4, 44100);
    assert.equal(processed.has(second.key), false, "least-recent 32-byte hot entry must be evicted by weighted pressure");
    assert.ok(processed.has(first.key));
    assert.ok(processed.has(third.key));
    assert.ok(cold.has(second.key), "hot eviction retains the forward cold representation");

    const originalToCold = Reflect.get(prototype, "toColdPcm16") as (...args: unknown[]) => unknown;
    let encodes = 0;
    Object.defineProperty(audioEngine, "toColdPcm16", { configurable: true, value: (...args: unknown[]) => { encodes++; return originalToCold.apply(audioEngine, args); } });
    try {
      const promoted = touch.call(audioEngine, processed, second.key, second.descriptor);
      assert.ok(promoted instanceof FakeAudioBuffer);
      assert.equal(encodes, 0, "cold promotion must reuse PCM16 rather than quantize the inflated buffer again");
    } finally {
      delete (audioEngine as unknown as Record<string, unknown>).toColdPcm16;
    }
    const diagnostics = audioEngine.getAudioCacheDiagnostics().cache;
    assert.equal(diagnostics.hotBytes, 48);
    assert.equal(diagnostics.hotEntries, 2);
    assert.equal(diagnostics.coldBytes, 32);
    assert.equal(diagnostics.coldEntries, 3);
  } finally {
    setCachePolicyForTesting();
    for (const mapName of ["processedBuffers", "coldProcessedBuffers", "processedEntries", "coldProcessedEntries", "processedWindows", "hotRecency"] as const) {
      (Reflect.get(audioEngine, mapName) as Map<string, unknown>).clear();
    }
    buffers.delete(orbitId);
  }
});

test("PCM16 shares hot recency with reverse artifacts and limits protected overage to protected hot entries", async () => {
  await audioEngine.resume();
  const prototype = Object.getPrototypeOf(audioEngine);
  const requestFor = Reflect.get(prototype, "processedBufferRequest") as (...args: unknown[]) => unknown;
  const describe = Reflect.get(prototype, "describeProcessedBuffer") as (request: unknown) => { key: string };
  const cache = Reflect.get(prototype, "cacheProcessedBuffer") as (...args: unknown[]) => void;
  const buffers = Reflect.get(audioEngine, "buffers") as Map<string, FakeAudioBuffer>;
  const processed = Reflect.get(audioEngine, "processedBuffers") as Map<string, FakeAudioBuffer>;
  const reversed = Reflect.get(audioEngine, "reverseBuffers") as Map<string, FakeAudioBuffer>;
  const cold = Reflect.get(audioEngine, "coldProcessedBuffers") as Map<string, unknown>;
  const orbitId = "byte-shared-orbit";
  buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const make = (planetId: string, direction: "forward" | "reverse" = "forward") => {
    const request = requestFor.call(audioEngine, orbitId, planetId, 1, 100, 0, Infinity, direction);
    const descriptor = describe.call(audioEngine, request);
    const key = direction === "reverse" ? `${descriptor.key}:reverse` : descriptor.key;
    return { request, descriptor, key };
  };
  try {
    setCachePolicyForTesting({ pcm16Enabled: true, hotByteBudget: 32, hotEntryBudget: 2, coldByteBudget: 64, coldEntryBudget: 8 });
    const forward = make("forward");
    const reverse = make("reverse", "reverse");
    const newest = make("newest");
    cache.call(audioEngine, processed, forward.key, new FakeAudioBuffer(1, 4, 1000), forward.descriptor);
    cache.call(audioEngine, reversed, reverse.key, new FakeAudioBuffer(1, 4, 1000), reverse.descriptor);
    cache.call(audioEngine, processed, newest.key, new FakeAudioBuffer(1, 4, 1000), newest.descriptor);
    assert.equal(processed.has(forward.key), false, "forward and reverse must compete in one hot LRU order");
    assert.ok(reversed.has(reverse.key));
    assert.ok(processed.has(newest.key));

    setCachePolicyForTesting({ pcm16Enabled: true, hotByteBudget: 16, hotEntryBudget: 1, coldByteBudget: 64, coldEntryBudget: 8 });
    const protectedA = make("protected-a");
    const protectedB = make("protected-b");
    const acquire = Reflect.get(prototype, "acquireResidency") as (...args: unknown[]) => () => void;
    const release = acquire.call(audioEngine, "byte-protected", [protectedA.request, protectedB.request]);
    cache.call(audioEngine, processed, protectedA.key, new FakeAudioBuffer(1, 4, 1000), protectedA.descriptor);
    cache.call(audioEngine, processed, protectedB.key, new FakeAudioBuffer(1, 4, 1000), protectedB.descriptor);
    const overage = audioEngine.getAudioCacheDiagnostics().cache;
    assert.equal(overage.protectedHotOverageBytes, 16);
    assert.equal(overage.protectedHotOverageEntries, 1);
    release();
    const converged = audioEngine.getAudioCacheDiagnostics().cache;
    assert.ok(converged.hotBytes <= converged.hotByteBudget);
    assert.ok(converged.hotEntries <= converged.hotEntryBudget);

    setCachePolicyForTesting({ pcm16Enabled: true, hotByteBudget: 64, hotEntryBudget: 8, coldByteBudget: 12, coldEntryBudget: 1 });
    const oversize = make("cold-oversize");
    cache.call(audioEngine, processed, oversize.key, new FakeAudioBuffer(1, 8, 1000), oversize.descriptor);
    assert.equal(cold.has(oversize.key), false, "a single cold entry over its byte budget must be rejected");
  } finally {
    setCachePolicyForTesting();
    for (const mapName of ["processedBuffers", "reverseBuffers", "coldProcessedBuffers", "processedEntries", "coldProcessedEntries", "reverseEntries", "processedWindows", "hotRecency"] as const) {
      (Reflect.get(audioEngine, mapName) as Map<string, unknown>).clear();
    }
    buffers.delete(orbitId);
  }
});

test("PCM16 hot accounting deduplicates cache identities and retains active-only source residency", async () => {
  await audioEngine.resume();
  const prototype = Object.getPrototypeOf(audioEngine);
  const requestFor = Reflect.get(prototype, "processedBufferRequest") as (...args: unknown[]) => unknown;
  const describe = Reflect.get(prototype, "describeProcessedBuffer") as (request: unknown) => { key: string };
  const cache = Reflect.get(prototype, "cacheProcessedBuffer") as (...args: unknown[]) => void;
  const buffers = Reflect.get(audioEngine, "buffers") as Map<string, FakeAudioBuffer>;
  const processed = Reflect.get(audioEngine, "processedBuffers") as Map<string, FakeAudioBuffer>;
  const active = Reflect.get(audioEngine, "active") as Map<string, { source: { buffer: FakeAudioBuffer } }>;
  const orbitId = "byte-identity-orbit";
  buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const descriptorFor = (planetId: string) => describe.call(audioEngine, requestFor.call(audioEngine, orbitId, planetId, 1, 100, 0, Infinity, "forward"));
  try {
    setCachePolicyForTesting({ pcm16Enabled: true, hotByteBudget: 16, hotEntryBudget: 1, coldByteBudget: 64, coldEntryBudget: 8 });
    const shared = new FakeAudioBuffer(1, 4, 1000);
    const first = descriptorFor("shared-first");
    const second = descriptorFor("shared-second");
    cache.call(audioEngine, processed, first.key, shared, first);
    cache.call(audioEngine, processed, second.key, shared, second);
    let diagnostics = audioEngine.getAudioCacheDiagnostics().cache;
    assert.equal(diagnostics.hotEntries, 1);
    assert.equal(diagnostics.hotBytes, 16);

    processed.clear();
    (Reflect.get(audioEngine, "hotRecency") as Map<string, unknown>).clear();
    const activeOnly = new FakeAudioBuffer(1, 4, 1000);
    active.set("byte-identity-active", { source: { buffer: activeOnly } });
    const candidate = descriptorFor("candidate");
    cache.call(audioEngine, processed, candidate.key, new FakeAudioBuffer(1, 4, 1000), candidate);
    diagnostics = audioEngine.getAudioCacheDiagnostics().cache;
    assert.equal(processed.has(candidate.key), false, "active-only source residency consumes the budget before an unprotected cache entry");
    assert.equal(diagnostics.hotEntries, 1);
    assert.equal(diagnostics.hotBytes, 16);
  } finally {
    setCachePolicyForTesting();
    active.delete("byte-identity-active");
    for (const mapName of ["processedBuffers", "coldProcessedBuffers", "processedEntries", "coldProcessedEntries", "processedWindows", "hotRecency"] as const) {
      (Reflect.get(audioEngine, mapName) as Map<string, unknown>).clear();
    }
    buffers.delete(orbitId);
  }
});

test("current playback coordinate parameters are pinned for forward and reverse loop/sequence playback", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "coordinate-baseline-orbit";
  const planetId = "coordinate-baseline-planet";
  const buffer = new FakeAudioBuffer(1, 10000, 1000);
  engine.buffers.set(orbitId, buffer);
  // P0 pins the legacy coordinate math; P1a correctly requires a non-neutral
  // rendered buffer rather than silently falling back to this original source.
  engine.processedBuffers.set(engine.processedBufferKey(orbitId, planetId, 1.25, 0, 2, 5), buffer);
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  createdSources.length = 0;
  try {
    audioEngine.syncLoop(orbitId, planetId, "forward", true, 3, 1, 0, 1, 1.25, 0, false, 2, 5);
    const forward = createdSources.at(-1)!;
    assert.deepEqual(forward.starts, [{ when: 0, offset: 2.4, duration: undefined }]);
    assert.equal(forward.loopStart, 1.6);
    assert.equal(forward.loopEnd, 4);

    audioEngine.syncLoop(orbitId, planetId, "reverse", true, 3, 1, 0, 1, 1.25, 0, true, 2, 5);
    const reverse = createdSources.at(-1)!;
    assert.deepEqual(reverse.starts, [{ when: 0, offset: 7.6, duration: undefined }]);
    assert.equal(reverse.loopStart, 6);
    assert.equal(reverse.loopEnd, 8.4);

    audioEngine.triggerSequence(orbitId, planetId, "sequence-forward", 1, 0, 1, 0, false, "overlap", 2, 5);
    assert.deepEqual(createdSources.at(-1)!.starts, [{ when: 0, offset: 2, duration: 3 }]);
    audioEngine.triggerSequence(orbitId, planetId, "sequence-reverse", 1, 0, 1, 0, true, "overlap", 2, 5);
    assert.deepEqual(createdSources.at(-1)!.starts, [{ when: 0, offset: 5, duration: 3 }]);
  } finally {
    audioEngine.removeOrbit(orbitId);
    createdSources.length = 0;
  }
});

test("guarded trim playback maps absolute audio time into the physical buffer once", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "guarded-coordinate-orbit";
  const planetId = "guarded-coordinate-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 10_000, 1000));
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const key = engine.processedBufferKey(orbitId, planetId, 1.25, 100, 2, 5);
  engine.processedBuffers.set(key, new FakeAudioBuffer(1, 2656, 1000));
  engine.processedWindows.set(key, { sourceStartFrame: 2000, sourceEndFrame: 5000, contentStartFrame: 1600, contentEndFrame: 4000, bufferStartFrame: 1472, bufferEndFrame: 4128, fullOutputLength: 8000 });
  createdSources.length = 0;
  try {
    audioEngine.syncLoop(orbitId, planetId, "guarded", true, 3, 1, 0, 1, 1.25, 100, false, 2, 5);
    const source = createdSources.at(-1)!;
    assert.equal(source.starts.length, 1);
    assert.equal(source.starts[0].when, 0);
    assert.equal(source.starts[0].duration, undefined);
    assert.ok(Math.abs(source.starts[0].offset - .928) < 1e-12);
    assert.equal(source.loopStart, .128);
    assert.equal(source.loopEnd, 2.528);
    audioEngine.syncLoop(orbitId, planetId, "guarded", true, 3.1, 1, 0, 1, 1.25, 100, false, 2, 5);
    assert.equal(createdSources.length, 1, "unchanged guarded loop bounds must not restart every transport tick");
  } finally { audioEngine.removeOrbit(orbitId); createdSources.length = 0; }
});

test("nearby speeds no longer share a rounded cache key or silently play the original on a miss", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "exact-speed-key-orbit";
  const planetId = "exact-speed-key-planet";
  const original = new FakeAudioBuffer(1, 1000, 1000);
  engine.buffers.set(orbitId, original);
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  createdSources.length = 0;
  try {
    const first = engine.processedBufferKey(orbitId, planetId, 1.00001, 100);
    const second = engine.processedBufferKey(orbitId, planetId, 1.00002, 100);
    assert.notEqual(first, second, "the key must retain the exact DSP speed");
    assert.deepEqual(engine.getPlaybackBuffer(orbitId, planetId, 1.25, 100), { status: "pending", cacheKey: engine.processedBufferKey(orbitId, planetId, 1.25, 100) });
    audioEngine.syncLoop(orbitId, planetId, "pending", true, 0, 1, 0, 1, 1.25, 100, false, 0, 1);
    assert.equal(createdSources.length, 0, "a non-neutral cache miss must skip rather than replay the original");
  } finally {
    audioEngine.removeOrbit(orbitId);
    createdSources.length = 0;
  }
});

test("a pending non-neutral loop schedules one playback render and self-heals on its next transport tick", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "self-heal-loop-orbit";
  const planetId = "self-heal-loop-planet";
  const source = new FakeAudioBuffer(1, 128, 1000);
  engine.buffers.set(orbitId, source);
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const originalEnsure = engine.ensureProcessedBuffer;
  const ensured: Array<{ request: { direction: string; sampleStart: number; sampleEnd: number }; options: { ownerId: string; priority: string } }> = [];
  engine.ensureProcessedBuffer = (request: { direction: string; sampleStart: number; sampleEnd: number }, options: { ownerId: string; priority: string }) => {
    ensured.push({ request, options });
    return originalEnsure.call(engine, request, options);
  };
  createdSources.length = 0;
  try {
    audioEngine.syncLoop(orbitId, planetId, "self-heal", true, .03, 1, 0, 1, 1.25, 100, false, 0, .1);
    assert.equal(createdSources.length, 0, "the triggering tick must not play the unprocessed original");
    const key = engine.processedBufferKey(orbitId, planetId, 1.25, 100, 0, .1);
    for (let attempt = 0; attempt < 40 && !engine.processedBuffers.has(key); attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.ok(engine.processedBuffers.has(key), "the miss must enqueue a render without an external UI mutation");
    assert.deepEqual(ensured, [{
      request: { orbitId, planetId, speed: 1.25, pitchCents: 100, direction: "forward", sampleStart: 0, sampleEnd: .1 },
      options: { ownerId: `playback:${key}`, priority: "playback" }
    }]);

    audioEngine.syncLoop(orbitId, planetId, "self-heal", true, .03, 1, 0, 1, 1.25, 100, false, 0, .1);
    assert.equal(createdSources.length, 1, "the later loop tick must begin once its exact render is ready");
    assert.equal(ensured.length, 1, "a ready hit must not schedule another render");
  } finally {
    engine.ensureProcessedBuffer = originalEnsure;
    audioEngine.removeOrbit(orbitId);
    createdSources.length = 0;
  }
});

test("a pending reverse render keeps sequence edges non-replayable and preserves reverse readiness", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "self-heal-reverse-orbit";
  const planetId = "self-heal-reverse-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 128, 1000));
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const originalEnsure = engine.ensureProcessedBuffer;
  const directions: string[] = [];
  engine.ensureProcessedBuffer = (request: { direction: string }, options: unknown) => {
    directions.push(request.direction);
    return originalEnsure.call(engine, request, options);
  };
  createdSources.length = 0;
  try {
    audioEngine.triggerSequence(orbitId, planetId, "reverse-edge", 1, 0, 1, 125, true, "overlap", 0, .1);
    const key = engine.processedBufferKey(orbitId, planetId, 1, 125, 0, .1);
    for (let attempt = 0; attempt < 40 && !engine.processedBuffers.has(key); attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(createdSources.length, 0, "a completed render must not replay a past sequence edge");
    assert.deepEqual(directions, ["reverse"]);

    audioEngine.triggerSequence(orbitId, planetId, "reverse-edge", 1, 0, 1, 125, true, "overlap", 0, .1);
    assert.equal(createdSources.length, 1, "only a new valid edge may begin the reverse sequence");
    assert.ok(engine.reverseBuffers.has(`${key}:reverse`), "reverse playback must cache the reverse artifact after forward readiness");
  } finally {
    engine.ensureProcessedBuffer = originalEnsure;
    audioEngine.removeOrbit(orbitId);
    createdSources.length = 0;
  }
});

test("an aborted scene-epoch playback miss releases its high-priority consumer before stale audio installs", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "scoped-playback-orbit";
  const planetId = "scoped-playback-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 32_768, 1000));
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const originalRender = engine.renderPlanetBuffer;
  let checkpoint!: () => void;
  engine.renderPlanetBuffer = async (_descriptor: unknown, shouldCancel: () => boolean) => {
    await new Promise<void>((resolve) => { checkpoint = resolve; });
    if (shouldCancel()) throw new DOMException("cancelled", "AbortError");
  };
  const controller = new AbortController();
  const scope = { ownerId: "playback:scene-a:12:loop:planet:bar", signal: controller.signal };
  try {
    audioEngine.syncLoop(orbitId, planetId, "scoped", true, .01, 1, 0, 1, 1.25, 100, false, 0, .1, scope);
    while (!checkpoint) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    checkpoint();
    for (let attempt = 0; attempt < 20 && engine.dspJobs.size > 0; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const key = engine.processedBufferKey(orbitId, planetId, 1.25, 100, 0, .1);
    assert.equal(engine.dspJobs.size, 0);
    assert.equal(engine.dspJobsByOwner.has(scope.ownerId), false);
    assert.equal(engine.processedBuffers.has(key), false);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    audioEngine.removeOrbit(orbitId);
  }
});

test("repeated pending loop ticks share one stable playback consumer", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "self-heal-dedup-orbit";
  const planetId = "self-heal-dedup-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 128, 1000));
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const originalRender = engine.renderPlanetBuffer;
  let renderCount = 0;
  let release!: () => void;
  engine.renderPlanetBuffer = async () => {
    renderCount++;
    await new Promise<void>((resolve) => { release = resolve; });
  };
  try {
    audioEngine.syncLoop(orbitId, planetId, "dedup", true, 0, 1, 0, 1, 1.25, 100, false, 0, .1);
    while (!release) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    audioEngine.syncLoop(orbitId, planetId, "dedup", true, 0, 1, 0, 1, 1.25, 100, false, 0, .1);

    assert.equal(renderCount, 1);
    assert.equal(engine.dspJobs.size, 1);
    assert.equal(engine.dspJobsByOwner.size, 1);
    release();
    for (let attempt = 0; attempt < 10 && engine.dspJobs.size > 0; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.dspJobs.size, 0);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    audioEngine.removeOrbit(orbitId);
  }
});

test("a playback miss with no current source schedules no stale render", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalEnsure = engine.ensureProcessedBuffer;
  let ensureCount = 0;
  engine.ensureProcessedBuffer = () => {
    ensureCount++;
    return Promise.resolve();
  };
  try {
    audioEngine.syncLoop("missing-source", "missing-planet", "missing-bar", true, 0, 1, 0, 1, 1.25, 100, false);
    assert.equal(ensureCount, 0);
  } finally {
    engine.ensureProcessedBuffer = originalEnsure;
  }
});

test("registering a replacement source invalidates that orbit's processed and reverse cache entries", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "source-replacement-orbit";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 16, 1000));
  engine.processedBuffers.set(`${orbitId}:planet:speed=1.25:pitch=100`, new FakeAudioBuffer(1, 16, 1000));
  engine.reverseBuffers.set(`${orbitId}:planet:speed=1.25:pitch=100:reverse`, new FakeAudioBuffer(1, 16, 1000));
  try {
    engine.registerBuffer(orbitId, new FakeAudioBuffer(1, 32, 1000), 1);
    assert.equal([...engine.processedBuffers.keys()].some((key: string) => key.startsWith(`${orbitId}:`)), false);
    assert.equal([...engine.reverseBuffers.keys()].some((key: string) => key.startsWith(`${orbitId}:`)), false);
  } finally {
    audioEngine.removeOrbit(orbitId);
  }
});

test("source generation rejects a stale artifact after replacement, including the same buffer identity", async () => {
  await audioEngine.resume();
  const orbitId = "source-lease-stale-artifact";
  const planetId = "source-lease-planet";
  const engine = Object.getPrototypeOf(audioEngine);
  const registerBuffer = Reflect.get(engine, "registerBuffer");
  const describeProcessedBuffer = Reflect.get(engine, "describeProcessedBuffer");
  const processedBufferRequest = Reflect.get(engine, "processedBufferRequest");
  const renderPlanetBuffer = Reflect.get(engine, "renderPlanetBuffer");
  const source = new FakeAudioBuffer(1, 256, 1000);
  registerBuffer.call(audioEngine, orbitId, source, 1);
  const request = processedBufferRequest.call(audioEngine, orbitId, planetId, 1.25, 100);
  const stale = describeProcessedBuffer.call(audioEngine, request);
  registerBuffer.call(audioEngine, orbitId, source, 1);
  const current = describeProcessedBuffer.call(audioEngine, request);
  try {
    assert.notEqual(stale.lease.generation, current.lease.generation);
    assert.equal(stale.lease.buffer, current.lease.buffer);
    assert.equal(audioEngine.getAudioCacheDiagnostics().sourceGenerations[orbitId], current.lease.generation);
    await assert.rejects(renderPlanetBuffer.call(audioEngine, stale), /Audio source changed before rendering/);
  } finally {
    audioEngine.removeOrbit(orbitId);
  }
});

test("source lease never reuses a generation after remove and re-add", async () => {
  await audioEngine.resume();
  const orbitId = "source-lease-remove-readd";
  const engine = Object.getPrototypeOf(audioEngine);
  const registerBuffer = Reflect.get(engine, "registerBuffer");
  const source = new FakeAudioBuffer(1, 64, 1000);
  registerBuffer.call(audioEngine, orbitId, source, 1);
  const firstGeneration = audioEngine.getAudioCacheDiagnostics().sourceGenerations[orbitId] ?? 0;
  audioEngine.removeOrbit(orbitId);
  registerBuffer.call(audioEngine, orbitId, source, 1);
  try {
    assert.ok((audioEngine.getAudioCacheDiagnostics().sourceGenerations[orbitId] ?? 0) > firstGeneration);
  } finally {
    audioEngine.removeOrbit(orbitId);
  }
});

test("failed replacement rollback restores source-safe hot, cold, reverse, and window entries", async () => {
  await audioEngine.resume();
  const orbitId = "replacement-rollback-cache-orbit";
  const planetId = "replacement-rollback-cache-planet";
  const source = new FakeAudioBuffer(1, 256, 1000);
  const prototype = Object.getPrototypeOf(audioEngine);
  const registerBuffer = Reflect.get(prototype, "registerBuffer");
  const processedBufferKey = Reflect.get(prototype, "processedBufferKey");
  const describeProcessedBuffer = Reflect.get(prototype, "describeProcessedBuffer");
  const processedBufferRequest = Reflect.get(prototype, "processedBufferRequest");
  const createReversedBuffer = Reflect.get(prototype, "createReversedBuffer");
  const toColdPcm16 = Reflect.get(prototype, "toColdPcm16");
  const cacheEntryFor = Reflect.get(prototype, "cacheEntryFor");
  const processedBuffers = Reflect.get(audioEngine, "processedBuffers");
  const processedWindows = Reflect.get(audioEngine, "processedWindows");
  const reverseBuffers = Reflect.get(audioEngine, "reverseBuffers");
  const coldProcessedBuffers = Reflect.get(audioEngine, "coldProcessedBuffers");
  const coldProcessedEntries = Reflect.get(audioEngine, "coldProcessedEntries");
  const buffers = Reflect.get(audioEngine, "buffers");
  registerBuffer.call(audioEngine, orbitId, source, 1);
  await ensureTestProcessed(orbitId, planetId, 1.25, 100);
  const residencyRequest = {
    orbitId, planetId, speed: 1.25, pitchCents: 100,
    sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const
  };
  audioEngine.replacePermanentResidency("rollback-permanent", [residencyRequest]);
  const releaseRollbackLease = audioEngine.acquireResidency("rollback-acquired", [residencyRequest]);
  const generationBeforeFailure = audioEngine.getAudioCacheDiagnostics().sourceGenerations[orbitId];
  audioEngine.syncLoop(orbitId, planetId, "rollback-live-loop", true, .03, .75, 20, 1, 1.25, 100, false, 0, Infinity);
  const activeLoops = Reflect.get(audioEngine, "active") as Map<string, { source: FakeBufferSource; planetAudioPan: number }>;
  const originalLoopSource = activeLoops.get(`loop:${planetId}:rollback-live-loop`)?.source;
  assert.ok(originalLoopSource);
  const reversePlanetId = `${planetId}-reverse`;
  audioEngine.syncLoop(orbitId, reversePlanetId, "rollback-reverse-loop", true, .04, .5, -30, 1, 1, 0, true, .02, .12);
  const originalReverseSource = activeLoops.get(`loop:${reversePlanetId}:rollback-reverse-loop`)?.source;
  assert.ok(originalReverseSource);
  const context = Reflect.get(audioEngine, "context") as { currentTime: number };
  context.currentTime = .013;
  const oldKey = processedBufferKey.call(audioEngine, orbitId, planetId, 1.25, 100);
  const oldHot = processedBuffers.get(oldKey);
  const oldWindow = processedWindows.get(oldKey);
  const descriptor = describeProcessedBuffer.call(audioEngine, processedBufferRequest.call(audioEngine, orbitId, planetId, 1.25, 100));
  const oldReverse = createReversedBuffer.call(audioEngine, `${oldKey}:reverse`, oldHot, descriptor);
  const oldCold = toColdPcm16.call(audioEngine, oldHot);
  coldProcessedBuffers.set(oldKey, oldCold);
  coldProcessedEntries.set(oldKey, cacheEntryFor.call(audioEngine, descriptor, "forward", oldHot));
  Reflect.set(audioEngine, "registerBuffer", (id: string, buffer: FakeAudioBuffer, volume: number) => {
    if (id === "replacement-rollback-failure") throw new Error("injected replacement failure");
    return registerBuffer.call(audioEngine, id, buffer, volume);
  });
  try {
    assert.throws(() => audioEngine.replaceProjectAudio([
      { orbitId: "replacement-rollback-success", fileName: "success.wav", bytes: new Uint8Array([1]), buffer: new FakeAudioBuffer(1, 64, 1000), volume: 1, pan: 0 },
      { orbitId: "replacement-rollback-failure", fileName: "failure.wav", bytes: new Uint8Array([2]), buffer: new FakeAudioBuffer(1, 64, 1000), volume: 1, pan: 0 }
    ]), /injected replacement failure/);
    const restoredKey = processedBufferKey.call(audioEngine, orbitId, planetId, 1.25, 100);
    const restoredCold = coldProcessedBuffers.get(restoredKey);
    assert.equal(buffers.get(orbitId), source);
    assert.equal(processedBuffers.get(restoredKey), oldHot);
    assert.equal(reverseBuffers.get(`${restoredKey}:reverse`), oldReverse);
    assert.deepEqual(processedWindows.get(restoredKey), oldWindow);
    assert.equal(restoredCold, oldCold);
    assert.equal(coldProcessedEntries.get(restoredKey).byteLength, oldCold.channels.reduce((total: number, channel: Int16Array) => total + channel.byteLength, 0));
    assert.ok((audioEngine.getAudioCacheDiagnostics().sourceGenerations[orbitId] ?? 0) > (generationBeforeFailure ?? 0));
    const restoredLoopSource = activeLoops.get(`loop:${planetId}:rollback-live-loop`)?.source;
    assert.ok(restoredLoopSource);
    assert.notEqual(restoredLoopSource, originalLoopSource, "rollback must recreate the live loop after the failed graph swap");
    assert.equal(restoredLoopSource.loop, true);
    assert.equal(restoredLoopSource.playbackRate.value, 1);
    assert.ok(Math.abs(restoredLoopSource.starts[0].offset - .037) < 1e-9, "forward rollback must resume its non-boundary phase rather than loopStart");
    assert.equal(activeLoops.get(`loop:${planetId}:rollback-live-loop`)?.planetAudioPan, 20);
    const restoredReverse = activeLoops.get(`loop:${reversePlanetId}:rollback-reverse-loop`);
    assert.ok(restoredReverse);
    assert.notEqual(restoredReverse.source, originalReverseSource);
    assert.equal(restoredReverse.planetAudioPan, -30);
    assert.ok(Math.abs(restoredReverse.source.starts[0].offset - .229) < 1e-9, "reverse trimmed rollback must retain its mirrored non-boundary phase");
    context.currentTime = .014;
    audioEngine.syncLoop(orbitId, reversePlanetId, "rollback-reverse-loop", true, .04, .5, -30, 1, 1, 0, true, .02, .12);
    assert.equal(activeLoops.get(`loop:${reversePlanetId}:rollback-reverse-loop`)?.source, restoredReverse.source, "the next transport tick must retain the restored reverse phase instead of restarting it");
    for (let cents = 1000; cents < 1000 + PROCESSED_BUFFER_CACHE_CAP + 8; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.ok(processedBuffers.has(restoredKey), "restored permanent and acquired leases must protect the new source generation under LRU pressure");
  } finally {
    releaseRollbackLease();
    audioEngine.replacePermanentResidency("rollback-permanent", []);
    Reflect.deleteProperty(audioEngine, "registerBuffer");
    audioEngine.removeOrbit(orbitId);
    audioEngine.removeOrbit("replacement-rollback-success");
  }
});

test("neutral forward and neutral reverse preserve full-source PCM without processed cache storage", async () => {
  await audioEngine.resume();
  const orbitId = "neutral-reverse-pcm-orbit";
  const planetId = "neutral-reverse-pcm-planet";
  const source = new FakeAudioBuffer(1, 32, 1000);
  source.getChannelData(0).set(Array.from({ length: source.length }, (_, index) => (index - 16) / 16));
  const prototype = Object.getPrototypeOf(audioEngine);
  const registerBuffer = Reflect.get(prototype, "registerBuffer");
  const getPlaybackBuffer = Reflect.get(prototype, "getPlaybackBuffer");
  const processedBuffers = Reflect.get(audioEngine, "processedBuffers");
  registerBuffer.call(audioEngine, orbitId, source, 1);
  createdSources.length = 0;
  try {
    const sourceHash = float32Hash(source);
    const forward = getPlaybackBuffer.call(audioEngine, orbitId, planetId, 1, 0, .004, .012);
    assert.equal(forward.status, "ready");
    assert.equal(forward.buffer, source);
    assert.equal(float32Hash(source), sourceHash);
    audioEngine.syncLoop(orbitId, planetId, "neutral-reverse", true, 0, 1, 0, 1, 1, 0, true, .004, .012);
    const reverse = createdSources.at(-1)?.buffer;
    assert.ok(reverse);
    assert.equal(reverse.length, source.length);
    assert.deepEqual(Array.from(reverse.getChannelData(0)), Array.from(source.getChannelData(0)).reverse());
    assert.equal(processedBuffers.size, 0);
  } finally {
    audioEngine.removeOrbit(orbitId);
    createdSources.length = 0;
  }
});

test("concurrent requests for one processed tuple share one scheduled render", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "dedup-render-orbit";
  const planetId = "dedup-render-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let renders = 0;
  engine.renderPlanetBuffer = async (...args: unknown[]) => {
    renders++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return originalRender.apply(engine, args);
  };
  try {
    await Promise.all([
      ensureTestProcessed(orbitId, planetId, 1.25, 100),
      ensureTestProcessed(orbitId, planetId, 1.25, 100)
    ]);
    assert.equal(renders, 1);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("DSP consumer promises are isolated while one render serves both owners", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "dsp-consumer-orbit";
  const request = { orbitId, planetId: "dsp-consumer-planet", speed: 1.25, pitchCents: 100, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 32_768, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let renders = 0;
  let release!: () => void;
  engine.renderPlanetBuffer = async () => {
    renders++;
    await new Promise<void>((resolve) => { release = resolve; });
  };
  const controller = new AbortController();
  try {
    const aborted = audioEngine.ensureProcessedBuffer(request, { ownerId: "consumer-a", signal: controller.signal });
    const retained = audioEngine.ensureProcessedBuffer(request, { ownerId: "consumer-b" });
    assert.notEqual(aborted, retained);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(aborted, { name: "AbortError" });
    release();
    await retained;
    assert.equal(renders, 1);
    assert.equal(engine.dspJobs.size, 0);
    assert.equal(engine.dspJobsByOwner.size, 0);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("queued cancellation removes a DSP job before it renders", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  let release!: () => void;
  const rendered: string[] = [];
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }) => {
    rendered.push(descriptor.request.orbitId);
    await new Promise<void>((resolve) => { release = resolve; });
  };
  const first = { orbitId: "queued-first", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const second = { orbitId: "queued-second", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(first.orbitId, new FakeAudioBuffer(1, 64, 1000));
  engine.buffers.set(second.orbitId, new FakeAudioBuffer(1, 64, 1000));
  const controller = new AbortController();
  try {
    const running = audioEngine.ensureProcessedBuffer(first, { ownerId: "running-owner" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = audioEngine.ensureProcessedBuffer(second, { ownerId: "queued-owner", signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, { name: "AbortError" });
    assert.equal(engine.dspJobs.has(engine.describeProcessedBuffer(second).key), false);
    release();
    await running;
    assert.deepEqual(rendered, [first.orbitId]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, first.orbitId);
    clearOrbitProcessedBuffers(engine, second.orbitId);
  }
});

test("A-B-A rejoin clears pending cancellation before a running DSP render completes", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "dsp-rejoin-orbit";
  const request = { orbitId, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let release!: () => void;
  engine.renderPlanetBuffer = async () => new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  try {
    const firstA = audioEngine.ensureProcessedBuffer(request, { ownerId: "owner-a", signal: controller.signal });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(firstA, { name: "AbortError" });
    const secondA = audioEngine.ensureProcessedBuffer(request, { ownerId: "owner-a" });
    assert.equal(engine.dspJobs.get(engine.describeProcessedBuffer(request).key).cancelRequested, false);
    release();
    await secondA;
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("running cancellation rejects its consumer and clears terminal DSP state", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "running-cancellation-orbit";
  const request = { orbitId, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let started!: () => void;
  engine.renderPlanetBuffer = async (_descriptor: unknown, shouldCancel: () => boolean) => {
    await new Promise<void>((resolve) => { started = resolve; });
    if (shouldCancel()) throw engine.abortError();
  };
  const controller = new AbortController();
  try {
    const pending = audioEngine.ensureProcessedBuffer(request, { ownerId: "running-owner", signal: controller.signal });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    started();
    await assert.rejects(pending, { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.dspJobs.size, 0);
    assert.equal(engine.dspJobsByOwner.size, 0);
    assert.equal(engine.dspRenderQueue.length, 0);
    assert.equal(engine.activeDspRenders, 0);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("lifecycle cancellation leaves no consumer, job, or cache installation after deletion, history, or project replacement", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  let release!: () => void;
  engine.renderPlanetBuffer = async (_descriptor: unknown, shouldCancel: () => boolean) => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (shouldCancel()) throw engine.abortError();
  };
  try {
    for (const lifecycle of ["planet-delete", "orbit-delete", "undo-redo", "project-replace"]) {
      const orbitId = `lifecycle-${lifecycle}`;
      const request = { orbitId, planetId: "planet", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
      const controller = new AbortController();
      engine.buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
      release = undefined!;
      const pending = audioEngine.ensureProcessedBuffer(request, { ownerId: `lifecycle:${lifecycle}`, priority: "selected", signal: controller.signal });
      while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      release();
      await assert.rejects(pending, { name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const key = engine.describeProcessedBuffer(request).key;
      assert.equal(engine.dspJobs.size, 0, `${lifecycle}: no remaining job`);
      assert.equal(engine.dspJobsByOwner.size, 0, `${lifecycle}: no remaining consumer`);
      assert.equal(engine.processedBuffers.has(key), false, `${lifecycle}: no stale cache installation`);
      clearOrbitProcessedBuffers(engine, orbitId);
    }
  } finally {
    engine.renderPlanetBuffer = originalRender;
  }
});

test("terminal cleanup clears DSP maps after success and renderer error", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const success = { orbitId: "terminal-success", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const failure = { orbitId: "terminal-error", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(success.orbitId, new FakeAudioBuffer(1, 64, 1000));
  engine.buffers.set(failure.orbitId, new FakeAudioBuffer(1, 64, 1000));
  try {
    engine.renderPlanetBuffer = async () => undefined;
    await audioEngine.ensureProcessedBuffer(success, { ownerId: "success-owner" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.dspJobs.size, 0);
    assert.equal(engine.dspJobsByOwner.size, 0);
    assert.equal(engine.activeDspRenders, 0);
    engine.renderPlanetBuffer = async () => { throw new Error("injected DSP failure"); };
    await assert.rejects(audioEngine.ensureProcessedBuffer(failure, { ownerId: "failure-owner" }), /injected DSP failure/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.dspJobs.size, 0);
    assert.equal(engine.dspJobsByOwner.size, 0);
    assert.equal(engine.dspRenderQueue.length, 0);
    assert.equal(engine.activeDspRenders, 0);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, success.orbitId);
    clearOrbitProcessedBuffers(engine, failure.orbitId);
  }
});

test("source invalidation is irreversible while a stale DSP job is still running", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "source-invalidation-orbit";
  const request = { orbitId, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let release!: () => void;
  engine.renderPlanetBuffer = async (_descriptor: unknown, shouldCancel: () => boolean) => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (shouldCancel()) throw new Error("Audio source changed before rendering.");
  };
  try {
    const stale = audioEngine.ensureProcessedBuffer(request, { ownerId: "stale-owner" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    engine.registerBuffer(orbitId, new FakeAudioBuffer(1, 64, 1000), 1);
    const staleJob = [...engine.dspJobs.values()][0];
    assert.equal(staleJob.sourceInvalidated, true);
    const nextController = new AbortController();
    const replacement = audioEngine.ensureProcessedBuffer(request, { ownerId: "new-owner", signal: nextController.signal });
    nextController.abort();
    await assert.rejects(replacement, { name: "AbortError" });
    assert.equal(staleJob.cancelRequested, true);
    release();
    await assert.rejects(stale, /Audio source changed before rendering/);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("preempt request leaves DSP consumers pending until an explicit later scheduler action", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "preempt-state-orbit";
  const request = { orbitId, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 64, 1000));
  const originalRender = engine.renderPlanetBuffer;
  let release!: () => void;
  engine.renderPlanetBuffer = async () => new Promise<void>((resolve) => { release = resolve; });
  try {
    const pending = audioEngine.ensureProcessedBuffer(request, { ownerId: "preempt-owner" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    const job = [...engine.dspJobs.values()][0];
    engine.markDspJobPreemptRequested(job);
    assert.equal(job.preemptRequested, true);
    assert.equal(job.cancelRequested, false);
    release();
    await pending;
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("DSP scheduler promotes one shared job, dispatches playback first, and demotes without duplicate queue entries", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const rendered: string[] = [];
  const background = { orbitId: "priority-background", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const selected = { orbitId: "priority-selected", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const playback = { orbitId: "priority-playback", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  for (const request of [background, selected, playback]) engine.buffers.set(request.orbitId, new FakeAudioBuffer(1, 64, 1000));
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }) => { rendered.push(descriptor.request.orbitId); };
  const playbackController = new AbortController();
  try {
    engine.activeDspRenders = 1;
    const backgroundPromise = audioEngine.ensureProcessedBuffer(background, { ownerId: "background-owner", priority: "background" });
    const selectedPromise = audioEngine.ensureProcessedBuffer(selected, { ownerId: "selected-owner", priority: "selected" });
    const promoted = audioEngine.ensureProcessedBuffer(background, { ownerId: "playback-owner", priority: "playback", signal: playbackController.signal });
    const queues = engine.dspRenderQueues;
    assert.deepEqual(queues.playback.map((job: { key: string }) => job.key), [engine.describeProcessedBuffer(background).key]);
    assert.equal(queues.background.length, 0);
    assert.equal(queues.playback.length + queues.selected.length + queues.background.length, 2);
    playbackController.abort();
    await assert.rejects(promoted, { name: "AbortError" });
    assert.deepEqual(queues.background.map((job: { key: string }) => job.key), [engine.describeProcessedBuffer(background).key]);
    engine.activeDspRenders = 0;
    engine.pumpDspRenderQueue();
    await Promise.all([backgroundPromise, selectedPromise]);
    assert.deepEqual(rendered, [selected.orbitId, background.orbitId]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    for (const request of [background, selected, playback]) clearOrbitProcessedBuffers(engine, request.orbitId);
  }
});

test("higher-priority work preempts a lower running render at its checkpoint and restarts it after playback", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const background = { orbitId: "preempt-background", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const playback = { orbitId: "preempt-playback", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(background.orbitId, new FakeAudioBuffer(1, 64, 1000));
  engine.buffers.set(playback.orbitId, new FakeAudioBuffer(1, 64, 1000));
  const rendered: string[] = [];
  let checkpoint!: () => void;
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }, _shouldCancel: () => boolean, shouldPreempt: () => boolean, onRenderedFrames: (frames: number) => void) => {
    rendered.push(descriptor.request.orbitId);
    if (descriptor.request.orbitId === background.orbitId && rendered.filter((id) => id === background.orbitId).length === 1) {
      await new Promise<void>((resolve) => { checkpoint = resolve; });
      onRenderedFrames(8192);
      if (shouldPreempt()) throw engine.preemptError();
    }
  };
  try {
    const backgroundPromise = audioEngine.ensureProcessedBuffer(background, { ownerId: "background-owner", priority: "background" });
    while (!checkpoint) await new Promise((resolve) => setTimeout(resolve, 0));
    const playbackPromise = audioEngine.ensureProcessedBuffer(playback, { ownerId: "playback-owner", priority: "playback" });
    assert.equal([...engine.dspJobs.values()].find((job: { key: string }) => job.key === engine.describeProcessedBuffer(background).key).preemptRequested, true);
    checkpoint();
    await Promise.all([backgroundPromise, playbackPromise]);
    assert.deepEqual(rendered, [background.orbitId, playback.orbitId, background.orbitId]);
    const metrics = audioEngine.getAudioCacheDiagnostics().dspScheduler;
    assert.ok(metrics.renderAttempts >= 3);
    assert.ok(metrics.restartedFrames >= 8192);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, background.orbitId, playback.orbitId);
  }
});

test("same-job playback boost does not preempt its own selected render", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const request = { orbitId: "same-job-boost", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(request.orbitId, new FakeAudioBuffer(1, 64, 1000));
  let checkpoint!: () => void;
  engine.renderPlanetBuffer = async (_descriptor: unknown, _shouldCancel: () => boolean, shouldPreempt: () => boolean) => {
    await new Promise<void>((resolve) => { checkpoint = resolve; });
    assert.equal(shouldPreempt(), false);
  };
  try {
    const selected = audioEngine.ensureProcessedBuffer(request, { ownerId: "selected-owner", priority: "selected" });
    while (!checkpoint) await new Promise((resolve) => setTimeout(resolve, 0));
    const playback = audioEngine.ensureProcessedBuffer(request, { ownerId: "playback-owner", priority: "playback" });
    const job = [...engine.dspJobs.values()][0];
    assert.equal(job.priority, "playback");
    assert.equal(job.preemptRequested, false);
    checkpoint();
    await Promise.all([selected, playback]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, request.orbitId);
  }
});

test("playback work preempts a selected render at its checkpoint", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const selected = { orbitId: "selected-preempt", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const playback = { orbitId: "selected-preempt-playback", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  engine.buffers.set(selected.orbitId, new FakeAudioBuffer(1, 64, 1000));
  engine.buffers.set(playback.orbitId, new FakeAudioBuffer(1, 64, 1000));
  let checkpoint!: () => void;
  const rendered: string[] = [];
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }, _shouldCancel: () => boolean, shouldPreempt: () => boolean) => {
    rendered.push(descriptor.request.orbitId);
    if (descriptor.request.orbitId === selected.orbitId && rendered.filter((id) => id === selected.orbitId).length === 1) {
      await new Promise<void>((resolve) => { checkpoint = resolve; });
      if (shouldPreempt()) throw engine.preemptError();
    }
  };
  try {
    const selectedPromise = audioEngine.ensureProcessedBuffer(selected, { ownerId: "selected-owner", priority: "selected" });
    while (!checkpoint) await new Promise((resolve) => setTimeout(resolve, 0));
    const playbackPromise = audioEngine.ensureProcessedBuffer(playback, { ownerId: "playback-owner", priority: "playback" });
    assert.equal([...engine.dspJobs.values()].find((job: { key: string }) => job.key === engine.describeProcessedBuffer(selected).key).preemptRequested, true);
    checkpoint();
    await Promise.all([selectedPromise, playbackPromise]);
    assert.deepEqual(rendered, [selected.orbitId, playback.orbitId, selected.orbitId]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    clearOrbitProcessedBuffers(engine, selected.orbitId, playback.orbitId);
  }
});

test("eight terminal higher-priority renders choose the oldest lower-priority job across queues", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const rendered: string[] = [];
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }) => { rendered.push(descriptor.request.orbitId); };
  const playback = Array.from({ length: 9 }, (_, index) => ({ orbitId: `fair-playback-${index}`, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const }));
  const background = { orbitId: "fair-background", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  const selected = { orbitId: "fair-selected", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  for (const request of [background, ...playback, selected]) engine.buffers.set(request.orbitId, new FakeAudioBuffer(1, 64, 1000));
  try {
    engine.activeDspRenders = 1;
    const promises = [audioEngine.ensureProcessedBuffer(background, { ownerId: "fair-background-owner", priority: "background" })];
    promises.push(...playback.map((request, index) => audioEngine.ensureProcessedBuffer(request, { ownerId: `fair-playback-owner-${index}`, priority: "playback" })));
    promises.push(audioEngine.ensureProcessedBuffer(selected, { ownerId: "fair-selected-owner", priority: "selected" }));
    engine.activeDspRenders = 0;
    engine.pumpDspRenderQueue();
    await Promise.all(promises);
    assert.deepEqual(rendered.slice(0, 10), [...playback.slice(0, 8).map((request) => request.orbitId), background.orbitId, playback[8].orbitId]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    for (const request of [background, ...playback, selected]) clearOrbitProcessedBuffers(engine, request.orbitId);
  }
});

test("a forced-low background dispatch remains preemptible while playback is queued", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const originalRender = engine.renderPlanetBuffer;
  const playback = Array.from({ length: 9 }, (_, index) => ({ orbitId: `forced-playback-${index}`, planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const }));
  const background = { orbitId: "forced-background", planetId: "p", speed: 1.2, pitchCents: 10, sampleStart: 0, sampleEnd: Infinity, direction: "forward" as const };
  for (const request of [background, ...playback]) engine.buffers.set(request.orbitId, new FakeAudioBuffer(1, 64, 1000));
  const rendered: string[] = [];
  let checkpoint!: () => void;
  engine.renderPlanetBuffer = async (descriptor: { request: { orbitId: string } }, _shouldCancel: () => boolean, shouldPreempt: () => boolean) => {
    rendered.push(descriptor.request.orbitId);
    if (descriptor.request.orbitId === background.orbitId && rendered.filter((id) => id === background.orbitId).length === 1) {
      await new Promise<void>((resolve) => { checkpoint = resolve; });
      assert.equal(shouldPreempt(), true);
      throw engine.preemptError();
    }
  };
  try {
    engine.activeDspRenders = 1;
    const promises = [audioEngine.ensureProcessedBuffer(background, { ownerId: "forced-background-owner", priority: "background" })];
    promises.push(...playback.map((request, index) => audioEngine.ensureProcessedBuffer(request, { ownerId: `forced-playback-owner-${index}`, priority: "playback" })));
    engine.activeDspRenders = 0;
    engine.pumpDspRenderQueue();
    while (!checkpoint) await new Promise((resolve) => setTimeout(resolve, 0));
    checkpoint();
    await Promise.all(promises);
    assert.deepEqual(rendered.slice(0, 11), [...playback.slice(0, 8).map((request) => request.orbitId), background.orbitId, playback[8].orbitId, background.orbitId]);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    for (const request of [background, ...playback]) clearOrbitProcessedBuffers(engine, request.orbitId);
  }
});

test("trim-window processing retains guarded physical PCM whose logical content matches the full render slice", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "trim-window-orbit";
  const planetId = "trim-window-planet";
  const source = new FakeAudioBuffer(2, 10_000, 1000);
  for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < source.length; frame++) {
    source.getChannelData(channel)[frame] = Math.sin((frame + channel * 13) / 17) * .4;
  }
  engine.buffers.set(orbitId, source);
  try {
    await ensureTestProcessed(orbitId, planetId, 1.25, 200);
    const fullKey = engine.processedBufferKey(orbitId, planetId, 1.25, 200);
    const full = engine.processedBuffers.get(fullKey)!;
    await ensureTestProcessed(orbitId, planetId, 1.25, 200, 2, 5);
    const key = engine.processedBufferKey(orbitId, planetId, 1.25, 200, 2, 5);
    const trimmed = engine.processedBuffers.get(key)!;
    const window = engine.processedWindows.get(key);
    assert.deepEqual(window, {
      sourceStartFrame: 2000, sourceEndFrame: 5000,
      contentStartFrame: 1600, contentEndFrame: 4000,
      bufferStartFrame: 1472, bufferEndFrame: 4128, fullOutputLength: 8000
    });
    assert.equal(trimmed.length, 2656);
    for (let channel = 0; channel < 2; channel++) {
      assert.deepEqual(
        Array.from(trimmed.getChannelData(channel).subarray(128, 2528)),
        Array.from(full.getChannelData(channel).subarray(1600, 4000))
      );
    }
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("locked 180-second stereo fixture reduces guarded processed residency by at least 90 percent", () => {
  const engine = privateAudioEngine();
  const orbitId = "trim-memory-fixture";
  const sampleRate = 44_100;
  engine.buffers.set(orbitId, new FakeAudioBuffer(2, 180 * sampleRate, sampleRate));
  try {
    const window = engine.processingWindow(orbitId, 1, 30, 45);
    const fullBytes = window.fullOutputLength * 2 * Float32Array.BYTES_PER_ELEMENT;
    const residentBytes = (window.bufferEndFrame - window.bufferStartFrame) * 2 * Float32Array.BYTES_PER_ELEMENT;
    assert.equal(window.bufferEndFrame - window.bufferStartFrame, 15 * sampleRate + 256);
    assert.ok(1 - residentBytes / fullBytes >= .9, `expected >=90% reduction, got ${(1 - residentBytes / fullBytes) * 100}%`);
  } finally {
    engine.buffers.delete(orbitId);
  }
});

test("residency owners protect their union until the final idempotent release", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "residency-union-orbit";
  const planetId = "residency-union-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  const request = {
    orbitId,
    planetId,
    speed: 1,
    pitchCents: 100,
    sampleStart: 0,
    sampleEnd: Infinity,
    direction: "forward" as const
  };
  try {
    await audioEngine.ensureProcessedBuffer(request, { ownerId: "residency-render" });
    const key = engine.processedBufferKey(orbitId, planetId, 1, 100);
    audioEngine.replacePermanentResidency("scene-a", [request]);
    const releaseProvisional = audioEngine.acquireResidency("scene-preflight", [request]);
    const releaseStaged = audioEngine.acquireResidency("staged-batch", [request]);

    for (let cents = 200; cents < 200 + PROCESSED_BUFFER_CACHE_CAP + 8; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.ok(engine.processedBuffers.has(key));

    audioEngine.replacePermanentResidency("scene-a", []);
    releaseProvisional();
    await ensureTestPitch(orbitId, planetId, 500);
    assert.ok(engine.processedBuffers.has(key));

    releaseStaged();
    releaseStaged();
    await ensureTestPitch(orbitId, planetId, 501);
    assert.equal(engine.processedBuffers.has(key), false);
  } finally {
    audioEngine.replacePermanentResidency("scene-a", []);
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("staged residency admitted before enqueue survives LRU pressure until publication releases it", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "staged-admission-orbit";
  const planetId = "staged-admission-planet";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  const target = {
    orbitId,
    planetId,
    speed: 1,
    pitchCents: 1,
    sampleStart: 0,
    sampleEnd: Infinity,
    direction: "forward" as const
  };
  const release = audioEngine.acquireResidency("staged-admission", [target]);
  try {
    await audioEngine.ensureProcessedBuffer(target, { ownerId: "staged-admission-render" });
    const targetKey = engine.processedBufferKey(orbitId, planetId, 1, 1);
    for (let cents = 1000; cents < 1000 + PROCESSED_BUFFER_CACHE_CAP + 8; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.ok(engine.processedBuffers.has(targetKey));

    release();
    await ensureTestPitch(orbitId, planetId, 2000);
    assert.equal(engine.processedBuffers.has(targetKey), false);
  } finally {
    release();
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("reverse scene prewarm installs exact reverse artifacts before the first playback edge", async () => {
  await audioEngine.resume();
  const engine = privateAudioEngine();
  const orbitId = "reverse-prewarm-orbit";
  const processedPlanetId = "reverse-prewarm-processed";
  const neutralPlanetId = "reverse-prewarm-neutral";
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 1000));
  engine.orbitRuntimes.set(orbitId, { input: new FakeNode(), panNode: { input: new FakeNode(), output: new FakeNode(), disconnect() {} }, gainNode: new FakeGain() });
  const originalRender = engine.renderPlanetBuffer;
  const originalCreateReverse = engine.createReversedBuffer;
  let renders = 0;
  let reverseCreates = 0;
  engine.renderPlanetBuffer = (...args: unknown[]) => {
    renders++;
    return originalRender.apply(engine, args);
  };
  engine.createReversedBuffer = (...args: unknown[]) => {
    reverseCreates++;
    return originalCreateReverse.apply(engine, args);
  };
  try {
    await audioEngine.ensureProcessedBuffer({
      orbitId, planetId: processedPlanetId, speed: 1.25, pitchCents: 100,
      sampleStart: .02, sampleEnd: .12, direction: "reverse"
    }, { ownerId: "reverse-prewarm-processed", priority: "playback" });
    const processedKey = engine.processedBufferKey(orbitId, processedPlanetId, 1.25, 100, .02, .12);
    assert.ok(engine.processedBuffers.has(processedKey));
    assert.ok(engine.reverseBuffers.has(`${processedKey}:reverse`));
    const processedReverseCreates = reverseCreates;
    audioEngine.syncLoop(orbitId, processedPlanetId, "processed-edge", true, .03, 1, 0, 1, 1.25, 100, true, .02, .12);
    assert.equal(reverseCreates, processedReverseCreates);

    await audioEngine.ensureProcessedBuffer({
      orbitId, planetId: neutralPlanetId, speed: 1, pitchCents: 0,
      sampleStart: .02, sampleEnd: .12, direction: "reverse"
    }, { ownerId: "reverse-prewarm-neutral", priority: "playback" });
    const neutralKey = engine.processedBufferKey(orbitId, neutralPlanetId, 1, 0);
    assert.ok(engine.reverseBuffers.has(`${neutralKey}:reverse`));
    assert.equal(engine.processedBuffers.has(neutralKey), false);
    assert.equal(renders, 1);
    const neutralReverseCreates = reverseCreates;
    audioEngine.triggerSequence(orbitId, neutralPlanetId, "neutral-edge", 1, 0, 1, 0, true, "overlap", .02, .12);
    assert.equal(reverseCreates, neutralReverseCreates);
  } finally {
    engine.renderPlanetBuffer = originalRender;
    engine.createReversedBuffer = originalCreateReverse;
    audioEngine.removeOrbit(orbitId);
  }
});

test("residency canonicalizes reverse hot requirements and rejects replaced source generations", () => {
  const engine = privateAudioEngine();
  const prototype = Object.getPrototypeOf(audioEngine);
  const registerBuffer = Reflect.get(prototype, "registerBuffer");
  const isResidencyKeyProtected = Reflect.get(prototype, "isResidencyKeyProtected");
  const orbitId = "residency-generation-orbit";
  const planetId = "residency-generation-planet";
  const sourceA = new FakeAudioBuffer(1, 256, 44100);
  const sourceB = new FakeAudioBuffer(1, 256, 44100);
  registerBuffer.call(audioEngine, orbitId, sourceA, 1);
  const processedReverse = {
    orbitId,
    planetId,
    speed: 1.25,
    pitchCents: 100,
    sampleStart: 1,
    sampleEnd: 2,
    direction: "reverse" as const
  };
  const neutralReverse = {
    orbitId,
    planetId: `${planetId}-neutral`,
    speed: 1,
    pitchCents: 0,
    sampleStart: 1,
    sampleEnd: 2,
    direction: "reverse" as const
  };
  try {
    audioEngine.replacePermanentResidency("scene-reverse", [processedReverse, neutralReverse]);
    const owners: Map<string, Map<string, unknown>> = Reflect.get(audioEngine, "permanentResidencies");
    const keys = [...owners.get("scene-reverse")!.keys()];
    const processedKey = engine.processedBufferKey(orbitId, planetId, 1.25, 100, 1, 2);
    const neutralKey = engine.processedBufferKey(orbitId, `${planetId}-neutral`, 1, 0);
    assert.deepEqual(keys.sort(), [processedKey, `${processedKey}:reverse`, `${neutralKey}:reverse`].sort());
    assert.equal(isResidencyKeyProtected.call(audioEngine, processedKey), true);

    registerBuffer.call(audioEngine, orbitId, sourceB, 1);
    assert.equal(isResidencyKeyProtected.call(audioEngine, processedKey), false);
    assert.equal(owners.get("scene-reverse")?.size, 0);
  } finally {
    audioEngine.replacePermanentResidency("scene-reverse", []);
    audioEngine.removeOrbit(orbitId);
  }
});

test("processed-buffer cache stays bounded to the LRU cap across many distinct speed/pitch tuples", async () => {
  await audioEngine.resume();
  const orbitId = "lru-cap-orbit";
  const planetId = "lru-cap-planet";
  const engine = privateAudioEngine();
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  try {
    for (let cents = 1; cents <= PROCESSED_BUFFER_CACHE_CAP + 12; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.ok(
      engine.processedBuffers.size <= PROCESSED_BUFFER_CACHE_CAP,
      `expected cache size <= ${PROCESSED_BUFFER_CACHE_CAP}, got ${engine.processedBuffers.size}`
    );
    const newestKey = engine.processedBufferKey(orbitId, planetId, 1, PROCESSED_BUFFER_CACHE_CAP + 12);
    assert.ok(engine.processedBuffers.has(newestKey), "most recently processed tuple must still be cached");
    const oldestKey = engine.processedBufferKey(orbitId, planetId, 1, 1);
    assert.equal(engine.processedBuffers.has(oldestKey), false, "least-recently-used tuple should have been evicted");
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("a buffer backing a currently active playback is never evicted, even as the LRU cap is exceeded", async () => {
  await audioEngine.resume();
  const orbitId = "lru-protect-orbit";
  const planetId = "lru-protect-planet";
  const engine = privateAudioEngine();
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  try {
    await ensureTestPitch(orbitId, planetId, 100);
    const protectedKey = engine.processedBufferKey(orbitId, planetId, 1, 100);
    const protectedBuffer = engine.processedBuffers.get(protectedKey);
    assert.ok(protectedBuffer, "setup: the protected tuple must be cached before the eviction sweep");

    // Simulate an in-flight (e.g. looping) playback whose source node still references this
    // buffer. It is the least-recently-used entry, so without the active-playback guard the
    // eviction sweep below would remove it first.
    engine.active.set("lru-protect-playback", { source: { buffer: protectedBuffer } });
    for (let cents = 200; cents < 200 + PROCESSED_BUFFER_CACHE_CAP + 20; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.ok(engine.processedBuffers.has(protectedKey), "active playback's buffer must survive LRU eviction");
    assert.ok(
      engine.processedBuffers.size <= PROCESSED_BUFFER_CACHE_CAP,
      "the cap is still respected for every non-protected entry"
    );
  } finally {
    engine.active.delete("lru-protect-playback");
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("re-requesting an evicted (speed,pitch) tuple transparently re-processes to identical output", async () => {
  await audioEngine.resume();
  const orbitId = "lru-reprocess-orbit";
  const planetId = "lru-reprocess-planet";
  const engine = privateAudioEngine();
  const source = new FakeAudioBuffer(2, 512, 44100);
  const left = source.getChannelData(0);
  const right = source.getChannelData(1);
  for (let index = 0; index < 512; index++) {
    left[index] = Math.sin(index / 9) * .4;
    right[index] = Math.cos(index / 13) * .4;
  }
  engine.buffers.set(orbitId, source);
  try {
    await ensureTestProcessed(orbitId, planetId, 1.25, 150);
    const key = engine.processedBufferKey(orbitId, planetId, 1.25, 150);
    const first = engine.processedBuffers.get(key);
    assert.ok(first, "setup: the target tuple must be cached before eviction");
    const firstLeft = Float32Array.from(first.getChannelData(0));
    const firstRight = Float32Array.from(first.getChannelData(1));

    // Evict the target tuple by requesting enough unrelated tuples to exceed the cap; it is
    // never re-touched in between, so it is the oldest (first-evicted) entry.
    for (let cents = 1000; cents < 1000 + PROCESSED_BUFFER_CACHE_CAP + 16; cents++) {
      await ensureTestPitch(orbitId, planetId, cents);
    }
    assert.equal(engine.processedBuffers.has(key), false, "setup: the target tuple must actually be evicted");
    assert.equal(audioEngine.hasProcessedBuffer(orbitId, planetId, 1.25, 150), false);

    await ensureTestProcessed(orbitId, planetId, 1.25, 150);
    const second = engine.processedBuffers.get(key);
    assert.ok(second, "recomputation after eviction must repopulate the cache");
    assert.notEqual(second, first, "recomputation produces a new buffer instance, not a stale reference");
    assert.deepEqual(Array.from(second.getChannelData(0)), Array.from(firstLeft), "recomputed left channel must match the pre-eviction output");
    assert.deepEqual(Array.from(second.getChannelData(1)), Array.from(firstRight), "recomputed right channel must match the pre-eviction output");
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("removeOrbit still prunes only its own processed-buffer cache entries once LRU touches have reordered the map", async () => {
  await audioEngine.resume();
  const orbitA = "lru-remove-orbit-a";
  const orbitB = "lru-remove-orbit-b";
  const planetId = "lru-remove-planet";
  const engine = privateAudioEngine();
  engine.buffers.set(orbitA, new FakeAudioBuffer(1, 128, 44100));
  engine.buffers.set(orbitB, new FakeAudioBuffer(1, 128, 44100));
  try {
    await ensureTestPitch(orbitA, planetId, 50);
    await ensureTestPitch(orbitB, planetId, 50);
    // Reading orbitA's entry refreshes its recency, moving it past orbitB's entry in the
    // underlying Map's iteration order. Prefix eviction must still key off the string
    // prefix, not the entry's position in the map.
    engine.getPlaybackBuffer(orbitA, planetId, 1, 50);

    const keyA = engine.processedBufferKey(orbitA, planetId, 1, 50);
    const keyB = engine.processedBufferKey(orbitB, planetId, 1, 50);
    assert.ok(engine.processedBuffers.has(keyA));
    assert.ok(engine.processedBuffers.has(keyB));

    audioEngine.removeOrbit(orbitA);

    assert.equal(engine.processedBuffers.has(keyA), false, "removed orbit's cache entry must be pruned");
    assert.ok(engine.processedBuffers.has(keyB), "an unrelated orbit's cache entry must survive");
  } finally {
    audioEngine.removeOrbit(orbitA);
    audioEngine.removeOrbit(orbitB);
  }
});

/**
 * Pin test for App.tsx's useSpeedPitchProcessing hook extraction (see hooks/useSpeedPitchProcessing.ts).
 * That hook only orchestrates React state and calls audioEngine.processPlanetBuffer; the actual
 * SoundTouch DSP transform lives here and is inseparable from AudioContext (it allocates output via
 * this.getContext().createBuffer). This test freezes the transform's exact numeric output against a
 * small fixed synthetic input so a later refactor of the orchestration layer cannot silently change
 * the DSP result it depends on.
 */
test("processPlanetBuffer pins exact output shape and sample values for a fixed synthetic input (speed+pitch)", async () => {
  await audioEngine.resume();
  const orbitId = "pin-speed-pitch-orbit";
  const planetId = "pin-speed-pitch-planet";
  const engine = privateAudioEngine();
  const source = new FakeAudioBuffer(2, 64, 8000);
  const left = source.getChannelData(0);
  const right = source.getChannelData(1);
  for (let index = 0; index < 64; index++) {
    left[index] = Math.sin(index / 4) * .5;
    right[index] = Math.cos(index / 6) * .5;
  }
  engine.buffers.set(orbitId, source);
  try {
    await ensureTestProcessed(orbitId, planetId, 1.5, 200);
    const key = engine.processedBufferKey(orbitId, planetId, 1.5, 200);
    const output = engine.processedBuffers.get(key);
    assert.ok(output, "setup: the fixed tuple must be cached after processing");
    assert.equal(output.numberOfChannels, 2);
    assert.equal(output.length, Math.ceil(64 / 1.5));
    const outLeft = Array.from(output.getChannelData(0) as Float32Array);
    const outRight = Array.from(output.getChannelData(1) as Float32Array);
    const roundedLeft = outLeft.map((value) => Math.round(value * 1e6) / 1e6);
    const roundedRight = outRight.map((value) => Math.round(value * 1e6) / 1e6);
    assert.deepEqual(roundedLeft.slice(0, 6), [0, .000158, .002196, .007072, .014021, .021929]);
    assert.deepEqual(roundedRight.slice(0, 6), [0, .000629, .006289, .011265, .015015, .01707]);
    assert.deepEqual(
      roundedLeft.slice(-6),
      [-.136467, -.180119, -.211683, -.227954, -.226472, -.205245]
    );
    assert.deepEqual(
      roundedRight.slice(-6),
      [.18727, .170846, .147205, .11685, .080476, .038942]
    );
    assert.equal(float32Hash(output), "af827d8237689d8b10831f0b3997af74c63a87403e756fe6e24dafaf7d69d6bc");
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});

test("processPlanetBuffer pins an independently hashed global-normalization render", async () => {
  await audioEngine.resume();
  const orbitId = "pin-normalized-orbit";
  const planetId = "pin-normalized-planet";
  const engine = privateAudioEngine();
  const source = new FakeAudioBuffer(2, 64, 8000);
  source.getChannelData(0).fill(1.2);
  source.getChannelData(1).fill(-1.2);
  engine.buffers.set(orbitId, source);
  try {
    await ensureTestProcessed(orbitId, planetId, 1, 200);
    const output = engine.processedBuffers.get(engine.processedBufferKey(orbitId, planetId, 1, 200));
    assert.ok(output);
    assert.ok(Math.max(...output.getChannelData(0).map(Math.abs), ...output.getChannelData(1).map(Math.abs)) <= .98);
    assert.equal(float32Hash(output), "b14448e31bbd5bb66600bd4e71d6d9858ef16d3e41da580fe4bd566c407bf348");
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});
