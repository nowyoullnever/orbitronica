import { SimpleFilter, SoundTouch, WebAudioBufferSource } from "soundtouchjs";
import type { SequenceRetriggerMode } from "../state/types";

type ActivePlayback = {
  id: string;
  orbitId: string;
  planetId: string;
  barId: string;
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  mode: "loop" | "sequence";
  isReverse: boolean;
  loopWindowStart?: number;
  loopWindowEnd?: number;
};

type WaveformListener = (orbitId: string, peaks: Float32Array | null) => void;

class AudioEngine {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private waveformPeaks = new Map<string, Float32Array>();
  private waveformPeakPromises = new WeakMap<AudioBuffer, Promise<Float32Array>>();
  private waveformListeners = new Set<WaveformListener>();
  private readonly waveformResolution = 1024;
  private processedBuffers = new Map<string, AudioBuffer>();
  private reverseBuffers = new Map<string, AudioBuffer>();
  private rawFiles = new Map<string, { fileName: string; bytes: Uint8Array }>();
  private orbitGains = new Map<string, GainNode>();
  private active = new Map<string, ActivePlayback>();
  private masterGain: GainNode | null = null;
  private masterPanner: StereoPannerNode | null = null;
  private meterSplitter: ChannelSplitterNode | null = null;
  private meterAnalyserL: AnalyserNode | null = null;
  private meterAnalyserR: AnalyserNode | null = null;
  private meterBufferL: Float32Array | null = null;
  private meterBufferR: Float32Array | null = null;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];

  private getContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.masterGain = this.context.createGain();
      this.masterPanner = this.context.createStereoPanner();
      // Final chain: orbit gains -> master volume -> master pan -> output.
      this.masterGain.connect(this.masterPanner);
      this.masterPanner.connect(this.context.destination);
      this.recordingDestination = this.context.createMediaStreamDestination();
      this.masterPanner.connect(this.recordingDestination);
      // Metering tap: split the final stereo signal so L/R are measured separately.
      // Analysers are read-only taps, so their outputs stay unconnected.
      this.meterSplitter = this.context.createChannelSplitter(2);
      this.meterAnalyserL = this.context.createAnalyser();
      this.meterAnalyserR = this.context.createAnalyser();
      this.meterAnalyserL.fftSize = 1024;
      this.meterAnalyserR.fftSize = 1024;
      this.masterPanner.connect(this.meterSplitter);
      this.meterSplitter.connect(this.meterAnalyserL, 0);
      this.meterSplitter.connect(this.meterAnalyserR, 1);
      this.meterBufferL = new Float32Array(this.meterAnalyserL.fftSize);
      this.meterBufferR = new Float32Array(this.meterAnalyserR.fftSize);
    }
    return this.context;
  }

  setMasterVolume(volume: number) {
    const context = this.getContext();
    this.masterGain!.gain.setValueAtTime(Math.max(0, volume), context.currentTime);
  }

  setMasterPan(pan: number) {
    const context = this.getContext();
    this.masterPanner!.pan.setValueAtTime(Math.min(1, Math.max(-1, pan)), context.currentTime);
  }

  private channelPeak(analyser: AnalyserNode | null, buffer: Float32Array | null) {
    if (!analyser || !buffer) return 0;
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (let index = 0; index < buffer.length; index++) {
      const value = Math.abs(buffer[index]);
      if (value > peak) peak = value;
    }
    return peak;
  }

  // Raw per-channel peak amplitudes of the final output. Values are NOT clamped:
  // a peak above 1 means the signal crossed 0 dBFS, which the meter shows as a clip.
  getMasterLevels() {
    return {
      left: this.channelPeak(this.meterAnalyserL, this.meterBufferL),
      right: this.channelPeak(this.meterAnalyserR, this.meterBufferR)
    };
  }

  async resume() {
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
  }

  async decodeFile(orbitId: string, file: File, volume = 1) {
    const context = this.getContext();
    const raw = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(raw.slice(0));
    this.rawFiles.set(orbitId, { fileName: file.name, bytes: new Uint8Array(raw) });
    this.registerBuffer(orbitId, buffer, volume);
    return buffer;
  }

  async decodeBytes(orbitId: string, fileName: string, bytes: Uint8Array, volume = 1) {
    const copy = new Uint8Array(bytes);
    const buffer = await this.getContext().decodeAudioData(copy.buffer.slice(0));
    this.rawFiles.set(orbitId, { fileName, bytes: copy });
    this.registerBuffer(orbitId, buffer, volume);
    return buffer;
  }

  private registerBuffer(orbitId: string, buffer: AudioBuffer, volume: number) {
    const context = this.getContext();
    this.buffers.set(orbitId, buffer);
    this.waveformPeaks.delete(orbitId);
    this.publishWaveformPeaks(orbitId, null);
    void this.cacheWaveformPeaks(orbitId, buffer);
    const gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(this.masterGain!);
    this.orbitGains.set(orbitId, gain);
  }

  duplicateOrbitAudio(sourceOrbitId: string, newOrbitId: string, volume = 1) {
    const buffer = this.buffers.get(sourceOrbitId);
    const raw = this.rawFiles.get(sourceOrbitId);
    if (!buffer) return false;
    this.registerBuffer(newOrbitId, buffer, volume);
    if (raw) this.rawFiles.set(newOrbitId, raw);
    return true;
  }

  getProjectAsset(orbitId: string) {
    return this.rawFiles.get(orbitId);
  }

  subscribeWaveformPeaks(listener: WaveformListener) {
    this.waveformListeners.add(listener);
    for (const [orbitId, peaks] of this.waveformPeaks) listener(orbitId, peaks);
    return () => { this.waveformListeners.delete(listener); };
  }

  private publishWaveformPeaks(orbitId: string, peaks: Float32Array | null) {
    for (const listener of this.waveformListeners) listener(orbitId, peaks);
  }

  private async cacheWaveformPeaks(orbitId: string, buffer: AudioBuffer) {
    let peakPromise = this.waveformPeakPromises.get(buffer);
    if (!peakPromise) {
      peakPromise = this.computeWaveformPeaks(buffer);
      this.waveformPeakPromises.set(buffer, peakPromise);
    }
    try {
      const peaks = await peakPromise;
      if (this.buffers.get(orbitId) !== buffer) return;
      this.waveformPeaks.set(orbitId, peaks);
      this.publishWaveformPeaks(orbitId, peaks);
    } catch {
      // A failed visualization must never affect audio playback.
    }
  }

  // Normalized per-bin peak amplitudes (0..1). Work is yielded in small chunks so
  // loading a long sample cannot monopolize the renderer that schedules playback.
  private async computeWaveformPeaks(buffer: AudioBuffer): Promise<Float32Array> {
    const resolution = this.waveformResolution;
    const peaks = new Float32Array(resolution);
    const length = buffer.length;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
    let max = 0;
    for (let bin = 0; bin < resolution; bin++) {
      const start = Math.floor((bin / resolution) * length);
      const end = Math.max(start + 1, Math.floor(((bin + 1) / resolution) * length));
      let peak = 0;
      for (const data of channels) {
        for (let index = start; index < end && index < length; index++) {
          const value = Math.abs(data[index]);
          if (value > peak) peak = value;
        }
      }
      peaks[bin] = peak;
      if (peak > max) max = peak;
      if ((bin + 1) % 16 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (max > 0) for (let index = 0; index < resolution; index++) peaks[index] /= max;
    return peaks;
  }

  setVolume(orbitId: string, volume: number) {
    const gain = this.orbitGains.get(orbitId);
    if (gain) gain.gain.setValueAtTime(volume, this.getContext().currentTime);
  }

  private normalizedSpeed(speed: number) {
    return Number.isFinite(speed) && speed > 0 ? Math.max(.05, speed) : 1;
  }

  private hasUserSpeedChange(speed: number) {
    return Math.abs(this.normalizedSpeed(speed) - 1) > .0001;
  }

  private processedBufferKey(orbitId: string, planetId: string, speed: number, pitchCents: number) {
    return `${orbitId}:${planetId}:speed=${this.normalizedSpeed(speed).toFixed(4)}:pitch=${Math.round(pitchCents)}`;
  }

  private getPlaybackBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number) {
    const original = this.buffers.get(orbitId);
    if (!original) return null;
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) {
      return {
        buffer: original,
        key: this.processedBufferKey(orbitId, planetId, 1, 0),
        usingProcessedBuffer: false
      };
    }
    const key = this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch);
    const processed = this.processedBuffers.get(key);
    return {
      buffer: processed ?? original,
      key: processed ? key : this.processedBufferKey(orbitId, planetId, 1, 0),
      usingProcessedBuffer: Boolean(processed)
    };
  }

  private createPlayback(
    id: string, orbitId: string, planetId: string, barId: string,
    mode: "loop" | "sequence", planetVolume: number, tapeRate = 1,
    userSpeed = 1, pitchCents = 0, reverse = false
  ) {
    const context = this.getContext();
    const resolved = this.getPlaybackBuffer(orbitId, planetId, userSpeed, pitchCents);
    const orbitGain = this.orbitGains.get(orbitId);
    if (!resolved || !orbitGain) return null;
    let playbackBuffer = resolved.buffer;
    if (reverse) {
      const reverseKey = `${resolved.key}:reverse`;
      playbackBuffer = this.reverseBuffers.get(reverseKey) ?? this.createReversedBuffer(reverseKey, resolved.buffer);
    }
    const source = context.createBufferSource();
    const planetGain = context.createGain();
    source.buffer = playbackBuffer;
    // User speed is rendered into the processed buffer to preserve pitch.
    // playbackRate is intentionally limited to immediate tape-style runtime effects.
    source.playbackRate.value = tapeRate;
    planetGain.gain.value = planetVolume;
    source.connect(planetGain);
    planetGain.connect(orbitGain);
    const playback: ActivePlayback = {
      id, orbitId, planetId, barId, source, gainNode: planetGain, mode, isReverse: reverse
    };
    this.active.set(id, playback);
    source.onended = () => {
      if (this.active.get(id)?.source === source) this.active.delete(id);
      try { planetGain.disconnect(); } catch { /* disconnected */ }
    };
    return {
      playback,
      buffer: playbackBuffer,
      context,
      usingProcessedBuffer: resolved.usingProcessedBuffer
    };
  }

  private createReversedBuffer(key: string, source: AudioBuffer) {
    const reversed = this.getContext().createBuffer(
      source.numberOfChannels, source.length, source.sampleRate
    );
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const input = source.getChannelData(channel);
      const output = reversed.getChannelData(channel);
      for (let index = 0; index < input.length; index++) output[index] = input[input.length - 1 - index];
    }
    this.reverseBuffers.set(key, reversed);
    return reversed;
  }

  syncLoop(
    orbitId: string, planetId: string, barId: string, inside: boolean,
    audioTime: number, planetVolume: number, tapeRate: number, userSpeed: number, pitchCents: number,
    reverse = false, sampleStart = 0, sampleEnd = Infinity
  ) {
    const key = `loop:${planetId}:${barId}`;
    const current = this.active.get(key);
    const speedDivisor = this.hasUserSpeedChange(userSpeed) ? this.normalizedSpeed(userSpeed) : 1;
    if (!inside) {
      if (current) this.stopPlayback(key);
      return;
    }
    if (current) {
      const bufferDuration = current.source.buffer?.duration ?? 0;
      const windowStart = Math.min(Math.max(sampleStart / speedDivisor, 0), bufferDuration);
      const windowEnd = Math.min(Math.max(sampleEnd / speedDivisor, windowStart), bufferDuration);
      const loopStart = reverse ? bufferDuration - windowEnd : windowStart;
      const loopEnd = reverse ? bufferDuration - windowStart : windowEnd;
      // Restart when the window (or direction) changes so playback reseeks to the sample
      // position the planet now maps to. Mutating loopStart/loopEnd in place would keep
      // playing continuously without reflecting the new trim, so a restart is intended.
      if (current.isReverse !== reverse || current.loopWindowStart !== loopStart || current.loopWindowEnd !== loopEnd) {
        this.stopPlayback(key);
      } else {
        current.gainNode.gain.setValueAtTime(planetVolume, this.getContext().currentTime);
        current.source.playbackRate.setValueAtTime(tapeRate, this.getContext().currentTime);
        return;
      }
    }
    const created = this.createPlayback(
      key, orbitId, planetId, barId, "loop", planetVolume, tapeRate, userSpeed, pitchCents, reverse
    );
    if (!created) return;
    // Match commit 3e8ee22 exactly when the user speed is unchanged:
    // the loop bar maps directly to the original audio timeline.
    const processedOffset = audioTime / speedDivisor;
    const mappedTime = reverse ? created.buffer.duration - processedOffset : processedOffset;
    const safeOffset = Math.min(Math.max(mappedTime, 0), Math.max(0, created.buffer.duration - .001));
    // Bound playback to the trimmed window so only that slice repeats instead of the
    // audio running past sampleEnd into the rest of the sample. As the planet wraps
    // past angle 0, the native loop wraps sampleEnd -> sampleStart in step.
    const bufferDuration = created.buffer.duration;
    const windowStart = Math.min(Math.max(sampleStart / speedDivisor, 0), bufferDuration);
    const windowEnd = Math.min(Math.max(sampleEnd / speedDivisor, windowStart), bufferDuration);
    const loopStart = reverse ? bufferDuration - windowEnd : windowStart;
    const loopEnd = reverse ? bufferDuration - windowStart : windowEnd;
    if (loopEnd - loopStart > .001) {
      created.playback.source.loop = true;
      created.playback.source.loopStart = loopStart;
      created.playback.source.loopEnd = loopEnd;
      created.playback.loopWindowStart = loopStart;
      created.playback.loopWindowEnd = loopEnd;
    }
    created.playback.source.start(created.context.currentTime, safeOffset);
    console.debug({
      orbitId, planetId, barId, pitchCents,
      usingProcessedBuffer: created.usingProcessedBuffer,
      activePlaybackCount: this.active.size
    });
  }

  triggerSequence(
    orbitId: string, planetId: string, barId: string, planetVolume: number,
    tapeRate: number, pitchCents: number, reverse: boolean,
    retriggerMode: SequenceRetriggerMode, sampleStart = 0, sampleEnd = Infinity
  ) {
    if (retriggerMode === "ignore-until-end" && this.hasActiveSequencePlayback(orbitId)) return;
    if (retriggerMode === "cut-previous") this.stopActiveSequencePlaybacksForOrbit(orbitId);
    const id = `sequence:${planetId}:${barId}:${crypto.randomUUID()}`;
    const created = this.createPlayback(
      id, orbitId, planetId, barId, "sequence", planetVolume, tapeRate, 1, pitchCents, reverse
    );
    if (created) {
      // Play only the trimmed window. Pitch shifting preserves length, so the
      // sample-time bounds map straight onto the (possibly reversed) buffer.
      const bufferDuration = created.buffer.duration;
      const start = Math.min(Math.max(sampleStart, 0), bufferDuration);
      const end = Math.min(Math.max(sampleEnd, start), bufferDuration);
      const duration = Math.max(0.001, end - start);
      const offset = reverse ? Math.max(0, bufferDuration - end) : start;
      created.playback.source.start(created.context.currentTime, offset, duration);
      console.debug({
        orbitId, planetId, barId, pitchCents,
        usingProcessedBuffer: created.usingProcessedBuffer,
        activePlaybackCount: this.active.size
      });
    }
  }

  private stopPlayback(id: string) {
    const playback = this.active.get(id);
    if (!playback) return;
    this.active.delete(id);
    try { playback.source.stop(); } catch { /* already stopped */ }
    try { playback.gainNode.disconnect(); } catch { /* disconnected */ }
  }

  stopAllActivePlaybacks() {
    for (const id of [...this.active.keys()]) this.stopPlayback(id);
  }

  stopAllActivePlaybacksForOrbit(orbitId: string) {
    for (const [id, playback] of [...this.active]) if (playback.orbitId === orbitId) this.stopPlayback(id);
  }

  stopAllActivePlaybacksForPlanet(planetId: string) {
    for (const [id, playback] of [...this.active]) if (playback.planetId === planetId) this.stopPlayback(id);
  }

  stopAllActivePlaybacksForBar(barId: string) {
    for (const [id, playback] of [...this.active]) if (playback.barId === barId) this.stopPlayback(id);
  }

  stopActiveSequencePlaybacksForOrbit(orbitId: string) {
    for (const [id, playback] of [...this.active]) {
      if (playback.orbitId === orbitId && playback.mode === "sequence") this.stopPlayback(id);
    }
  }

  stopActiveLoopPlaybacksForOrbit(orbitId: string) {
    for (const [id, playback] of [...this.active]) {
      if (playback.orbitId === orbitId && playback.mode === "loop") this.stopPlayback(id);
    }
  }

  hasActiveSequencePlayback(orbitId: string) {
    return [...this.active.values()].some(
      (playback) => playback.orbitId === orbitId && playback.mode === "sequence"
    );
  }

  stopActivePlaybackForPlanetBar(planetId: string, barId: string) {
    for (const [id, playback] of [...this.active]) {
      if (playback.planetId === planetId && playback.barId === barId) this.stopPlayback(id);
    }
  }

  setActivePlanetVolume(planetId: string, volume: number) {
    const context = this.getContext();
    for (const playback of this.active.values()) {
      if (playback.planetId === planetId) playback.gainNode.gain.setValueAtTime(volume, context.currentTime);
    }
  }

  setActivePlanetTapeRate(planetId: string, tapeRate: number) {
    const context = this.getContext();
    for (const playback of this.active.values()) {
      if (playback.planetId === planetId && playback.mode === "loop") {
        playback.source.playbackRate.setValueAtTime(tapeRate, context.currentTime);
      }
    }
  }

  hasProcessedBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number) {
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    return (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) ||
      this.processedBuffers.has(this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch));
  }

  hasPitchBuffer(orbitId: string, planetId: string, pitchCents: number) {
    return this.hasProcessedBuffer(orbitId, planetId, 1, pitchCents);
  }

  async processPitchBuffer(orbitId: string, planetId: string, pitchCents: number) {
    return this.processPlanetBuffer(orbitId, planetId, 1, pitchCents);
  }

  async processPlanetBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number) {
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (this.hasProcessedBuffer(orbitId, planetId, normalizedSpeed, roundedPitch)) return;
    const key = this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch);
    const original = this.buffers.get(orbitId);
    if (!original) throw new Error("Audio buffer is unavailable.");

    const pitchRate = Math.pow(2, roundedPitch / 1200);
    const outputLength = Math.max(1, Math.ceil(original.length / normalizedSpeed));
    const output = this.getContext().createBuffer(
      original.numberOfChannels, outputLength, original.sampleRate
    );
    // SoundTouch processes in large windows; zero padding lets it flush the final window
    // without mixing any dry/original source into the rendered result.
    const padded = this.getContext().createBuffer(
      original.numberOfChannels, original.length + Math.max(32768, Math.ceil(original.sampleRate * 1.5)),
      original.sampleRate
    );
    for (let channel = 0; channel < original.numberOfChannels; channel++) {
      padded.copyToChannel(original.getChannelData(channel), channel);
    }
    const soundTouch = new SoundTouch();
    soundTouch.stretch.setParameters(original.sampleRate, 0, 0, 12);
    // Processing order is effectively original -> pitch-preserving tempo -> pitch shift -> reverse.
    // The rendered buffer replaces the dry/original source; playback never layers both.
    soundTouch.tempo = normalizedSpeed;
    soundTouch.pitch = pitchRate;
    const filter = new SimpleFilter(new WebAudioBufferSource(padded), soundTouch);
    const blockFrames = 8192;
    const interleaved = new Float32Array(blockFrames * 2);
    let outputPosition = 0;
    let peak = 0;

    while (outputPosition < outputLength) {
      const requested = Math.min(blockFrames, outputLength - outputPosition);
      const frames = filter.extract(interleaved, requested);
      if (frames <= 0) break;
      for (let frame = 0; frame < frames; frame++) {
        const left = interleaved[frame * 2] || 0;
        const right = interleaved[frame * 2 + 1] || left;
        output.getChannelData(0)[outputPosition + frame] = left;
        if (output.numberOfChannels > 1) output.getChannelData(1)[outputPosition + frame] = right;
        for (let channel = 2; channel < output.numberOfChannels; channel++) {
          output.getChannelData(channel)[outputPosition + frame] = (left + right) * .5;
        }
        peak = Math.max(peak, Math.abs(left), Math.abs(right));
      }
      outputPosition += frames;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    if (peak > .98) {
      const scale = .98 / peak;
      for (let channel = 0; channel < output.numberOfChannels; channel++) {
        const samples = output.getChannelData(channel);
        for (let index = 0; index < samples.length; index++) samples[index] *= scale;
      }
    }
    this.processedBuffers.set(key, output);
  }

  startRecording() {
    if (!this.recordingDestination || typeof MediaRecorder === "undefined") {
      throw new Error("Audio recording is not supported on this system.");
    }
    if (this.recorder?.state === "recording") return;
    this.recordingChunks = [];
    const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? { mimeType: "audio/webm;codecs=opus" } : undefined;
    this.recorder = new MediaRecorder(this.recordingDestination.stream, options);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.recordingChunks.push(event.data);
    };
    this.recorder.start();
  }

  stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state !== "recording") {
        reject(new Error("No recording is active."));
        return;
      }
      const recorder = this.recorder;
      recorder.onerror = () => reject(new Error("Recording failed."));
      recorder.onstop = () => {
        const blob = new Blob(this.recordingChunks, { type: "audio/webm" });
        this.recordingChunks = [];
        this.recorder = null;
        resolve(blob);
      };
      recorder.stop();
    });
  }

  removeOrbit(orbitId: string) {
    this.stopAllActivePlaybacksForOrbit(orbitId);
    this.buffers.delete(orbitId);
    this.waveformPeaks.delete(orbitId);
    this.publishWaveformPeaks(orbitId, null);
    for (const key of [...this.processedBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) this.processedBuffers.delete(key);
    }
    for (const key of [...this.reverseBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) this.reverseBuffers.delete(key);
    }
    this.rawFiles.delete(orbitId);
    this.orbitGains.get(orbitId)?.disconnect();
    this.orbitGains.delete(orbitId);
  }
}

export const audioEngine = new AudioEngine();
