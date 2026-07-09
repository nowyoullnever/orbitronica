declare module "soundtouchjs" {
  export class SoundTouch {
    pitch: number;
    tempo: number;
    stretch: {
      setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
    };
  }

  export class WebAudioBufferSource {
    constructor(buffer: AudioBuffer);
  }

  export class SimpleFilter {
    constructor(source: WebAudioBufferSource, pipe: SoundTouch);
    extract(target: Float32Array, numFrames?: number): number;
  }
}
