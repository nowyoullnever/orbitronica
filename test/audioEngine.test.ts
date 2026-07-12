import assert from "node:assert/strict";
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

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakePanner extends FakeNode { pan = new FakeParam(); }
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(0); }
}

let contextCount = 0;
let masterGain: FakeGain | undefined;
let masterPanner: FakePanner | undefined;

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
  async decodeAudioData(raw: ArrayBuffer) {
    if (new Uint8Array(raw)[0] === 255) throw new Error("bad audio");
    return { length: 0, numberOfChannels: 0 };
  }
  async resume() { this.state = "running"; }
}

Object.assign(globalThis, { AudioContext: FakeAudioContext });
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
