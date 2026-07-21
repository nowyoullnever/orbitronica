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

// A minimal in-memory AudioBuffer stand-in: real Float32Array channel storage so the
// actual SoundTouch pipeline in processPlanetBuffer can run against it deterministically.
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
  const engine = audioEngine as any;
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
  const engine = audioEngine as any;
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
  const engine = audioEngine as any;
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
  const engine = audioEngine as any;
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
  const engine = audioEngine as any;
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
  const engine = audioEngine as any;
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
  for (const orbitId of orbitIds) engine.buffers.delete(orbitId);
}

function float32Hash(buffer: FakeAudioBuffer | AudioBuffer) {
  const hash = createHash("sha256");
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    hash.update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }
  return hash.digest("hex");
}

test("audio memory statistics distinguish referenced, unique, and active-only logical residency", () => {
  const engine = audioEngine as any;
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

test("current playback coordinate parameters are pinned for forward and reverse loop/sequence playback", async () => {
  await audioEngine.resume();
  const engine = audioEngine as any;
  const orbitId = "coordinate-baseline-orbit";
  const planetId = "coordinate-baseline-planet";
  const buffer = new FakeAudioBuffer(1, 10000, 1000);
  engine.buffers.set(orbitId, buffer);
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

test("processed-buffer cache stays bounded to the LRU cap across many distinct speed/pitch tuples", async () => {
  await audioEngine.resume();
  const orbitId = "lru-cap-orbit";
  const planetId = "lru-cap-planet";
  const engine = audioEngine as any;
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  try {
    for (let cents = 1; cents <= PROCESSED_BUFFER_CACHE_CAP + 12; cents++) {
      await audioEngine.processPitchBuffer(orbitId, planetId, cents);
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
  const engine = audioEngine as any;
  engine.buffers.set(orbitId, new FakeAudioBuffer(1, 256, 44100));
  try {
    await audioEngine.processPitchBuffer(orbitId, planetId, 100);
    const protectedKey = engine.processedBufferKey(orbitId, planetId, 1, 100);
    const protectedBuffer = engine.processedBuffers.get(protectedKey);
    assert.ok(protectedBuffer, "setup: the protected tuple must be cached before the eviction sweep");

    // Simulate an in-flight (e.g. looping) playback whose source node still references this
    // buffer. It is the least-recently-used entry, so without the active-playback guard the
    // eviction sweep below would remove it first.
    engine.active.set("lru-protect-playback", { source: { buffer: protectedBuffer } });
    for (let cents = 200; cents < 200 + PROCESSED_BUFFER_CACHE_CAP + 20; cents++) {
      await audioEngine.processPitchBuffer(orbitId, planetId, cents);
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
  const engine = audioEngine as any;
  const source = new FakeAudioBuffer(2, 512, 44100);
  const left = source.getChannelData(0);
  const right = source.getChannelData(1);
  for (let index = 0; index < 512; index++) {
    left[index] = Math.sin(index / 9) * .4;
    right[index] = Math.cos(index / 13) * .4;
  }
  engine.buffers.set(orbitId, source);
  try {
    await audioEngine.processPlanetBuffer(orbitId, planetId, 1.25, 150);
    const key = engine.processedBufferKey(orbitId, planetId, 1.25, 150);
    const first = engine.processedBuffers.get(key);
    assert.ok(first, "setup: the target tuple must be cached before eviction");
    const firstLeft = Float32Array.from(first.getChannelData(0));
    const firstRight = Float32Array.from(first.getChannelData(1));

    // Evict the target tuple by requesting enough unrelated tuples to exceed the cap; it is
    // never re-touched in between, so it is the oldest (first-evicted) entry.
    for (let cents = 1000; cents < 1000 + PROCESSED_BUFFER_CACHE_CAP + 16; cents++) {
      await audioEngine.processPitchBuffer(orbitId, planetId, cents);
    }
    assert.equal(engine.processedBuffers.has(key), false, "setup: the target tuple must actually be evicted");
    assert.equal(audioEngine.hasProcessedBuffer(orbitId, planetId, 1.25, 150), false);

    await audioEngine.processPlanetBuffer(orbitId, planetId, 1.25, 150);
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
  const engine = audioEngine as any;
  engine.buffers.set(orbitA, new FakeAudioBuffer(1, 128, 44100));
  engine.buffers.set(orbitB, new FakeAudioBuffer(1, 128, 44100));
  try {
    await audioEngine.processPitchBuffer(orbitA, planetId, 50);
    await audioEngine.processPitchBuffer(orbitB, planetId, 50);
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
  const engine = audioEngine as any;
  const source = new FakeAudioBuffer(2, 64, 8000);
  const left = source.getChannelData(0);
  const right = source.getChannelData(1);
  for (let index = 0; index < 64; index++) {
    left[index] = Math.sin(index / 4) * .5;
    right[index] = Math.cos(index / 6) * .5;
  }
  engine.buffers.set(orbitId, source);
  try {
    await audioEngine.processPlanetBuffer(orbitId, planetId, 1.5, 200);
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
  const engine = audioEngine as any;
  const source = new FakeAudioBuffer(2, 64, 8000);
  source.getChannelData(0).fill(1.2);
  source.getChannelData(1).fill(-1.2);
  engine.buffers.set(orbitId, source);
  try {
    await audioEngine.processPlanetBuffer(orbitId, planetId, 1, 200);
    const output = engine.processedBuffers.get(engine.processedBufferKey(orbitId, planetId, 1, 200));
    assert.ok(output);
    assert.ok(Math.max(...output.getChannelData(0).map(Math.abs), ...output.getChannelData(1).map(Math.abs)) <= .98);
    assert.equal(float32Hash(output), "b14448e31bbd5bb66600bd4e71d6d9858ef16d3e41da580fe4bd566c407bf348");
  } finally {
    clearOrbitProcessedBuffers(engine, orbitId);
  }
});
