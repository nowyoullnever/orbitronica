import assert from "node:assert/strict";
import test from "node:test";
import { calculateWavLayout, encodeWav } from "../src/renderer/audio/wavEncoder.ts";

const text = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));

test("PCM16 emits a canonical interleaved stereo RIFF layout", () => {
  const wav = encodeWav([new Float32Array([-1, 0]), new Float32Array([1, .5])], 48_000, "pcm16");
  const view = new DataView(wav.buffer);
  assert.equal(text(wav, 0), "RIFF"); assert.equal(text(wav, 8), "WAVE");
  assert.equal(text(wav, 12), "fmt "); assert.equal(text(wav, 36), "data");
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000); assert.equal(view.getUint32(28, true), 192_000);
  assert.equal(view.getUint16(32, true), 4); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([...new Int16Array(wav.buffer.slice(44))], [-32768, 32767, 0, 16384]);
});

test("PCM24 clamps with asymmetric full scale and adds an excluded data pad byte", () => {
  const wav = encodeWav([new Float32Array([-1, 0, 1])], 44_100, "pcm24");
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(34, true), 24);
  assert.equal(view.getUint32(40, true), 9); assert.equal(wav.length, 54);
  assert.deepEqual([...wav.slice(44, 53)], [0, 0, 128, 0, 0, 0, 255, 255, 127]);
  assert.equal(wav[53], 0);
});

test("Float32 exports a fact frame count and preserves finite Float32 sample bits", () => {
  const samples = new Float32Array([1.25, -0, Number.NaN, Infinity]);
  const wav = encodeWav([samples], 44_100, "float32");
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 3); assert.equal(text(wav, 36), "fact");
  assert.equal(view.getUint32(40, true), 4); assert.equal(view.getUint32(44, true), 4);
  assert.equal(text(wav, 48), "data");
  assert.equal(view.getFloat32(56, true), 1.25); assert.ok(Object.is(view.getFloat32(60, true), -0));
  assert.equal(view.getFloat32(64, true), 0); assert.equal(view.getFloat32(68, true), 0);
});

test("invalid input and oversized layouts are rejected before allocation", () => {
  assert.throws(() => encodeWav([], 44_100, "pcm16"), /at least one/);
  assert.throws(() => encodeWav([new Float32Array(1), new Float32Array(2)], 44_100, "pcm16"), /same frame count/);
  assert.throws(() => encodeWav([new Float32Array(1)], 44_100.5, "pcm16"), /sampleRate/);
  assert.throws(() => calculateWavLayout(2, 2 ** 32, 44_100, "pcm16"), /data size/);
});
