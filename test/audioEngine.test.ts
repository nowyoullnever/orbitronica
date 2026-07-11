import assert from "node:assert/strict";
import test from "node:test";

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
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
  createAnalyser() { return new FakeAnalyser(); }
  async decodeAudioData() { return { length: 0, numberOfChannels: 0 }; }
  async resume() { this.state = "running"; }
}

Object.assign(globalThis, { AudioContext: FakeAudioContext });
const { audioEngine } = await import("../src/renderer/audio/audioEngine.ts");

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
