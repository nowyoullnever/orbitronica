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
};

class AudioEngine {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private pitchBuffers = new Map<string, AudioBuffer>();
  private reverseBuffers = new Map<string, AudioBuffer>();
  private rawFiles = new Map<string, { fileName: string; bytes: Uint8Array }>();
  private orbitGains = new Map<string, GainNode>();
  private active = new Map<string, ActivePlayback>();
  private masterGain: GainNode | null = null;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];

  private getContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
      this.recordingDestination = this.context.createMediaStreamDestination();
      this.masterGain.connect(this.recordingDestination);
    }
    return this.context;
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

  setVolume(orbitId: string, volume: number) {
    const gain = this.orbitGains.get(orbitId);
    if (gain) gain.gain.setValueAtTime(volume, this.getContext().currentTime);
  }

  private createPlayback(
    id: string, orbitId: string, planetId: string, barId: string,
    mode: "loop" | "sequence", planetVolume: number, playbackRate = 1,
    pitchCents = 0, reverse = false
  ) {
    const context = this.getContext();
    const buffer = pitchCents === 0
      ? this.buffers.get(orbitId)
      : this.pitchBuffers.get(`${orbitId}:${planetId}:${pitchCents}`) ?? this.buffers.get(orbitId);
    const orbitGain = this.orbitGains.get(orbitId);
    if (!buffer || !orbitGain) return null;
    let playbackBuffer = buffer;
    if (reverse) {
      const reverseKey = `${orbitId}:${planetId}:${pitchCents}:reverse`;
      playbackBuffer = this.reverseBuffers.get(reverseKey) ?? this.createReversedBuffer(reverseKey, buffer);
    }
    const source = context.createBufferSource();
    const planetGain = context.createGain();
    source.buffer = playbackBuffer;
    source.playbackRate.value = playbackRate;
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
      usingProcessedBuffer: buffer !== this.buffers.get(orbitId)
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
    audioTime: number, planetVolume: number, playbackRate: number, pitchCents: number,
    reverse = false
  ) {
    const key = `loop:${planetId}:${barId}`;
    const current = this.active.get(key);
    if (!inside) {
      if (current) this.stopPlayback(key);
      return;
    }
    if (current) {
      if (current.isReverse !== reverse) {
        this.stopPlayback(key);
      } else {
        current.gainNode.gain.setValueAtTime(planetVolume, this.getContext().currentTime);
        current.source.playbackRate.setValueAtTime(playbackRate, this.getContext().currentTime);
        return;
      }
    }
    const created = this.createPlayback(
      key, orbitId, planetId, barId, "loop", planetVolume, playbackRate, pitchCents, reverse
    );
    if (!created) return;
    const mappedTime = reverse ? created.buffer.duration - audioTime : audioTime;
    const safeOffset = Math.min(Math.max(mappedTime, 0), Math.max(0, created.buffer.duration - .001));
    created.playback.source.start(created.context.currentTime, safeOffset);
    console.debug({
      orbitId, planetId, barId, pitchCents,
      usingProcessedBuffer: created.usingProcessedBuffer,
      activePlaybackCount: this.active.size
    });
  }

  triggerSequence(
    orbitId: string, planetId: string, barId: string, planetVolume: number,
    playbackRate: number, pitchCents: number, reverse: boolean,
    retriggerMode: SequenceRetriggerMode
  ) {
    if (retriggerMode === "ignore-until-end" && this.hasActiveSequencePlayback(orbitId)) return;
    if (retriggerMode === "cut-previous") this.stopActiveSequencePlaybacksForOrbit(orbitId);
    const id = `sequence:${planetId}:${barId}:${crypto.randomUUID()}`;
    const created = this.createPlayback(
      id, orbitId, planetId, barId, "sequence", planetVolume, playbackRate, pitchCents, reverse
    );
    if (created) {
      created.playback.source.start(created.context.currentTime);
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

  setActivePlanetPlaybackRate(planetId: string, playbackRate: number) {
    const context = this.getContext();
    for (const playback of this.active.values()) {
      if (playback.planetId === planetId && playback.mode === "loop") {
        playback.source.playbackRate.setValueAtTime(playbackRate, context.currentTime);
      }
    }
  }

  hasPitchBuffer(orbitId: string, planetId: string, pitchCents: number) {
    return pitchCents === 0 || this.pitchBuffers.has(`${orbitId}:${planetId}:${pitchCents}`);
  }

  async processPitchBuffer(orbitId: string, planetId: string, pitchCents: number) {
    if (pitchCents === 0) return;
    const key = `${orbitId}:${planetId}:${pitchCents}`;
    if (this.pitchBuffers.has(key)) return;
    const original = this.buffers.get(orbitId);
    if (!original) throw new Error("Audio buffer is unavailable.");

    const pitchRate = Math.pow(2, pitchCents / 1200);
    const output = this.getContext().createBuffer(
      original.numberOfChannels, original.length, original.sampleRate
    );
    // SoundTouch processes in large windows; zero padding lets it flush the final window
    // without mixing any dry/original source into the rendered result.
    const padded = this.getContext().createBuffer(
      original.numberOfChannels, original.length + 32768, original.sampleRate
    );
    for (let channel = 0; channel < original.numberOfChannels; channel++) {
      padded.copyToChannel(original.getChannelData(channel), channel);
    }
    const soundTouch = new SoundTouch();
    soundTouch.stretch.setParameters(original.sampleRate, 0, 0, 12);
    soundTouch.tempo = 1;
    soundTouch.pitch = pitchRate;
    const filter = new SimpleFilter(new WebAudioBufferSource(padded), soundTouch);
    const blockFrames = 8192;
    const interleaved = new Float32Array(blockFrames * 2);
    let outputPosition = 0;
    let peak = 0;

    while (outputPosition < original.length) {
      const requested = Math.min(blockFrames, original.length - outputPosition);
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
    this.pitchBuffers.set(key, output);
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
    for (const key of [...this.pitchBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) this.pitchBuffers.delete(key);
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
