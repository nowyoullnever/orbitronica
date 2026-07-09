import { SimpleFilter, SoundTouch, WebAudioBufferSource } from "soundtouchjs";

type ActivePlayback = {
  id: string;
  orbitId: string;
  planetId: string;
  barId: string;
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  mode: "loop" | "sequence";
};

class AudioEngine {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private pitchBuffers = new Map<string, AudioBuffer>();
  private orbitGains = new Map<string, GainNode>();
  private active = new Map<string, ActivePlayback>();

  private getContext() {
    if (!this.context) this.context = new AudioContext();
    return this.context;
  }

  async resume() {
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
  }

  async decodeFile(orbitId: string, file: File, volume = 1) {
    const context = this.getContext();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    this.buffers.set(orbitId, buffer);
    const gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(context.destination);
    this.orbitGains.set(orbitId, gain);
    return buffer;
  }

  setVolume(orbitId: string, volume: number) {
    const gain = this.orbitGains.get(orbitId);
    if (gain) gain.gain.setValueAtTime(volume, this.getContext().currentTime);
  }

  private createPlayback(
    id: string, orbitId: string, planetId: string, barId: string,
    mode: "loop" | "sequence", planetVolume: number, playbackRate = 1, pitchCents = 0
  ) {
    const context = this.getContext();
    const buffer = pitchCents === 0
      ? this.buffers.get(orbitId)
      : this.pitchBuffers.get(`${orbitId}:${planetId}:${pitchCents}`) ?? this.buffers.get(orbitId);
    const orbitGain = this.orbitGains.get(orbitId);
    if (!buffer || !orbitGain) return null;
    const source = context.createBufferSource();
    const planetGain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    planetGain.gain.value = planetVolume;
    source.connect(planetGain);
    planetGain.connect(orbitGain);
    const playback: ActivePlayback = { id, orbitId, planetId, barId, source, gainNode: planetGain, mode };
    this.active.set(id, playback);
    source.onended = () => {
      if (this.active.get(id)?.source === source) this.active.delete(id);
      try { planetGain.disconnect(); } catch { /* disconnected */ }
    };
    return {
      playback,
      buffer,
      context,
      usingProcessedBuffer: buffer !== this.buffers.get(orbitId)
    };
  }

  syncLoop(
    orbitId: string, planetId: string, barId: string, inside: boolean,
    audioTime: number, planetVolume: number, playbackRate: number, pitchCents: number
  ) {
    const key = `loop:${planetId}:${barId}`;
    const current = this.active.get(key);
    if (!inside) {
      if (current) this.stopPlayback(key);
      return;
    }
    if (current) {
      current.gainNode.gain.setValueAtTime(planetVolume, this.getContext().currentTime);
      current.source.playbackRate.setValueAtTime(playbackRate, this.getContext().currentTime);
      return;
    }
    const created = this.createPlayback(
      key, orbitId, planetId, barId, "loop", planetVolume, playbackRate, pitchCents
    );
    if (!created) return;
    const safeOffset = Math.min(Math.max(audioTime, 0), Math.max(0, created.buffer.duration - .001));
    created.playback.source.start(created.context.currentTime, safeOffset);
    console.debug({
      orbitId, planetId, barId, pitchCents,
      usingProcessedBuffer: created.usingProcessedBuffer,
      activePlaybackCount: this.active.size
    });
  }

  triggerSequence(
    orbitId: string, planetId: string, barId: string, planetVolume: number,
    playbackRate: number, pitchCents: number
  ) {
    this.stopActivePlaybackForPlanetBar(planetId, barId);
    const id = `sequence:${planetId}:${barId}:${crypto.randomUUID()}`;
    const created = this.createPlayback(
      id, orbitId, planetId, barId, "sequence", planetVolume, playbackRate, pitchCents
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
      if (playback.planetId === planetId) {
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

  removeOrbit(orbitId: string) {
    this.stopAllActivePlaybacksForOrbit(orbitId);
    this.buffers.delete(orbitId);
    for (const key of [...this.pitchBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) this.pitchBuffers.delete(key);
    }
    this.orbitGains.get(orbitId)?.disconnect();
    this.orbitGains.delete(orbitId);
  }
}

export const audioEngine = new AudioEngine();
