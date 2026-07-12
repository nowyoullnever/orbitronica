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

test("recording path is lazy AudioWorklet PCM capture with acknowledged session protocol", () => {
  const source = fs.readFileSync(new URL("../src/renderer/audio/audioEngine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /MediaRecorder|createMediaStreamDestination/);
  for (const token of ["AudioWorkletNode", "recordingId", "started", "stopped", "processorerror", "2048", "URL.revokeObjectURL"]) {
    assert.ok(source.includes(token), `missing recording protocol token: ${token}`);
  }
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
