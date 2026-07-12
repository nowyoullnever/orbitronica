export type WavSampleFormat = "pcm16" | "pcm24" | "float32";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

export type WavLayout = {
  formatCode: 1 | 3;
  bitsPerSample: 16 | 24 | 32;
  bytesPerSample: 2 | 3 | 4;
  blockAlign: number;
  byteRate: number;
  dataSize: number;
  dataPadding: 0 | 1;
  factChunkSize: 0 | 12;
  riffSize: number;
  fileSize: number;
};

function assertInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}.`);
  }
}

function sampleDetails(sampleFormat: WavSampleFormat) {
  switch (sampleFormat) {
    case "pcm16": return { formatCode: 1 as const, bitsPerSample: 16 as const, bytesPerSample: 2 as const };
    case "pcm24": return { formatCode: 1 as const, bitsPerSample: 24 as const, bytesPerSample: 3 as const };
    case "float32": return { formatCode: 3 as const, bitsPerSample: 32 as const, bytesPerSample: 4 as const };
    default: throw new TypeError(`Unsupported WAV sample format: ${String(sampleFormat)}.`);
  }
}

/** Calculates all RIFF fields before allocating output, including format-specific chunks. */
export function calculateWavLayout(
  channelCount: number,
  frameCount: number,
  sampleRate: number,
  sampleFormat: WavSampleFormat
): WavLayout {
  assertInteger(channelCount, "channelCount", UINT16_MAX);
  if (channelCount === 0) throw new RangeError("WAV requires at least one channel.");
  assertInteger(frameCount, "frameCount");
  assertInteger(sampleRate, "sampleRate", UINT32_MAX);
  if (sampleRate === 0) throw new RangeError("sampleRate must be greater than zero.");

  const details = sampleDetails(sampleFormat);
  const blockAlign = channelCount * details.bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  if (!Number.isSafeInteger(blockAlign) || blockAlign > UINT16_MAX) throw new RangeError("WAV block alignment exceeds uint16.");
  if (!Number.isSafeInteger(byteRate) || byteRate > UINT32_MAX) throw new RangeError("WAV byte rate exceeds uint32.");
  if (!Number.isSafeInteger(dataSize) || dataSize > UINT32_MAX) throw new RangeError("WAV data size exceeds uint32.");

  const dataPadding = (dataSize % 2) as 0 | 1;
  const factChunkSize = (sampleFormat === "float32" ? 12 : 0) as 0 | 12;
  const riffSize = 4 + 24 + factChunkSize + 8 + dataSize + dataPadding;
  if (!Number.isSafeInteger(riffSize) || riffSize > UINT32_MAX) throw new RangeError("WAV RIFF size exceeds uint32.");
  return { ...details, blockAlign, byteRate, dataSize, dataPadding, factChunkSize, riffSize, fileSize: riffSize + 8 };
}

function writeTag(output: Uint8Array, offset: number, tag: string) {
  for (let index = 0; index < tag.length; index++) output[offset + index] = tag.charCodeAt(index);
}

function pcm16(sample: number) {
  if (!Number.isFinite(sample)) return 0;
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

function pcm24(sample: number) {
  if (!Number.isFinite(sample)) return 0;
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);
}

/** Encodes interleaved RIFF/WAVE data from equally sized, per-channel Float32 samples. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, sampleFormat: WavSampleFormat): Uint8Array {
  if (channels.length === 0) throw new RangeError("WAV requires at least one channel.");
  const frameCount = channels[0]?.length;
  if (frameCount === undefined || !channels.every((channel) => channel.length === frameCount)) {
    throw new RangeError("All WAV channels must have the same frame count.");
  }
  const layout = calculateWavLayout(channels.length, frameCount, sampleRate, sampleFormat);
  const output = new Uint8Array(layout.fileSize);
  const view = new DataView(output.buffer);
  writeTag(output, 0, "RIFF");
  view.setUint32(4, layout.riffSize, true);
  writeTag(output, 8, "WAVE");
  writeTag(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, layout.formatCode, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, layout.byteRate, true);
  view.setUint16(32, layout.blockAlign, true);
  view.setUint16(34, layout.bitsPerSample, true);

  let offset = 36;
  if (layout.factChunkSize) {
    writeTag(output, offset, "fact");
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, frameCount, true);
    offset += layout.factChunkSize;
  }
  writeTag(output, offset, "data");
  view.setUint32(offset + 4, layout.dataSize, true);
  offset += 8;

  for (let frame = 0; frame < frameCount; frame++) {
    for (const channel of channels) {
      const sample = channel[frame];
      if (sampleFormat === "pcm16") {
        view.setInt16(offset, pcm16(sample), true);
        offset += 2;
      } else if (sampleFormat === "pcm24") {
        const value = pcm24(sample) >>> 0;
        output[offset++] = value & 0xff;
        output[offset++] = (value >>> 8) & 0xff;
        output[offset++] = (value >>> 16) & 0xff;
      } else {
        view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true);
        offset += 4;
      }
    }
  }
  return output;
}
