import { SimpleFilter, SoundTouch, WebAudioBufferSource } from "soundtouchjs";
import type { Orbit, PluginSlot, SequenceRetriggerMode } from "../state/types";
import { createFLStylePanNode, type FLStylePanNode } from "./flStylePan.ts";
import { WamHost, cloneJsonValue } from "./wamHost.ts";
import { loadCatalogModule, resolveCatalogEntryForRestore } from "./wamCatalog.ts";
import { OrbitWamRack, prunePluginStates, type PluginRuntimeStatus } from "./wamRack.ts";

type ActivePlayback = {
  id: string;
  orbitId: string;
  planetId: string;
  barId: string;
  source: AudioBufferSourceNode;
  planetGainNode: GainNode;
  planetPanNode: FLStylePanNode;
  mode: "loop" | "sequence";
  isReverse: boolean;
  processedWindow?: ProcessingWindow;
  loopWindowStart?: number;
  loopWindowEnd?: number;
};

type OrbitAudioRuntime = {
  input: GainNode;
  panNode: FLStylePanNode;
  gainNode: GainNode;
};

type WaveformListener = (orbitId: string, peaks: Float32Array | null) => void;

export type ProjectAudioInput = {
  orbitId: string;
  fileName: string;
  bytes: Uint8Array;
  volume: number;
  pan: number;
};

export type StagedProjectAudio = ProjectAudioInput & { buffer: AudioBuffer };

export type RecordedPcm = { channels: Float32Array[]; sampleRate: number };
type DecodedContent = { hash: string; bytes: Uint8Array; buffer: AudioBuffer };
type ColdPcm16 = { channels: Int16Array[]; length: number; sampleRate: number };

/** Logical AudioBuffer/encoded-byte residency, deduplicated by object identity where noted. */
export type AudioMemoryStats = {
  originalReferencedBytes: number;
  originalUniqueBytes: number;
  rawReferencedBytes: number;
  rawUniqueBytes: number;
  processedUniqueBytes: number;
  reverseUniqueBytes: number;
  activeOnlyUniqueBytes: number;
  totalUniqueFloatBytes: number;
  coldPcmBytes: number;
};

type PlaybackBufferResolution =
  | { status: "ready"; buffer: AudioBuffer; key: string; usingProcessedBuffer: boolean }
  | { status: "pending"; cacheKey: string }
  | { status: "missing-original" };

export type ProcessingWindow = {
  sourceStartFrame: number;
  sourceEndFrame: number;
  contentStartFrame: number;
  contentEndFrame: number;
  bufferStartFrame: number;
  bufferEndFrame: number;
  fullOutputLength: number;
};

type RecordingSession = {
  id: number;
  state: "starting" | "recording" | "stopping";
  chunks: [Float32Array[], Float32Array[]];
  resolve?: () => void;
  reject?: (error: Error) => void;
  timeout?: number;
  result?: RecordedPcm;
};

// Keep the Blob path self-contained; the emitted asset URL below is only the
// sandbox fallback and is deliberately a standalone worklet script as well.
const PCM_WORKLET_SOURCE = `
class OrbitronicaPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.recordingId = null; this.left = []; this.right = []; this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "start") { this.recordingId = data.recordingId; this.left = []; this.right = []; this.frames = 0; this.port.postMessage({ type: "started", recordingId: data.recordingId }); }
      else if (data.type === "stop" && data.recordingId === this.recordingId) { this.flush(); this.port.postMessage({ type: "stopped", recordingId: data.recordingId }); this.recordingId = null; }
    };
  }
  flush() { if (!this.frames) return; const left = new Float32Array(this.frames), right = new Float32Array(this.frames); let offset = 0;
    for (const block of this.left) { left.set(block, offset); offset += block.length; } offset = 0;
    for (const block of this.right) { right.set(block, offset); offset += block.length; }
    this.port.postMessage({ type: "chunk", recordingId: this.recordingId, left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]); this.left = []; this.right = []; this.frames = 0;
  }
  process(inputs) { const input = inputs[0]; if (this.recordingId !== null) { const left = input[0], right = input[1] || left;
      const length = left ? left.length : 128, copyLeft = new Float32Array(length), copyRight = new Float32Array(length);
      if (left) copyLeft.set(left); if (right) copyRight.set(right); this.left.push(copyLeft); this.right.push(copyRight); this.frames += length; if (this.frames >= 2048) this.flush(); }
    return true;
  }
}
registerProcessor("orbitronica-pcm-capture", OrbitronicaPcmCapture);`;

// Vite rewrites this to the emitted script URL in dev and packaged builds;
// Node-only unit tests can still import this module without a query-loader.
const recorderProcessorAssetUrl = new URL("./recorder-processor.js", import.meta.url).toString();

class AudioEngine {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private waveformPeaks = new Map<string, Float32Array>();
  private waveformPeakPromises = new WeakMap<AudioBuffer, Promise<Float32Array>>();
  private waveformListeners = new Set<WaveformListener>();
  private readonly waveformResolution = 1024;
  private processedBuffers = new Map<string, AudioBuffer>();
  private coldProcessedBuffers = new Map<string, ColdPcm16>();
  /** Startup-only opt-in; production defaults to Float32 cache behavior. */
  private readonly pcm16ColdCacheEnabled = (globalThis as { __ORBITRONICA_PCM16_COLD_CACHE__?: boolean }).__ORBITRONICA_PCM16_COLD_CACHE__ === true;
  /** Physical cache buffers are guarded; this preserves their logical output coordinates. */
  private processedWindows = new Map<string, ProcessingWindow>();
  private reverseBuffers = new Map<string, AudioBuffer>();
  /** One render per exact cache key; all callers share its completion. */
  private processingPromises = new Map<string, Promise<void>>();
  private dspRenderQueue: Array<() => void> = [];
  private activeDspRenders = 0;
  // Each entry is a fully decoded AudioBuffer (often several MB for a long sample), and a
  // new entry is produced per distinct (speed, pitch) tuple as the user sweeps those
  // controls. Left unbounded this grows without limit; 64 entries per cache keeps steady
  // memory bounded to a comfortably large recent working set while still amortizing repeat
  // requests. Eviction is least-recently-used, and a buffer currently backing an active
  // (including looping) playback is never evicted regardless of recency.
  private static readonly PROCESSED_BUFFER_CACHE_CAP = 64;
  private static readonly PCM16_HOT_BUFFER_CACHE_CAP = 8;
  private static readonly MAX_CONCURRENT_DSP_RENDERS = 1;
  private static readonly PROCESSING_GUARD_FRAMES = 128;
  private rawFiles = new Map<string, { fileName: string; bytes: Uint8Array }>();
  /** Content-addressed weak registries never retain audio after its orbit owners release it. */
  private decodedByHash = new Map<string, WeakRef<AudioBuffer>>();
  private bytesByHash = new Map<string, WeakRef<Uint8Array>>();
  private pendingDecodeByHash = new Map<string, Promise<DecodedContent>>();
  private orbitRuntimes = new Map<string, OrbitAudioRuntime>();
  private orbitPanValues = new Map<string, number>();
  private readonly wamHost = new WamHost();
  /** State outlives runtime and document history; it is never embedded in Orbit. */
  private readonly pluginStateStore = new Map<string, import("./wamHost.ts").JsonValue>();
  private readonly orbitWamRacks = new Map<string, OrbitWamRack>();
  /** Independent from playback callbacks: only the newest hydrate may own audio. */
  private scenePluginTransitionGeneration = 0;
  private scenePluginRuntimeOwner: string | null = null;
  private active = new Map<string, ActivePlayback>();
  private masterGain: GainNode | null = null;
  private masterPanner: StereoPannerNode | null = null;
  private meterSplitter: ChannelSplitterNode | null = null;
  private meterAnalyserL: AnalyserNode | null = null;
  private meterAnalyserR: AnalyserNode | null = null;
  private meterBufferL: Float32Array | null = null;
  private meterBufferR: Float32Array | null = null;
  private masterVolume = 1;
  private masterPan = 0;
  private recordingNode: AudioWorkletNode | null = null;
  private recordingPull: GainNode | null = null;
  private recordingSession: RecordingSession | null = null;
  private recordingModuleLoads = new WeakMap<AudioContext, Promise<void>>();
  private nextRecordingId = 0;

  private getContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.masterGain = this.context.createGain();
      this.masterPanner = this.context.createStereoPanner();
      this.masterGain.gain.value = this.masterVolume;
      this.masterPanner.pan.value = this.masterPan;
      // Final chain: orbit gains -> master volume -> master pan -> output.
      this.masterGain.connect(this.masterPanner);
      this.masterPanner.connect(this.context.destination);
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
    this.masterVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    if (this.context && this.masterGain) {
      this.masterGain.gain.setValueAtTime(this.masterVolume, this.context.currentTime);
    }
  }

  setMasterPan(pan: number) {
    this.masterPan = Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : 0;
    if (this.context && this.masterPanner) {
      this.masterPanner.pan.setValueAtTime(this.masterPan, this.context.currentTime);
    }
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
    const raw = await file.arrayBuffer();
    const content = await this.decodeContent(new Uint8Array(raw));
    this.rawFiles.set(orbitId, { fileName: file.name, bytes: content.bytes });
    this.registerBuffer(orbitId, content.buffer, volume);
    return content.buffer;
  }

  async decodeBytes(orbitId: string, fileName: string, bytes: Uint8Array, volume = 1) {
    const content = await this.decodeContent(bytes);
    this.rawFiles.set(orbitId, { fileName, bytes: content.bytes });
    this.registerBuffer(orbitId, content.buffer, volume);
    return content.buffer;
  }

  /** Decodes a complete candidate project without mutating the live audio graph. */
  async stageProjectAudio(inputs: readonly ProjectAudioInput[]): Promise<StagedProjectAudio[]> {
    const staged: StagedProjectAudio[] = [];
    for (const input of inputs) {
      const content = await this.decodeContent(input.bytes);
      staged.push({ ...input, bytes: content.bytes, buffer: content.buffer });
    }
    return staged;
  }

  private async contentHash(bytes: Uint8Array) {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    return `${bytes.byteLength}:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  private async decodeContent(input: Uint8Array): Promise<DecodedContent> {
    const hash = await this.contentHash(input);
    const pending = this.pendingDecodeByHash.get(hash);
    if (pending) return pending;
    const load = (async () => {
      let bytes = this.bytesByHash.get(hash)?.deref();
      if (!bytes) {
        bytes = new Uint8Array(input);
        this.bytesByHash.set(hash, new WeakRef(bytes));
      }
      let buffer = this.decodedByHash.get(hash)?.deref();
      if (!buffer) {
        // decodeAudioData is allowed to detach/mutate its input, never the canonical bytes.
        buffer = await this.getContext().decodeAudioData(bytes.slice().buffer);
        this.decodedByHash.set(hash, new WeakRef(buffer));
      }
      return { hash, bytes, buffer };
    })();
    this.pendingDecodeByHash.set(hash, load);
    try { return await load; }
    finally { if (this.pendingDecodeByHash.get(hash) === load) this.pendingDecodeByHash.delete(hash); }
  }

  /** Staged bytes are transaction-owned and immutable after staging; install keeps that single owned copy. */
  installStagedOrbitAudio(item: StagedProjectAudio): void {
    if (this.buffers.has(item.orbitId) || this.rawFiles.has(item.orbitId) || this.orbitRuntimes.has(item.orbitId)) {
      throw new Error(`Audio already exists for orbit "${item.orbitId}".`);
    }
    try {
      this.rawFiles.set(item.orbitId, { fileName: item.fileName, bytes: item.bytes });
      this.registerBuffer(item.orbitId, item.buffer, item.volume);
      this.setOrbitAudioPan(item.orbitId, item.pan);
    } catch (error) {
      this.removeOrbit(item.orbitId);
      throw error;
    }
  }

  /** Atomically replaces live project audio; failed graph installation restores the old assets. */
  replaceProjectAudio(staged: readonly StagedProjectAudio[]): void {
    const old = [...this.buffers].map(([orbitId, buffer]) => ({
      orbitId,
      buffer,
      raw: this.rawFiles.get(orbitId),
      volume: this.orbitRuntimes.get(orbitId)?.gainNode.gain.value ?? 1,
      pan: this.orbitPanValues.get(orbitId) ?? 0
    }));
    const oldProcessed = new Map(this.processedBuffers);
    const oldReverse = new Map(this.reverseBuffers);
    const clear = () => {
      const ids = new Set([...this.buffers.keys(), ...this.rawFiles.keys(), ...this.orbitRuntimes.keys()]);
      ids.forEach((id) => this.removeOrbit(id));
    };
    try {
      clear();
      for (const item of staged) {
        this.rawFiles.set(item.orbitId, { fileName: item.fileName, bytes: item.bytes });
        this.registerBuffer(item.orbitId, item.buffer, item.volume);
        this.setOrbitAudioPan(item.orbitId, item.pan);
      }
    } catch (error) {
      clear();
      for (const item of old) {
        if (item.raw) this.rawFiles.set(item.orbitId, item.raw);
        this.registerBuffer(item.orbitId, item.buffer, item.volume);
        this.setOrbitAudioPan(item.orbitId, item.pan);
      }
      this.processedBuffers = oldProcessed;
      this.reverseBuffers = oldReverse;
      throw error;
    }
  }

  private registerBuffer(orbitId: string, buffer: AudioBuffer, volume: number) {
    const context = this.getContext();
    // A replacement source must never reuse DSP rendered from the old source.
    this.clearOrbitProcessedCaches(orbitId);
    this.buffers.set(orbitId, buffer);
    this.waveformPeaks.delete(orbitId);
    this.publishWaveformPeaks(orbitId, null);
    void this.cacheWaveformPeaks(orbitId, buffer);
    const input = context.createGain();
    const panNode = createFLStylePanNode(context, 2, 0);
    const gainNode = context.createGain();
    gainNode.gain.value = volume;
    input.connect(panNode.input);
    panNode.output.connect(gainNode);
    gainNode.connect(this.masterGain!);
    this.orbitRuntimes.set(orbitId, { input, panNode, gainNode });
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

  /**
   * Reports logical residency rather than allocator/RSS usage. Shared identities are
   * deliberately counted once in the unique fields so P5 can be measured without
   * confusing orbit references for retained memory.
   */
  getAudioMemoryStats(): AudioMemoryStats {
    const audioBufferBytes = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    const byteArrayBytes = (bytes: Uint8Array) => bytes.byteLength;
    const sumReferenced = <T>(values: Iterable<T>, bytes: (value: T) => number) => {
      let total = 0;
      for (const value of values) total += bytes(value);
      return total;
    };
    const sumUnique = <T extends object>(values: Iterable<T>, bytes: (value: T) => number) => {
      const seen = new Set<T>();
      let total = 0;
      for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        total += bytes(value);
      }
      return total;
    };
    const originals = [...this.buffers.values()];
    const rawBytes = [...this.rawFiles.values()].map((asset) => asset.bytes);
    const processed = [...this.processedBuffers.values()];
    const reversed = [...this.reverseBuffers.values()];
    const active = [...this.active.values()].flatMap((playback) => playback.source.buffer ? [playback.source.buffer] : []);
    const cacheOwned = new Set<AudioBuffer>([...originals, ...processed, ...reversed]);
    const activeOnly = active.filter((buffer) => !cacheOwned.has(buffer));
    return {
      originalReferencedBytes: sumReferenced(originals, audioBufferBytes),
      originalUniqueBytes: sumUnique(originals, audioBufferBytes),
      rawReferencedBytes: sumReferenced(rawBytes, byteArrayBytes),
      rawUniqueBytes: sumUnique(rawBytes, byteArrayBytes),
      processedUniqueBytes: sumUnique(processed, audioBufferBytes),
      reverseUniqueBytes: sumUnique(reversed, audioBufferBytes),
      activeOnlyUniqueBytes: sumUnique(activeOnly, audioBufferBytes),
      totalUniqueFloatBytes: sumUnique([...originals, ...processed, ...reversed, ...active], audioBufferBytes),
      coldPcmBytes: [...this.coldProcessedBuffers.values()].reduce((total, entry) => total + entry.channels.reduce((sum, channel) => sum + channel.byteLength, 0), 0)
    };
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
    const runtime = this.orbitRuntimes.get(orbitId);
    if (runtime) runtime.gainNode.gain.setValueAtTime(volume, this.getContext().currentTime);
  }

  private rackForOrbit(orbitId: string): OrbitWamRack {
    const existing = this.orbitWamRacks.get(orbitId); if (existing) return existing;
    const runtime = this.orbitRuntimes.get(orbitId);
    if (!runtime) throw new Error(`Audio runtime is unavailable for orbit "${orbitId}".`);
    const rack = new OrbitWamRack(runtime.input, runtime.panNode.input, async (slot) => {
      // The stored version is state provenance. Known trusted plugins attempt
      // restoration across a version difference; setState failure remains dry
      // and preserves the original blob for a later migration.
      const entry = resolveCatalogEntryForRestore(slot.catalogId, slot.pluginVersion);
      if (!entry) throw new Error("WAM catalog entry is unavailable.");
      return this.wamHost.createPluginInstance(this.getContext(), () => loadCatalogModule(entry), entry.id);
    }, this.pluginStateStore);
    this.orbitWamRacks.set(orbitId, rack); return rack;
  }

  /** Universal rack reconciliation for structural edits, undo/redo, open and thaw. */
  async reconcileOrbitPluginRack(orbitId: string, slots: readonly PluginSlot[], generation?: number): Promise<void> {
    await this.rackForOrbit(orbitId).reconcile(slots, generation);
  }
  /** Revoke a rack's pending hydration before its scene becomes frozen. */
  invalidateOrbitPluginRack(orbitId: string): void { this.orbitWamRacks.get(orbitId)?.invalidate(); }
  async freezeOrbitPluginRack(orbitId: string): Promise<void> { await this.orbitWamRacks.get(orbitId)?.freeze(); }
  /** Commit WAM state only after every active rack produced a valid snapshot. */
  async snapshotOrbitPluginStates(): Promise<void> {
    const staged = await Promise.all([...this.orbitWamRacks.values()].map((rack) => rack.captureActiveStateForSave()));
    for (const states of staged) for (const [slotId, value] of states) this.pluginStateStore.set(slotId, value);
  }
  getOrbitPluginStatus(orbitId: string, slotId: string): PluginRuntimeStatus { return this.orbitWamRacks.get(orbitId)?.getStatus(slotId) ?? "idle"; }
  async mountOrbitPluginGui(orbitId: string, slotId: string, container: HTMLElement): Promise<void> {
    await this.orbitWamRacks.get(orbitId)?.mountGui(slotId, container);
  }
  async unmountOrbitPluginGui(orbitId: string, slotId: string): Promise<void> {
    await this.orbitWamRacks.get(orbitId)?.unmountGui(slotId);
  }
  getPluginStateStore(): ReadonlyMap<string, import("./wamHost.ts").JsonValue> { return this.pluginStateStore; }
  /** Replaces only durable, already-validated state during an open transaction. */
  replacePluginStateStore(states: ReadonlyMap<string, import("./wamHost.ts").JsonValue>) {
    this.pluginStateStore.clear();
    for (const [slotId, value] of states) this.pluginStateStore.set(slotId, cloneJsonValue(value));
  }
  prunePluginStateSlots(retainedSlotIds: ReadonlySet<string>) { prunePluginStates(this.pluginStateStore, retainedSlotIds); }
  copyPluginSlotStates(source: readonly PluginSlot[] | undefined, destination: readonly PluginSlot[] | undefined) {
    const from = source ?? [], to = destination ?? [];
    for (let index = 0; index < Math.min(from.length, to.length); index++) {
      const state = this.pluginStateStore.get(from[index].id);
      if (state !== undefined) this.pluginStateStore.set(to[index].id, cloneJsonValue(state));
    }
  }
  /** Scene duplication supplies an explicit old→new map, never array position. */
  copyPluginStatesBySlotMap(slotIds: ReadonlyMap<string, string>): readonly string[] {
    const staged = new Map<string, import("./wamHost.ts").JsonValue>();
    for (const [sourceId, targetId] of slotIds) {
      const state = this.pluginStateStore.get(sourceId);
      if (state !== undefined) staged.set(targetId, cloneJsonValue(state));
    }
    for (const [targetId, state] of staged) this.pluginStateStore.set(targetId, state);
    return [...staged.keys()];
  }
  removePluginSlotStates(slotIds: readonly string[]) { for (const slotId of slotIds) this.pluginStateStore.delete(slotId); }
  getScenePluginRuntimeOwner() { return this.scenePluginRuntimeOwner; }
  /**
   * Gate-first, last-wins scene runtime transaction. App owns document
   * publication; this boundary owns WAM lifetime and never lets an older
   * hydration publish ownership after a newer request has arrived.
   */
  async transitionScenePluginRacks(previous: readonly Orbit[], target: readonly Orbit[], generation: number, targetSceneId?: string): Promise<boolean> {
    this.scenePluginTransitionGeneration = Math.max(this.scenePluginTransitionGeneration, generation);
    const current = () => generation === this.scenePluginTransitionGeneration;
    this.scenePluginRuntimeOwner = null;
    // Invalidate synchronously, before the first await in freeze. Otherwise a
    // pending create() can settle during state capture and rewire a frozen rack.
    previous.forEach((orbit) => this.invalidateOrbitPluginRack(orbit.id));
    await Promise.all(previous.map((orbit) => this.freezeOrbitPluginRack(orbit.id)));
    if (!current()) return false;
    await Promise.all(target.filter((orbit) => (orbit.plugins?.length ?? 0) > 0 && this.orbitRuntimes.has(orbit.id))
      .map((orbit) => this.reconcileOrbitPluginRack(orbit.id, orbit.plugins ?? [], generation)));
    if (!current()) return false;
    this.scenePluginRuntimeOwner = targetSceneId ?? null;
    return true;
  }

  private normalizedSpeed(speed: number) {
    return Number.isFinite(speed) && speed > 0 ? Math.max(.05, speed) : 1;
  }

  private hasUserSpeedChange(speed: number) {
    return Math.abs(this.normalizedSpeed(speed) - 1) > .0001;
  }

  private processingWindow(orbitId: string, speed: number, sampleStart = 0, sampleEnd = Infinity): ProcessingWindow {
    const original = this.buffers.get(orbitId);
    if (!original) throw new Error("Audio buffer is unavailable.");
    const rate = original.sampleRate;
    const sourceStartFrame = Math.min(original.length, Math.max(0, Math.floor((Number.isFinite(sampleStart) ? sampleStart : 0) * rate)));
    const requestedEnd = Number.isFinite(sampleEnd) ? sampleEnd : original.duration;
    const sourceEndFrame = Math.min(original.length, Math.max(sourceStartFrame, Math.ceil(requestedEnd * rate)));
    const normalizedSpeed = this.normalizedSpeed(speed);
    const fullOutputLength = Math.max(1, Math.ceil(original.length / normalizedSpeed));
    const contentStartFrame = Math.min(fullOutputLength, Math.max(0, Math.floor(sourceStartFrame / normalizedSpeed)));
    const contentEndFrame = Math.min(fullOutputLength, Math.max(contentStartFrame, Math.ceil(sourceEndFrame / normalizedSpeed)));
    return {
      sourceStartFrame, sourceEndFrame, contentStartFrame, contentEndFrame, fullOutputLength,
      bufferStartFrame: Math.max(0, contentStartFrame - AudioEngine.PROCESSING_GUARD_FRAMES),
      bufferEndFrame: Math.min(fullOutputLength, contentEndFrame + AudioEngine.PROCESSING_GUARD_FRAMES)
    };
  }

  private processedBufferKey(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    // The cache identity must describe exactly the speed given to SoundTouch.
    // Number#toString round-trips IEEE-754 values while avoiding a UI-formatting
    // change in the DSP path.
    const window = this.processingWindow(orbitId, speed, sampleStart, sampleEnd);
    return `${orbitId}:${planetId}:speed=${this.normalizedSpeed(speed).toString()}:pitch=${Math.round(pitchCents)}:${window.sourceStartFrame}~${window.sourceEndFrame}`;
  }

  private clearOrbitProcessedCaches(orbitId: string) {
    for (const key of new Set([...this.processedBuffers.keys(), ...this.coldProcessedBuffers.keys()])) if (key.startsWith(`${orbitId}:`)) { this.processedBuffers.delete(key); this.coldProcessedBuffers.delete(key); this.processedWindows.delete(key); }
    for (const key of [...this.reverseBuffers.keys()]) if (key.startsWith(`${orbitId}:`)) this.reverseBuffers.delete(key);
  }

  private scheduleDspRender(render: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.activeDspRenders++;
        void render().then(resolve, reject).finally(() => {
          this.activeDspRenders--;
          this.dspRenderQueue.shift()?.();
        });
      };
      if (this.activeDspRenders < AudioEngine.MAX_CONCURRENT_DSP_RENDERS) start();
      else this.dspRenderQueue.push(start);
    });
  }

  /** AudioBuffers currently backing any active (including looping) playback source. */
  private activePlaybackBuffers(): Set<AudioBuffer> {
    const buffers = new Set<AudioBuffer>();
    for (const playback of this.active.values()) {
      if (playback.source.buffer) buffers.add(playback.source.buffer);
    }
    return buffers;
  }

  /** Reads a cache entry and, on hit, refreshes its recency to most-recently-used. */
  private touchCachedBuffer(cache: Map<string, AudioBuffer>, key: string): AudioBuffer | undefined {
    let value = cache.get(key);
    if (value === undefined && cache === this.processedBuffers) value = this.inflateColdProcessedBuffer(key);
    if (value === undefined) return undefined;
    // Map iteration order is insertion order, so a delete+re-set moves this key to the
    // most-recently-used end without needing a separate recency structure.
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  /** Inserts a cache entry, then evicts least-recently-used entries beyond the cap. */
  private cacheProcessedBuffer(cache: Map<string, AudioBuffer>, key: string, value: AudioBuffer) {
    if (cache === this.processedBuffers && this.pcm16ColdCacheEnabled) this.coldProcessedBuffers.set(key, this.toColdPcm16(value));
    cache.delete(key);
    cache.set(key, value);
    const cap = cache === this.processedBuffers && this.pcm16ColdCacheEnabled ? AudioEngine.PCM16_HOT_BUFFER_CACHE_CAP : AudioEngine.PROCESSED_BUFFER_CACHE_CAP;
    if (cache.size <= cap) return;
    const protectedBuffers = this.activePlaybackBuffers();
    for (const [candidateKey, candidateValue] of cache) {
      if (cache.size <= cap) break;
      if (candidateKey === key) continue;
      if (protectedBuffers.has(candidateValue)) continue;
      cache.delete(candidateKey);
      if (cache === this.processedBuffers && !this.coldProcessedBuffers.has(candidateKey)) this.processedWindows.delete(candidateKey);
    }
  }

  private toColdPcm16(buffer: AudioBuffer): ColdPcm16 {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
      const source = buffer.getChannelData(channel), pcm = new Int16Array(source.length);
      for (let frame = 0; frame < source.length; frame++) {
        const value = source[frame];
        pcm[frame] = Number.isFinite(value) ? Math.max(-32768, Math.min(32767, Math.round(value * 32768))) : 0;
      }
      return pcm;
    });
    return { channels, length: buffer.length, sampleRate: buffer.sampleRate };
  }

  private inflateColdProcessedBuffer(key: string): AudioBuffer | undefined {
    const cold = this.coldProcessedBuffers.get(key);
    if (!cold) return undefined;
    const buffer = this.getContext().createBuffer(cold.channels.length, cold.length, cold.sampleRate);
    for (let channel = 0; channel < cold.channels.length; channel++) {
      const target = buffer.getChannelData(channel), source = cold.channels[channel];
      for (let frame = 0; frame < source.length; frame++) target[frame] = source[frame] / 32768;
    }
    this.cacheProcessedBuffer(this.processedBuffers, key, buffer);
    return buffer;
  }

  private getPlaybackBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity): PlaybackBufferResolution {
    const original = this.buffers.get(orbitId);
    if (!original) return { status: "missing-original" };
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) {
      return {
        status: "ready",
        buffer: original,
        key: this.processedBufferKey(orbitId, planetId, 1, 0),
        usingProcessedBuffer: false
      };
    }
    const key = this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd);
    const processed = this.touchCachedBuffer(this.processedBuffers, key);
    if (processed) return { status: "ready", buffer: processed, key, usingProcessedBuffer: true };
    // Playing the original here silently discards requested speed/pitch. The
    // caller skips this trigger until its explicit prewarm/render completes.
    return { status: "pending", cacheKey: key };
  }

  private createPlayback(
    id: string, orbitId: string, planetId: string, barId: string,
    mode: "loop" | "sequence", planetVolume: number, planetAudioPan: number, tapeRate = 1,
    userSpeed = 1, pitchCents = 0, reverse = false, sampleStart = 0, sampleEnd = Infinity
  ) {
    const context = this.getContext();
    const resolved = this.getPlaybackBuffer(orbitId, planetId, userSpeed, pitchCents, sampleStart, sampleEnd);
    const orbitRuntime = this.orbitRuntimes.get(orbitId);
    if (resolved.status !== "ready" || !orbitRuntime) return null;
    let playbackBuffer = resolved.buffer;
    if (reverse) {
      const reverseKey = `${resolved.key}:reverse`;
      playbackBuffer = this.touchCachedBuffer(this.reverseBuffers, reverseKey) ?? this.createReversedBuffer(reverseKey, resolved.buffer);
    }
    const source = context.createBufferSource();
    const planetGain = context.createGain();
    const planetPanNode = createFLStylePanNode(context, playbackBuffer.numberOfChannels, planetAudioPan);
    source.buffer = playbackBuffer;
    // User speed is rendered into the processed buffer to preserve pitch.
    // playbackRate is intentionally limited to immediate tape-style runtime effects.
    source.playbackRate.value = tapeRate;
    planetGain.gain.value = planetVolume;
    source.connect(planetPanNode.input);
    planetPanNode.output.connect(planetGain);
    planetGain.connect(orbitRuntime.input);
    const playback: ActivePlayback = {
      id, orbitId, planetId, barId, source, planetGainNode: planetGain, planetPanNode, mode, isReverse: reverse,
      processedWindow: resolved.usingProcessedBuffer ? this.processedWindows.get(resolved.key) : undefined
    };
    this.active.set(id, playback);
    source.onended = () => {
      if (this.active.get(id)?.source === source) this.active.delete(id);
      try { planetGain.disconnect(); } catch { /* disconnected */ }
      planetPanNode.disconnect();
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
    this.cacheProcessedBuffer(this.reverseBuffers, key, reversed);
    return reversed;
  }

  syncLoop(
    orbitId: string, planetId: string, barId: string, inside: boolean,
    audioTime: number, planetVolume: number, planetAudioPan: number,
    tapeRate: number, userSpeed: number, pitchCents: number,
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
      const renderWindow = current.processedWindow;
      const rate = current.source.buffer?.sampleRate ?? 1;
      const contentStart = renderWindow ? (renderWindow.contentStartFrame - renderWindow.bufferStartFrame) / rate : sampleStart / speedDivisor;
      const contentEnd = renderWindow ? (renderWindow.contentEndFrame - renderWindow.bufferStartFrame) / rate : sampleEnd / speedDivisor;
      const windowStart = Math.min(Math.max(contentStart, 0), bufferDuration);
      const windowEnd = Math.min(Math.max(contentEnd, windowStart), bufferDuration);
      const loopStart = reverse ? bufferDuration - windowEnd : windowStart;
      const loopEnd = reverse ? bufferDuration - windowStart : windowEnd;
      // Restart when the window (or direction) changes so playback reseeks to the sample
      // position the planet now maps to. Mutating loopStart/loopEnd in place would keep
      // playing continuously without reflecting the new trim, so a restart is intended.
      if (current.isReverse !== reverse || current.loopWindowStart !== loopStart || current.loopWindowEnd !== loopEnd) {
        this.stopPlayback(key);
      } else {
        current.planetGainNode.gain.setValueAtTime(planetVolume, this.getContext().currentTime);
        current.source.playbackRate.setValueAtTime(tapeRate, this.getContext().currentTime);
        return;
      }
    }
    const created = this.createPlayback(
      key, orbitId, planetId, barId, "loop", planetVolume, planetAudioPan,
      tapeRate, userSpeed, pitchCents, reverse, sampleStart, sampleEnd
    );
    if (!created) return;
    // Match commit 3e8ee22 exactly when the user speed is unchanged:
    // the loop bar maps directly to the original audio timeline.
    // Bound playback to the trimmed window so only that slice repeats instead of the
    // audio running past sampleEnd into the rest of the sample. As the planet wraps
    // past angle 0, the native loop wraps sampleEnd -> sampleStart in step.
    const bufferDuration = created.buffer.duration;
    const renderWindow = created.playback.processedWindow;
    const localBase = renderWindow ? renderWindow.bufferStartFrame / created.buffer.sampleRate : 0;
    const contentStart = renderWindow ? (renderWindow.contentStartFrame - renderWindow.bufferStartFrame) / created.buffer.sampleRate : sampleStart / speedDivisor;
    const contentEnd = renderWindow ? (renderWindow.contentEndFrame - renderWindow.bufferStartFrame) / created.buffer.sampleRate : sampleEnd / speedDivisor;
    const windowStart = Math.min(Math.max(contentStart, 0), bufferDuration);
    const windowEnd = Math.min(Math.max(contentEnd, windowStart), bufferDuration);
    const localAbsolute = audioTime / speedDivisor - localBase;
    const mappedTime = reverse ? bufferDuration - localAbsolute : localAbsolute;
    const safeOffset = Math.min(Math.max(mappedTime, 0), Math.max(0, created.buffer.duration - .001));
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
  }

  triggerSequence(
    orbitId: string, planetId: string, barId: string, planetVolume: number, planetAudioPan: number,
    tapeRate: number, pitchCents: number, reverse: boolean,
    retriggerMode: SequenceRetriggerMode, sampleStart = 0, sampleEnd = Infinity
  ) {
    if (retriggerMode === "ignore-until-end" && this.hasActiveSequencePlayback(orbitId)) return;
    if (retriggerMode === "cut-previous") this.stopActiveSequencePlaybacksForOrbit(orbitId);
    const id = `sequence:${planetId}:${barId}:${crypto.randomUUID()}`;
    const created = this.createPlayback(
      id, orbitId, planetId, barId, "sequence", planetVolume, planetAudioPan,
      tapeRate, 1, pitchCents, reverse, sampleStart, sampleEnd
    );
    if (created) {
      // Play only the trimmed window. Pitch shifting preserves length, so the
      // sample-time bounds map straight onto the (possibly reversed) buffer.
      const bufferDuration = created.buffer.duration;
      const renderWindow = created.playback.processedWindow;
      const localBase = renderWindow ? renderWindow.bufferStartFrame / created.buffer.sampleRate : 0;
      const start = Math.min(Math.max(sampleStart - localBase, 0), bufferDuration);
      const end = Math.min(Math.max(sampleEnd - localBase, start), bufferDuration);
      const duration = Math.max(0.001, end - start);
      const offset = reverse ? Math.max(0, bufferDuration - end) : start;
      created.playback.source.start(created.context.currentTime, offset, duration);
    }
  }

  private stopPlayback(id: string) {
    const playback = this.active.get(id);
    if (!playback) return;
    this.active.delete(id);
    try { playback.source.stop(); } catch { /* already stopped */ }
    try { playback.planetGainNode.disconnect(); } catch { /* disconnected */ }
    playback.planetPanNode.disconnect();
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
      if (playback.planetId === planetId) playback.planetGainNode.gain.setValueAtTime(volume, context.currentTime);
    }
  }

  setOrbitAudioPan(orbitId: string, audioPan: number) {
    this.orbitPanValues.set(orbitId, audioPan);
    this.orbitRuntimes.get(orbitId)?.panNode.setPan(audioPan);
  }

  setActivePlanetAudioPan(planetId: string, audioPan: number) {
    for (const playback of this.active.values()) {
      if (playback.planetId === planetId) playback.planetPanNode.setPan(audioPan);
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

  hasProcessedBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    return (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) ||
      this.processedBuffers.has(this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd)) ||
      this.coldProcessedBuffers.has(this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd));
  }

  hasPitchBuffer(orbitId: string, planetId: string, pitchCents: number) {
    return this.hasProcessedBuffer(orbitId, planetId, 1, pitchCents);
  }

  async processPitchBuffer(orbitId: string, planetId: string, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    return this.processPlanetBuffer(orbitId, planetId, 1, pitchCents, sampleStart, sampleEnd);
  }

  async processPlanetBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (this.hasProcessedBuffer(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd)) return;
    const window = this.processingWindow(orbitId, normalizedSpeed, sampleStart, sampleEnd);
    const key = this.processedBufferKey(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd);
    const inFlight = this.processingPromises.get(key);
    if (inFlight) return inFlight;
    const scheduled = this.scheduleDspRender(() => this.renderPlanetBuffer(key, orbitId, normalizedSpeed, roundedPitch, window));
    this.processingPromises.set(key, scheduled);
    try {
      await scheduled;
    } finally {
      if (this.processingPromises.get(key) === scheduled) this.processingPromises.delete(key);
    }
  }

  private async renderPlanetBuffer(key: string, orbitId: string, normalizedSpeed: number, roundedPitch: number, renderWindow: ProcessingWindow) {
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
    // Keep only the guarded physical window. Full rendering remains necessary
    // for SoundTouch state and global peak normalization, but it is transient.
    const physical = this.getContext().createBuffer(
      output.numberOfChannels, renderWindow.bufferEndFrame - renderWindow.bufferStartFrame, output.sampleRate
    );
    for (let channel = 0; channel < output.numberOfChannels; channel++) {
      physical.copyToChannel(output.getChannelData(channel).subarray(renderWindow.bufferStartFrame, renderWindow.bufferEndFrame), channel);
    }
    this.cacheProcessedBuffer(this.processedBuffers, key, physical);
    this.processedWindows.set(key, renderWindow);
  }

  private async loadRecordingProcessor(context: AudioContext) {
    const cached = this.recordingModuleLoads.get(context);
    if (cached) return cached;
    const load = (async () => {
      const blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(blobUrl);
        return;
      } catch (blobError) {
        try {
          // Sandboxed Chromium normally accepts the Blob module. The emitted Vite
          // asset is a retry path for a restrictive Blob/CSP implementation.
          await context.audioWorklet.addModule(recorderProcessorAssetUrl);
          return;
        } catch (assetError) {
          throw new Error(`AudioWorklet module could not load from Blob or asset URL: ${String(blobError)}; ${String(assetError)}`);
        }
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })();
    this.recordingModuleLoads.set(context, load);
    try {
      await load;
    } catch (error) {
      // A failed module registration is retryable on the next start attempt.
      this.recordingModuleLoads.delete(context);
      throw error;
    }
  }

  private async ensureRecordingNode() {
    if (this.recordingNode) return this.recordingNode;
    const context = this.getContext();
    if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
      throw new Error("AudioWorklet recording is not supported on this system.");
    }
    await this.loadRecordingProcessor(context);
    const node = new AudioWorkletNode(context, "orbitronica-pcm-capture", {
      channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2]
    });
    const pull = context.createGain();
    pull.gain.value = 0;
    this.masterPanner!.connect(node);
    node.connect(pull);
    pull.connect(context.destination);
    node.port.onmessage = ({ data }) => this.handleRecordingMessage(data as Record<string, unknown>);
    // A processor error can arrive after this disconnected node has been replaced.
    // Never let a stale node tear down a new recording session.
    node.onprocessorerror = () => {
      if (this.recordingNode === node) this.failRecording(new Error("AudioWorklet recording failed."));
    };
    this.recordingNode = node;
    this.recordingPull = pull;
    return node;
  }

  private handleRecordingMessage(message: Record<string, unknown>) {
    const session = this.recordingSession;
    if (!session || message.recordingId !== session.id) return;
    if (message.type === "chunk" && message.left instanceof ArrayBuffer && message.right instanceof ArrayBuffer) {
      session.chunks[0].push(new Float32Array(message.left));
      session.chunks[1].push(new Float32Array(message.right));
    } else if (message.type === "started" && session.state === "starting") {
      window.clearTimeout(session.timeout);
      session.state = "recording";
      session.resolve?.();
    } else if (message.type === "stopped" && session.state === "stopping") {
      window.clearTimeout(session.timeout);
      const channels = session.chunks.map((parts) => this.joinRecordingChunks(parts));
      this.recordingSession = null;
      const result: RecordedPcm = { channels, sampleRate: this.getContext().sampleRate };
      session.result = result;
      session.resolve?.();
    }
  }

  private joinRecordingChunks(parts: Float32Array[]) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const joined = new Float32Array(length);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return joined;
  }

  private failRecording(error: Error) {
    const session = this.recordingSession;
    if (session) { window.clearTimeout(session.timeout); this.recordingSession = null; session.reject?.(error); }
    try { this.recordingNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.recordingPull?.disconnect(); } catch { /* already disconnected */ }
    this.recordingNode = null;
    this.recordingPull = null;
  }

  private waitForRecordingAck(session: RecordingSession) {
    return new Promise<void>((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      session.timeout = window.setTimeout(() => this.failRecording(new Error("AudioWorklet recording acknowledgement timed out.")), 5000);
    });
  }

  async startRecording(): Promise<void> {
    if (this.recordingSession) throw new Error("A recording operation is already active.");
    const session: RecordingSession = { id: ++this.nextRecordingId, state: "starting", chunks: [[], []] };
    this.recordingSession = session;
    try {
      const node = await this.ensureRecordingNode();
      const acknowledgement = this.waitForRecordingAck(session);
      node.port.postMessage({ type: "start", recordingId: session.id });
      await acknowledgement;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (this.recordingSession === session) this.failRecording(error);
      throw error;
    }
  }

  async stopRecording(): Promise<RecordedPcm> {
    const session = this.recordingSession;
    if (!session || session.state !== "recording" || !this.recordingNode) throw new Error("No recording is active.");
    session.state = "stopping";
    const acknowledgement = this.waitForRecordingAck(session);
    this.recordingNode.port.postMessage({ type: "stop", recordingId: session.id });
    await acknowledgement;
    const result = session.result;
    if (!result) throw new Error("AudioWorklet stopped without captured audio.");
    return result;
  }

  removeOrbit(orbitId: string) {
    this.stopAllActivePlaybacksForOrbit(orbitId);
    this.buffers.delete(orbitId);
    this.waveformPeaks.delete(orbitId);
    this.publishWaveformPeaks(orbitId, null);
    for (const key of [...this.processedBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) { this.processedBuffers.delete(key); this.coldProcessedBuffers.delete(key); this.processedWindows.delete(key); }
    }
    for (const key of [...this.coldProcessedBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) { this.coldProcessedBuffers.delete(key); this.processedWindows.delete(key); }
    }
    for (const key of [...this.reverseBuffers.keys()]) {
      if (key.startsWith(`${orbitId}:`)) this.reverseBuffers.delete(key);
    }
    this.rawFiles.delete(orbitId);
    const rack = this.orbitWamRacks.get(orbitId);
    if (rack) { this.orbitWamRacks.delete(orbitId); void rack.disposeAll(); }
    const runtime = this.orbitRuntimes.get(orbitId);
    if (runtime) {
      try { runtime.input.disconnect(); } catch { /* already disconnected */ }
      runtime.panNode.disconnect();
      try { runtime.gainNode.disconnect(); } catch { /* already disconnected */ }
    }
    this.orbitRuntimes.delete(orbitId);
    this.orbitPanValues.delete(orbitId);
  }

  pruneOrbits(retainedOrbitIds: ReadonlySet<string>) {
    const candidates = new Set([
      ...this.buffers.keys(), ...this.rawFiles.keys(), ...this.orbitRuntimes.keys(), ...this.waveformPeaks.keys()
    ]);
    for (const orbitId of candidates) {
      if (!retainedOrbitIds.has(orbitId)) this.removeOrbit(orbitId);
    }
  }
}

export const audioEngine = new AudioEngine();
