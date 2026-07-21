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
  planetAudioPan: number;
  mode: "loop" | "sequence";
  isReverse: boolean;
  processedWindow?: ProcessingWindow;
  loopWindowStart?: number;
  loopWindowEnd?: number;
  playbackPhaseOffset?: number;
  playbackPhaseAt?: number;
};

type ActiveLoopSnapshot = {
  readonly id: string;
  readonly orbitId: string;
  readonly planetId: string;
  readonly barId: string;
  readonly buffer: AudioBuffer;
  readonly planetVolume: number;
  readonly planetAudioPan: number;
  readonly tapeRate: number;
  readonly isReverse: boolean;
  readonly processedWindow?: ProcessingWindow;
  readonly loop: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly resumeOffset: number;
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

export type AudioCacheDiagnostics = {
  readonly sourceGenerations: Readonly<Record<string, number>>;
  readonly processedKeys: readonly string[];
  readonly reverseKeys: readonly string[];
  readonly coldKeys: readonly string[];
  readonly dspScheduler: {
    readonly renderAttempts: number;
    readonly restartedFrames: number;
  };
  readonly cache: {
    readonly pcm16Enabled: boolean;
    readonly hotBytes: number;
    readonly hotEntries: number;
    readonly hotByteBudget: number;
    readonly hotEntryBudget: number;
    readonly protectedHotOverageBytes: number;
    readonly protectedHotOverageEntries: number;
    readonly coldBytes: number;
    readonly coldEntries: number;
    readonly coldByteBudget: number;
    readonly coldEntryBudget: number;
  };
};

export type AudioCacheSmokeDiagnostics = AudioCacheDiagnostics & {
  readonly activePlaybackCount: number;
  readonly scheduler: {
    readonly running: number;
    readonly pendingJobs: number;
    readonly queueDepth: Readonly<Record<DspRenderPriority, number>>;
  };
};

export type AudioCacheSmokeAdapter = {
  readonly registerFixtureBuffer: (orbitId: string, buffer: AudioBuffer, volume: number) => void;
  readonly setCachePolicy: (policy?: Partial<CachePolicy>) => void;
  readonly dropHotProcessedBuffer: (request: ProcessedBufferRequest) => boolean;
  readonly getDiagnostics: () => AudioCacheSmokeDiagnostics;
};

export type CachePolicy = {
  readonly pcm16Enabled: boolean;
  readonly hotByteBudget: number;
  readonly hotEntryBudget: number;
  readonly coldByteBudget: number;
  readonly coldEntryBudget: number;
};

type PlaybackBufferResolution =
  | { status: "ready"; buffer: AudioBuffer; key: string; usingProcessedBuffer: boolean; descriptor: ProcessedBufferDescriptor }
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

export type ProcessedBufferRequest = {
  readonly orbitId: string;
  readonly planetId: string;
  readonly speed: number;
  readonly pitchCents: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly direction: "forward" | "reverse";
};

export type DspRenderPriority = "playback" | "selected" | "background";

export type EnsureProcessedBufferOptions = {
  readonly ownerId: string;
  readonly priority?: DspRenderPriority;
  readonly signal?: AbortSignal;
};

export type PlaybackRenderScope = {
  readonly ownerId: string;
  readonly signal?: AbortSignal;
};

type SourceLease = {
  readonly orbitId: string;
  readonly generation: number;
  readonly buffer: AudioBuffer;
};

type ProcessedBufferDescriptor = {
  readonly request: ProcessedBufferRequest;
  readonly lease: SourceLease;
  readonly window: ProcessingWindow;
  readonly key: string;
};

type DspConsumer = {
  readonly ownerId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  priority: DspRenderPriority;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
};

type DspJob = {
  readonly key: string;
  readonly enqueueSequence: number;
  readonly descriptor: ProcessedBufferDescriptor;
  readonly consumers: Map<string, DspConsumer>;
  state: "queued" | "running" | "finished";
  priority: DspRenderPriority;
  cancelRequested: boolean;
  preemptRequested: boolean;
  sourceInvalidated: boolean;
  reverseRequested: boolean;
};

class DspRenderPreemptedError extends Error {
  constructor() {
    super("DSP render was preempted by higher-priority work.");
    this.name = "DspRenderPreemptedError";
  }
}

type CacheEntry = {
  readonly request: ProcessedBufferRequest;
  readonly lease: SourceLease;
  readonly window: ProcessingWindow;
  readonly direction: "forward" | "reverse";
  readonly byteLength: number;
};

type CachedAudioEntry = {
  readonly buffer: AudioBuffer;
  readonly entry: CacheEntry;
};

type CachedColdEntry = {
  readonly pcm: ColdPcm16;
  readonly entry: CacheEntry;
};

type ResidencyEntry = {
  readonly key: string;
  readonly lease: SourceLease;
  readonly request: ProcessedBufferRequest;
};

type AcquiredResidency = {
  readonly ownerId: string;
  readonly entries: Map<string, ResidencyEntry>;
};

type ResidencySnapshot = {
  readonly permanent: ReadonlyMap<string, readonly ProcessedBufferRequest[]>;
  readonly acquired: ReadonlyMap<number, { readonly ownerId: string; readonly requests: readonly ProcessedBufferRequest[] }>;
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
  private static nextSourceGeneration = 0;
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sourceLeases = new Map<string, SourceLease>();
  private waveformPeaks = new Map<string, Float32Array>();
  private waveformPeakPromises = new WeakMap<AudioBuffer, Promise<Float32Array>>();
  private waveformListeners = new Set<WaveformListener>();
  private readonly waveformResolution = 1024;
  private processedBuffers = new Map<string, AudioBuffer>();
  private coldProcessedBuffers = new Map<string, ColdPcm16>();
  private processedEntries = new Map<string, CacheEntry>();
  private coldProcessedEntries = new Map<string, CacheEntry>();
  private reverseEntries = new Map<string, CacheEntry>();
  private permanentResidencies = new Map<string, Map<string, ResidencyEntry>>();
  private acquiredResidencies = new Map<number, AcquiredResidency>();
  private nextResidencyLease = 0;
  /** Startup-only opt-in; production defaults to Float32 cache behavior. */
  private readonly pcm16ColdCacheEnabled = new URLSearchParams(globalThis.location?.search ?? "").get("pcm16ColdCache") === "1";
  private cachePolicyOverride: CachePolicy | undefined;
  private hotRecency = new Map<string, "forward" | "reverse">();
  /** Physical cache buffers are guarded; this preserves their logical output coordinates. */
  private processedWindows = new Map<string, ProcessingWindow>();
  private reverseBuffers = new Map<string, AudioBuffer>();
  private dspJobs = new Map<string, DspJob>();
  private dspJobsByOwner = new Map<string, string>();
  private dspRenderQueues: Record<DspRenderPriority, DspJob[]> = {
    playback: [], selected: [], background: []
  };
  private terminalDspPriority: DspRenderPriority | null = null;
  private consecutiveTerminalDspJobs = 0;
  private nextDspJobSequence = 0;
  private dspRenderAttempts = 0;
  private dspRestartedFrames = 0;
  private activeDspRenders = 0;
  // Each entry is a fully decoded AudioBuffer (often several MB for a long sample), and a
  // new entry is produced per distinct (speed, pitch) tuple as the user sweeps those
  // controls. Left unbounded this grows without limit; 64 entries per cache keeps steady
  // memory bounded to a comfortably large recent working set while still amortizing repeat
  // requests. Eviction is least-recently-used, and a buffer currently backing an active
  // (including looping) playback is never evicted regardless of recency.
  private static readonly PROCESSED_BUFFER_CACHE_CAP = 64;
  private static readonly PCM16_HOT_BYTE_BUDGET = 64 * 1024 * 1024;
  private static readonly PCM16_HOT_ENTRY_BUDGET = 64;
  private static readonly PCM16_COLD_BYTE_BUDGET = 128 * 1024 * 1024;
  private static readonly PCM16_COLD_ENTRY_BUDGET = 128;
  private static readonly MAX_CONCURRENT_DSP_RENDERS = 1;
  private static readonly HIGHER_PRIORITY_TERMINAL_DISPATCH_BUDGET = 8;
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
    const oldProcessed = this.snapshotCachedAudioEntries(this.processedBuffers, this.processedEntries);
    const oldCold = this.snapshotCachedColdEntries();
    const oldReverse = this.snapshotCachedAudioEntries(this.reverseBuffers, this.reverseEntries);
    const oldResidencies = this.snapshotResidencies();
    const oldActiveLoops = this.snapshotActiveLoops();
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
      this.restoreResidencies(oldResidencies);
      this.restoreCachedEntries(oldProcessed, oldCold, oldReverse);
      this.restoreActiveLoops(oldActiveLoops);
      this.enforceCachePolicies();
      throw error;
    }
  }

  private registerBuffer(orbitId: string, buffer: AudioBuffer, volume: number) {
    const context = this.getContext();
    this.invalidateDspJobsForOrbit(orbitId);
    this.sourceLeases.set(orbitId, {
      orbitId,
      generation: ++AudioEngine.nextSourceGeneration,
      buffer
    });
    this.clearOrbitResidencies(orbitId);
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

  private setCachePolicyForTesting(policy?: Partial<CachePolicy>) {
    if (!policy) {
      this.cachePolicyOverride = undefined;
    } else {
      const base = this.cachePolicy();
      this.cachePolicyOverride = {
        pcm16Enabled: policy.pcm16Enabled ?? base.pcm16Enabled,
        hotByteBudget: policy.hotByteBudget ?? base.hotByteBudget,
        hotEntryBudget: policy.hotEntryBudget ?? base.hotEntryBudget,
        coldByteBudget: policy.coldByteBudget ?? base.coldByteBudget,
        coldEntryBudget: policy.coldEntryBudget ?? base.coldEntryBudget
      };
    }
    this.enforceCachePolicies();
  }

  private cachePolicy(): CachePolicy {
    return this.cachePolicyOverride ?? {
      pcm16Enabled: this.pcm16ColdCacheEnabled,
      hotByteBudget: AudioEngine.PCM16_HOT_BYTE_BUDGET,
      hotEntryBudget: AudioEngine.PCM16_HOT_ENTRY_BUDGET,
      coldByteBudget: AudioEngine.PCM16_COLD_BYTE_BUDGET,
      coldEntryBudget: AudioEngine.PCM16_COLD_ENTRY_BUDGET
    };
  }

  private hotCacheResidency() {
    const buffers = new Set<AudioBuffer>([...this.processedBuffers.values(), ...this.reverseBuffers.values()]);
    for (const buffer of this.activePlaybackBuffers()) buffers.add(buffer);
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    return { bytes, entries: buffers.size };
  }

  private coldCacheResidency() {
    let bytes = 0;
    for (const pcm of this.coldProcessedBuffers.values()) {
      for (const channel of pcm.channels) bytes += channel.byteLength;
    }
    return { bytes, entries: this.coldProcessedBuffers.size };
  }

  getAudioCacheDiagnostics(): AudioCacheDiagnostics {
    const sourceGenerations: Record<string, number> = {};
    for (const [orbitId, lease] of this.sourceLeases) sourceGenerations[orbitId] = lease.generation;
    const policy = this.cachePolicy();
    const hot = this.hotCacheResidency();
    const cold = this.coldCacheResidency();
    return {
      sourceGenerations,
      processedKeys: [...this.processedBuffers.keys()].sort(),
      reverseKeys: [...this.reverseBuffers.keys()].sort(),
      coldKeys: [...this.coldProcessedBuffers.keys()].sort(),
      dspScheduler: {
        renderAttempts: this.dspRenderAttempts,
        restartedFrames: this.dspRestartedFrames
      },
      cache: {
        pcm16Enabled: policy.pcm16Enabled,
        hotBytes: hot.bytes,
        hotEntries: hot.entries,
        hotByteBudget: policy.hotByteBudget,
        hotEntryBudget: policy.hotEntryBudget,
        protectedHotOverageBytes: policy.pcm16Enabled ? Math.max(0, hot.bytes - policy.hotByteBudget) : 0,
        protectedHotOverageEntries: policy.pcm16Enabled ? Math.max(0, hot.entries - policy.hotEntryBudget) : 0,
        coldBytes: cold.bytes,
        coldEntries: cold.entries,
        coldByteBudget: policy.coldByteBudget,
        coldEntryBudget: policy.coldEntryBudget
      }
    };
  }

  getAudioCacheSmokeAdapter(): AudioCacheSmokeAdapter {
    return {
      registerFixtureBuffer: (orbitId, buffer, volume) => this.registerBuffer(orbitId, buffer, volume),
      setCachePolicy: (policy) => this.setCachePolicyForTesting(policy),
      dropHotProcessedBuffer: (request) => {
        const descriptor = this.describeProcessedBuffer(request);
        if (!this.processedBuffers.has(descriptor.key)) return false;
        this.removeHotProcessedEntry(descriptor.key);
        this.enforceCachePolicies();
        return true;
      },
      getDiagnostics: () => ({
        ...this.getAudioCacheDiagnostics(),
        activePlaybackCount: this.active.size,
        scheduler: {
          running: this.activeDspRenders,
          pendingJobs: this.dspJobs.size,
          queueDepth: {
            playback: this.dspRenderQueues.playback.length,
            selected: this.dspRenderQueues.selected.length,
            background: this.dspRenderQueues.background.length
          }
        }
      })
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

  private currentSourceLease(orbitId: string): SourceLease | undefined {
    const buffer = this.buffers.get(orbitId);
    if (!buffer) return undefined;
    const existing = this.sourceLeases.get(orbitId);
    if (existing?.buffer === buffer) return existing;
    const lease = { orbitId, generation: ++AudioEngine.nextSourceGeneration, buffer };
    this.sourceLeases.set(orbitId, lease);
    return lease;
  }

  private processingWindowForBuffer(original: AudioBuffer, speed: number, sampleStart = 0, sampleEnd = Infinity): ProcessingWindow {
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

  private processingWindow(orbitId: string, speed: number, sampleStart = 0, sampleEnd = Infinity): ProcessingWindow {
    const lease = this.currentSourceLease(orbitId);
    if (!lease) throw new Error("Audio buffer is unavailable.");
    return this.processingWindowForBuffer(lease.buffer, speed, sampleStart, sampleEnd);
  }

  private processedBufferRequest(
    orbitId: string, planetId: string, speed: number, pitchCents: number,
    sampleStart = 0, sampleEnd = Infinity, direction: "forward" | "reverse" = "forward"
  ): ProcessedBufferRequest {
    return {
      orbitId,
      planetId,
      speed: this.normalizedSpeed(speed),
      pitchCents: Math.round(pitchCents),
      sampleStart,
      sampleEnd,
      direction
    };
  }

  private describeProcessedBuffer(request: ProcessedBufferRequest): ProcessedBufferDescriptor {
    const lease = this.currentSourceLease(request.orbitId);
    if (!lease) throw new Error("Audio buffer is unavailable.");
    const window = this.processingWindowForBuffer(lease.buffer, request.speed, request.sampleStart, request.sampleEnd);
    const baseKey = `${request.orbitId}:${request.planetId}:source=${lease.generation}:speed=${request.speed.toString()}:pitch=${request.pitchCents}:${window.sourceStartFrame}~${window.sourceEndFrame}`;
    return { request, lease, window, key: baseKey };
  }

  private processedBufferKey(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    return this.describeProcessedBuffer(this.processedBufferRequest(orbitId, planetId, speed, pitchCents, sampleStart, sampleEnd)).key;
  }

  private clearOrbitProcessedCaches(orbitId: string) {
    for (const key of new Set([...this.processedBuffers.keys(), ...this.coldProcessedBuffers.keys()])) if (key.startsWith(`${orbitId}:`)) this.removeProcessedEntry(key);
    for (const key of [...this.reverseBuffers.keys()]) if (key.startsWith(`${orbitId}:`)) this.removeReverseEntry(key);
  }

  private residencyEntriesFor(requests: readonly ProcessedBufferRequest[]): Map<string, ResidencyEntry> {
    const entries = new Map<string, ResidencyEntry>();
    for (const request of requests) {
      if (!this.buffers.has(request.orbitId)) continue;
      const semantic = this.processedBufferRequest(
        request.orbitId, request.planetId, request.speed, request.pitchCents,
        request.sampleStart, request.sampleEnd, request.direction
      );
      const neutral = Math.abs(semantic.speed - 1) < .0001 && semantic.pitchCents === 0;
      if (neutral && semantic.direction === "forward") continue;
      const descriptor = neutral
        ? this.describeProcessedBuffer(this.processedBufferRequest(
          semantic.orbitId, semantic.planetId, 1, 0, 0, Infinity, "reverse"
        ))
        : this.describeProcessedBuffer(semantic);
      if (!neutral) entries.set(descriptor.key, { key: descriptor.key, lease: descriptor.lease, request: semantic });
      if (semantic.direction === "reverse") {
        const reverseKey = `${descriptor.key}:reverse`;
        entries.set(reverseKey, { key: reverseKey, lease: descriptor.lease, request: semantic });
      }
    }
    return entries;
  }

  private currentResidencyEntry(entry: ResidencyEntry): boolean {
    const current = this.currentSourceLease(entry.lease.orbitId);
    return current?.generation === entry.lease.generation && current.buffer === entry.lease.buffer;
  }

  private isResidencyKeyProtected(key: string): boolean {
    const ownsCurrentKey = (entries: Map<string, ResidencyEntry>) => {
      const entry = entries.get(key);
      return entry !== undefined && this.currentResidencyEntry(entry);
    };
    for (const entries of this.permanentResidencies.values()) if (ownsCurrentKey(entries)) return true;
    for (const residency of this.acquiredResidencies.values()) if (ownsCurrentKey(residency.entries)) return true;
    return false;
  }

  private clearOrbitResidencies(orbitId: string) {
    const removeOrbitEntries = (entries: Map<string, ResidencyEntry>) => {
      for (const [key, entry] of entries) if (entry.lease.orbitId === orbitId) entries.delete(key);
    };
    for (const entries of this.permanentResidencies.values()) removeOrbitEntries(entries);
    for (const residency of this.acquiredResidencies.values()) removeOrbitEntries(residency.entries);
  }

  replacePermanentResidency(ownerId: string, requests: readonly ProcessedBufferRequest[]) {
    this.permanentResidencies.set(ownerId, this.residencyEntriesFor(requests));
    this.enforceCachePolicies();
  }

  acquireResidency(ownerId: string, requests: readonly ProcessedBufferRequest[]): () => void {
    const leaseId = ++this.nextResidencyLease;
    this.acquiredResidencies.set(leaseId, { ownerId, entries: this.residencyEntriesFor(requests) });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.acquiredResidencies.delete(leaseId);
      this.enforceCachePolicies();
    };
  }

  private snapshotResidencies(): ResidencySnapshot {
    const requests = (entries: ReadonlyMap<string, ResidencyEntry>) =>
      [...entries.values()].map((entry) => ({ ...entry.request }));
    return {
      permanent: new Map([...this.permanentResidencies].map(([ownerId, entries]) => [ownerId, requests(entries)])),
      acquired: new Map([...this.acquiredResidencies].map(([leaseId, residency]) => [leaseId, {
        ownerId: residency.ownerId,
        requests: requests(residency.entries)
      }]))
    };
  }

  private restoreResidencies(snapshot: ResidencySnapshot) {
    this.permanentResidencies.clear();
    for (const [ownerId, requests] of snapshot.permanent) {
      this.permanentResidencies.set(ownerId, this.residencyEntriesFor(requests));
    }
    this.acquiredResidencies.clear();
    for (const [leaseId, residency] of snapshot.acquired) {
      this.acquiredResidencies.set(leaseId, {
        ownerId: residency.ownerId,
        entries: this.residencyEntriesFor(residency.requests)
      });
    }
  }

  private snapshotActiveLoops(): ActiveLoopSnapshot[] {
    const snapshots: ActiveLoopSnapshot[] = [];
    for (const playback of this.active.values()) {
      const buffer = playback.source.buffer;
      if (playback.mode !== "loop" || !buffer) continue;
      snapshots.push({
        id: playback.id,
        orbitId: playback.orbitId,
        planetId: playback.planetId,
        barId: playback.barId,
        buffer,
        planetVolume: playback.planetGainNode.gain.value,
        planetAudioPan: playback.planetAudioPan,
        tapeRate: playback.source.playbackRate.value,
        isReverse: playback.isReverse,
        processedWindow: playback.processedWindow,
        loop: playback.source.loop,
        loopStart: playback.source.loopStart,
        loopEnd: playback.source.loopEnd,
        resumeOffset: this.advanceLoopPlaybackPhase(playback, this.getContext().currentTime)
      });
    }
    return snapshots;
  }

  private restoreActiveLoops(snapshots: readonly ActiveLoopSnapshot[]) {
    const context = this.getContext();
    for (const snapshot of snapshots) {
      const orbitRuntime = this.orbitRuntimes.get(snapshot.orbitId);
      if (!orbitRuntime || !this.buffers.has(snapshot.orbitId)) continue;
      const source = context.createBufferSource();
      const planetGain = context.createGain();
      const planetPanNode = createFLStylePanNode(context, snapshot.buffer.numberOfChannels, snapshot.planetAudioPan);
      source.buffer = snapshot.buffer;
      source.playbackRate.value = snapshot.tapeRate;
      planetGain.gain.value = snapshot.planetVolume;
      source.connect(planetPanNode.input);
      planetPanNode.output.connect(planetGain);
      planetGain.connect(orbitRuntime.input);
      const playback: ActivePlayback = {
        id: snapshot.id,
        orbitId: snapshot.orbitId,
        planetId: snapshot.planetId,
        barId: snapshot.barId,
        source,
        planetGainNode: planetGain,
        planetPanNode,
        planetAudioPan: snapshot.planetAudioPan,
        mode: "loop",
        isReverse: snapshot.isReverse,
        processedWindow: snapshot.processedWindow,
        loopWindowStart: snapshot.loopStart,
        loopWindowEnd: snapshot.loopEnd
      };
      this.active.set(snapshot.id, playback);
      source.onended = () => {
        if (this.active.get(snapshot.id)?.source === source) this.active.delete(snapshot.id);
        this.enforceCachePolicies();
        try { planetGain.disconnect(); } catch {}
        planetPanNode.disconnect();
      };
      if (snapshot.loop && snapshot.loopEnd - snapshot.loopStart > .001) {
        source.loop = true;
        source.loopStart = snapshot.loopStart;
        source.loopEnd = snapshot.loopEnd;
      }
      playback.playbackPhaseOffset = snapshot.resumeOffset;
      playback.playbackPhaseAt = context.currentTime;
      source.start(context.currentTime, snapshot.resumeOffset);
    }
  }

  private advanceLoopPlaybackPhase(playback: ActivePlayback, now: number) {
    const bufferDuration = playback.source.buffer?.duration ?? 0;
    const startOffset = playback.playbackPhaseOffset ?? playback.source.loopStart;
    const startAt = playback.playbackPhaseAt ?? now;
    const elapsed = Math.max(0, now - startAt) * playback.source.playbackRate.value;
    let offset = startOffset + elapsed;
    if (playback.source.loop && playback.source.loopEnd > playback.source.loopStart) {
      const span = playback.source.loopEnd - playback.source.loopStart;
      offset = playback.source.loopStart + ((offset - playback.source.loopStart) % span + span) % span;
    } else {
      offset = Math.min(Math.max(offset, 0), Math.max(0, bufferDuration - .001));
    }
    playback.playbackPhaseOffset = offset;
    playback.playbackPhaseAt = now;
    return offset;
  }

  private cacheEntryFor(descriptor: ProcessedBufferDescriptor, direction: "forward" | "reverse", buffer: AudioBuffer, byteLength = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT): CacheEntry {
    return {
      request: { ...descriptor.request, direction },
      lease: descriptor.lease,
      window: descriptor.window,
      direction,
      byteLength
    };
  }

  private currentCacheEntry(entry: CacheEntry | undefined): boolean {
    if (!entry) return false;
    const current = this.currentSourceLease(entry.lease.orbitId);
    return current?.generation === entry.lease.generation && current.buffer === entry.lease.buffer;
  }

  private removeProcessedEntry(key: string) {
    this.processedBuffers.delete(key);
    this.coldProcessedBuffers.delete(key);
    this.processedEntries.delete(key);
    this.coldProcessedEntries.delete(key);
    this.processedWindows.delete(key);
    this.hotRecency.delete(key);
  }

  private removeReverseEntry(key: string) {
    this.reverseBuffers.delete(key);
    this.reverseEntries.delete(key);
    this.hotRecency.delete(key);
  }

  private removeHotProcessedEntry(key: string) {
    this.processedBuffers.delete(key);
    this.hotRecency.delete(key);
    if (!this.coldProcessedBuffers.has(key)) {
      this.processedEntries.delete(key);
      this.processedWindows.delete(key);
    }
  }

  private removeColdProcessedEntry(key: string) {
    this.coldProcessedBuffers.delete(key);
    this.coldProcessedEntries.delete(key);
    if (!this.processedBuffers.has(key)) {
      this.processedEntries.delete(key);
      this.processedWindows.delete(key);
    }
  }

  private snapshotCachedAudioEntries(buffers: ReadonlyMap<string, AudioBuffer>, entries: ReadonlyMap<string, CacheEntry>): CachedAudioEntry[] {
    const snapshot: CachedAudioEntry[] = [];
    for (const [key, buffer] of buffers) {
      const entry = entries.get(key);
      if (entry) snapshot.push({ buffer, entry });
    }
    return snapshot;
  }

  private snapshotCachedColdEntries(): CachedColdEntry[] {
    const snapshot: CachedColdEntry[] = [];
    for (const [key, pcm] of this.coldProcessedBuffers) {
      const entry = this.coldProcessedEntries.get(key);
      if (entry) snapshot.push({ pcm, entry });
    }
    return snapshot;
  }

  private restoreCachedEntries(processed: readonly CachedAudioEntry[], cold: readonly CachedColdEntry[], reverse: readonly CachedAudioEntry[]) {
    const restoreAudio = (items: readonly CachedAudioEntry[], cache: Map<string, AudioBuffer>, direction: "forward" | "reverse") => {
      for (const item of items) {
        const current = this.currentSourceLease(item.entry.lease.orbitId);
        if (!current || current.buffer !== item.entry.lease.buffer) continue;
        const descriptor = this.describeProcessedBuffer(item.entry.request);
        if (direction === "forward") this.cacheProcessedBuffer(cache, descriptor.key, item.buffer, descriptor);
        else this.cacheProcessedBuffer(cache, `${descriptor.key}:reverse`, item.buffer, descriptor);
      }
    };
    restoreAudio(processed, this.processedBuffers, "forward");
    for (const item of cold) {
      const current = this.currentSourceLease(item.entry.lease.orbitId);
      if (!current || current.buffer !== item.entry.lease.buffer) continue;
      const descriptor = this.describeProcessedBuffer(item.entry.request);
      this.cacheColdProcessedBuffer(descriptor.key, item.pcm, descriptor, current.buffer);
    }
    restoreAudio(reverse, this.reverseBuffers, "reverse");
  }

  private abortError() {
    return new DOMException("DSP render was cancelled.", "AbortError");
  }

  private preemptError() {
    return new DspRenderPreemptedError();
  }

  private isPreemptError(error: unknown): error is DspRenderPreemptedError {
    return error instanceof DspRenderPreemptedError;
  }

  private dspPriorityRank(priority: DspRenderPriority): number {
    switch (priority) {
      case "playback": return 2;
      case "selected": return 1;
      case "background": return 0;
    }
  }

  private get dspRenderQueue(): readonly DspJob[] {
    return [...this.dspRenderQueues.playback, ...this.dspRenderQueues.selected, ...this.dspRenderQueues.background];
  }

  private removeDspJobFromQueues(job: DspJob) {
    for (const priority of ["playback", "selected", "background"] as const) {
      const queue = this.dspRenderQueues[priority];
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  private effectiveDspPriority(job: DspJob): DspRenderPriority {
    let priority: DspRenderPriority = "background";
    for (const consumer of job.consumers.values()) {
      if (this.dspPriorityRank(consumer.priority) > this.dspPriorityRank(priority)) priority = consumer.priority;
    }
    return priority;
  }

  private refreshDspJobPriority(job: DspJob) {
    const nextPriority = this.effectiveDspPriority(job);
    if (nextPriority === job.priority) return;
    job.priority = nextPriority;
    if (job.state === "queued") this.enqueueDspJob(job);
  }

  private enqueueDspJob(job: DspJob, front = false) {
    this.removeDspJobFromQueues(job);
    if (job.state !== "queued") return;
    const queue = this.dspRenderQueues[job.priority];
    if (front) queue.unshift(job); else queue.push(job);
    this.refreshRunningDspPreemption();
  }

  private highestQueuedDspPriority(): DspRenderPriority | undefined {
    for (const priority of ["playback", "selected", "background"] as const) {
      if (this.dspRenderQueues[priority].length > 0) return priority;
    }
    return undefined;
  }

  private refreshRunningDspPreemption() {
    const queuedPriority = this.highestQueuedDspPriority();
    for (const job of this.dspJobs.values()) {
      if (job.state !== "running") continue;
      job.preemptRequested = queuedPriority !== undefined && this.dspPriorityRank(queuedPriority) > this.dspPriorityRank(job.priority);
    }
  }

  private takeNextDspJob(): DspJob | undefined {
    const highest = this.highestQueuedDspPriority();
    if (!highest) return undefined;
    let job: DspJob | undefined;
    if (this.terminalDspPriority === highest && this.consecutiveTerminalDspJobs >= AudioEngine.HIGHER_PRIORITY_TERMINAL_DISPATCH_BUDGET) {
      const priorities: readonly DspRenderPriority[] = ["playback", "selected", "background"];
      const start = priorities.indexOf(highest) + 1;
      const starved = priorities.slice(start).flatMap((priority) => this.dspRenderQueues[priority]);
      job = starved.reduce<DspJob | undefined>((oldest, candidate) =>
        !oldest || candidate.enqueueSequence < oldest.enqueueSequence ? candidate : oldest, undefined);
      if (job) this.removeDspJobFromQueues(job);
    }
    job ??= this.dspRenderQueues[highest].shift();
    this.refreshRunningDspPreemption();
    return job;
  }

  private recordDspTerminalDispatch(job: DspJob, outcome: "success" | "error" | "cancelled") {
    if (outcome === "cancelled") return;
    if (this.terminalDspPriority === job.priority) this.consecutiveTerminalDspJobs++;
    else {
      this.terminalDspPriority = job.priority;
      this.consecutiveTerminalDspJobs = 1;
    }
  }

  private detachDspConsumer(job: DspJob, ownerId: string, reason: unknown = this.abortError()) {
    const consumer = job.consumers.get(ownerId);
    if (!consumer) return;
    job.consumers.delete(ownerId);
    if (this.dspJobsByOwner.get(ownerId) === job.key) this.dspJobsByOwner.delete(ownerId);
    if (consumer.abortListener && consumer.signal) consumer.signal.removeEventListener("abort", consumer.abortListener);
    consumer.reject(reason);
    this.refreshDspJobPriority(job);
    this.cancelUnobservedDspJob(job);
    this.refreshRunningDspPreemption();
  }

  private cancelUnobservedDspJob(job: DspJob) {
    if (job.consumers.size > 0 || job.state === "finished" || job.sourceInvalidated) return;
    job.cancelRequested = true;
    if (job.state !== "queued") return;
    this.finishDspJob(job, this.abortError(), "cancelled");
  }

  private markDspJobPreemptRequested(job: DspJob) {
    if (job.state !== "finished") job.preemptRequested = true;
  }

  private finishDspJob(job: DspJob, error?: unknown, outcome: "success" | "error" | "cancelled" = error ? "error" : "success") {
    if (job.state === "finished") return;
    job.state = "finished";
    this.dspJobs.delete(job.key);
    this.removeDspJobFromQueues(job);
    for (const consumer of job.consumers.values()) {
      if (this.dspJobsByOwner.get(consumer.ownerId) === job.key) this.dspJobsByOwner.delete(consumer.ownerId);
      if (consumer.abortListener && consumer.signal) consumer.signal.removeEventListener("abort", consumer.abortListener);
      if (error) consumer.reject(error); else consumer.resolve();
    }
    job.consumers.clear();
    this.recordDspTerminalDispatch(job, outcome);
    this.refreshRunningDspPreemption();
  }

  private invalidateDspJobsForOrbit(orbitId: string) {
    for (const job of [...this.dspJobs.values()]) {
      if (job.descriptor.lease.orbitId !== orbitId) continue;
      job.sourceInvalidated = true;
      job.cancelRequested = true;
      if (job.state === "queued") this.finishDspJob(job, new Error("Audio source changed before rendering."), "error");
    }
  }

  private pumpDspRenderQueue() {
    while (this.activeDspRenders < AudioEngine.MAX_CONCURRENT_DSP_RENDERS) {
      const job = this.takeNextDspJob();
      if (!job) {
        if (this.activeDspRenders === 0) {
          this.terminalDspPriority = null;
          this.consecutiveTerminalDspJobs = 0;
        }
        return;
      }
      if (job.state !== "queued" || job.consumers.size === 0 || job.cancelRequested) {
        this.finishDspJob(job, this.abortError(), "cancelled");
        continue;
      }
      job.state = "running";
      this.refreshRunningDspPreemption();
      this.activeDspRenders++;
      this.dspRenderAttempts++;
      let attemptFrames = 0;
      void this.renderPlanetBuffer(
        job.descriptor,
        () => job.cancelRequested || job.sourceInvalidated || job.consumers.size === 0,
        () => job.preemptRequested,
        (frames) => { attemptFrames += frames; }
      ).then(
        () => {
          try {
            if (job.reverseRequested) {
              const rendered = this.touchCachedBuffer(this.processedBuffers, job.descriptor.key, job.descriptor);
              if (!rendered) throw new Error("Processed audio disappeared before reverse prewarm.");
              this.ensureReversedBuffer(job.descriptor, rendered);
            }
            this.finishDspJob(job);
          } catch (error) {
            this.finishDspJob(job, error, "error");
          }
        },
        (error: unknown) => {
          if (this.isPreemptError(error) && !job.cancelRequested && !job.sourceInvalidated && job.consumers.size > 0) {
            this.dspRestartedFrames += attemptFrames;
            this.terminalDspPriority = null;
            this.consecutiveTerminalDspJobs = 0;
            job.preemptRequested = false;
            job.state = "queued";
            this.enqueueDspJob(job, true);
            return;
          }
          this.finishDspJob(job, error, error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "error");
        }
      )
        .finally(() => {
          this.activeDspRenders--;
          this.pumpDspRenderQueue();
        });
    }
  }

  ensureProcessedBuffer(request: ProcessedBufferRequest, options: EnsureProcessedBufferOptions): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(this.abortError());
    const semantic = this.processedBufferRequest(
      request.orbitId, request.planetId, request.speed, request.pitchCents,
      request.sampleStart, request.sampleEnd, request.direction
    );
    const neutral = Math.abs(semantic.speed - 1) < .0001 && semantic.pitchCents === 0;
    const descriptor = this.describeProcessedBuffer(neutral
      ? this.processedBufferRequest(semantic.orbitId, semantic.planetId, 1, 0, 0, Infinity, semantic.direction)
      : semantic);
    const oldKey = this.dspJobsByOwner.get(options.ownerId);
    if (oldKey && oldKey !== descriptor.key) {
      const oldJob = this.dspJobs.get(oldKey);
      if (oldJob) this.detachDspConsumer(oldJob, options.ownerId);
    }
    if (neutral) {
      if (semantic.direction === "reverse") this.ensureReversedBuffer(descriptor, descriptor.lease.buffer);
      return Promise.resolve();
    }
    const cached = this.touchCachedBuffer(this.processedBuffers, descriptor.key, descriptor);
    if (cached) {
      if (semantic.direction === "reverse") this.ensureReversedBuffer(descriptor, cached);
      return Promise.resolve();
    }
    const existing = this.dspJobs.get(descriptor.key);
    if (existing) {
      if (semantic.direction === "reverse") existing.reverseRequested = true;
      const sameOwner = existing.consumers.get(options.ownerId);
      if (sameOwner) {
        sameOwner.priority = options.priority ?? "background";
        this.refreshDspJobPriority(existing);
        this.refreshRunningDspPreemption();
        return sameOwner.promise;
      }
      existing.cancelRequested = false;
      const promise = this.addDspConsumer(existing, options);
      this.refreshDspJobPriority(existing);
      this.refreshRunningDspPreemption();
      return promise;
    }
    const job: DspJob = {
      key: descriptor.key,
      enqueueSequence: ++this.nextDspJobSequence,
      descriptor,
      consumers: new Map(),
      state: "queued",
      priority: options.priority ?? "background",
      cancelRequested: false,
      preemptRequested: false,
      sourceInvalidated: false,
      reverseRequested: semantic.direction === "reverse"
    };
    this.dspJobs.set(job.key, job);
    const promise = this.addDspConsumer(job, options);
    this.enqueueDspJob(job);
    this.pumpDspRenderQueue();
    return promise;
  }

  private addDspConsumer(job: DspJob, options: EnsureProcessedBufferOptions): Promise<void> {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const consumer: DspConsumer = { ownerId: options.ownerId, promise, resolve, reject, priority: options.priority ?? "background", signal: options.signal };
    if (options.signal) {
      const abort = () => this.detachDspConsumer(job, options.ownerId);
      consumer.abortListener = abort;
      options.signal.addEventListener("abort", abort, { once: true });
    }
    job.consumers.set(options.ownerId, consumer);
    this.dspJobsByOwner.set(options.ownerId, job.key);
    return promise;
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
  private touchCachedBuffer(cache: Map<string, AudioBuffer>, key: string, descriptor?: ProcessedBufferDescriptor): AudioBuffer | undefined {
    let value = cache.get(key);
    if (value === undefined && cache === this.processedBuffers) value = this.inflateColdProcessedBuffer(key, descriptor);
    if (value === undefined) return undefined;
    const entries = cache === this.processedBuffers ? this.processedEntries : this.reverseEntries;
    const entry = entries.get(key);
    if (entry && !this.currentCacheEntry(entry)) {
      if (cache === this.processedBuffers) this.removeProcessedEntry(key);
      else this.removeReverseEntry(key);
      return undefined;
    }
    if (!entry && descriptor) {
      entries.set(key, this.cacheEntryFor(descriptor, cache === this.reverseBuffers ? "reverse" : "forward", value));
    }
    cache.delete(key);
    cache.set(key, value);
    if (this.cachePolicy().pcm16Enabled) this.touchHotRecency(key, cache === this.reverseBuffers ? "reverse" : "forward");
    return value;
  }

  private touchHotRecency(key: string, direction: "forward" | "reverse") {
    this.hotRecency.delete(key);
    this.hotRecency.set(key, direction);
  }

  private cacheProcessedBuffer(
    cache: Map<string, AudioBuffer>, key: string, value: AudioBuffer,
    descriptor?: ProcessedBufferDescriptor, preserveCold = false
  ) {
    const direction = cache === this.reverseBuffers ? "reverse" as const : "forward" as const;
    const entry = descriptor ? this.cacheEntryFor(descriptor, direction, value) : undefined;
    const policy = this.cachePolicy();
    if (cache === this.processedBuffers && policy.pcm16Enabled && !preserveCold) {
      this.cacheColdProcessedBuffer(key, this.toColdPcm16(value), descriptor, value);
    }
    if (entry) {
      if (cache === this.processedBuffers) {
        this.processedEntries.set(key, entry);
        this.processedWindows.set(key, entry.window);
      } else this.reverseEntries.set(key, entry);
    }
    cache.delete(key);
    cache.set(key, value);
    if (policy.pcm16Enabled) this.touchHotRecency(key, direction);
    this.enforceCachePolicies();
  }

  private cacheColdProcessedBuffer(key: string, pcm: ColdPcm16, descriptor?: ProcessedBufferDescriptor, source?: AudioBuffer) {
    const policy = this.cachePolicy();
    const bytes = pcm.channels.reduce((total, channel) => total + channel.byteLength, 0);
    if (bytes > policy.coldByteBudget) return;
    this.coldProcessedBuffers.delete(key);
    this.coldProcessedBuffers.set(key, pcm);
    if (descriptor && source) this.coldProcessedEntries.set(key, this.cacheEntryFor(descriptor, "forward", source, bytes));
    this.enforceColdCache(policy);
  }

  private isHotEntryProtected(key: string, buffer: AudioBuffer, activeBuffers: ReadonlySet<AudioBuffer>) {
    return activeBuffers.has(buffer) || this.isResidencyKeyProtected(key);
  }

  private hotCacheValue(key: string, direction: "forward" | "reverse") {
    return direction === "forward" ? this.processedBuffers.get(key) : this.reverseBuffers.get(key);
  }

  private ensureHotRecency() {
    for (const key of this.processedBuffers.keys()) if (!this.hotRecency.has(key)) this.hotRecency.set(key, "forward");
    for (const key of this.reverseBuffers.keys()) if (!this.hotRecency.has(key)) this.hotRecency.set(key, "reverse");
  }

  private enforceLegacyCacheCap(cache: Map<string, AudioBuffer>) {
    const protectedBuffers = this.activePlaybackBuffers();
    while (cache.size > AudioEngine.PROCESSED_BUFFER_CACHE_CAP) {
      let removed = false;
      for (const [candidateKey, candidateValue] of cache) {
        if (protectedBuffers.has(candidateValue) || this.isResidencyKeyProtected(candidateKey)) continue;
        cache.delete(candidateKey);
        if (cache === this.processedBuffers && !this.coldProcessedBuffers.has(candidateKey)) {
          this.processedEntries.delete(candidateKey);
          this.processedWindows.delete(candidateKey);
        }
        if (cache === this.reverseBuffers) this.reverseEntries.delete(candidateKey);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  private enforceHotCache(policy: CachePolicy) {
    this.ensureHotRecency();
    const activeBuffers = this.activePlaybackBuffers();
    while (true) {
      const residency = this.hotCacheResidency();
      if (residency.bytes <= policy.hotByteBudget && residency.entries <= policy.hotEntryBudget) return;
      let removed = false;
      for (const [key, direction] of this.hotRecency) {
        const buffer = this.hotCacheValue(key, direction);
        if (!buffer) {
          this.hotRecency.delete(key);
          continue;
        }
        if (this.isHotEntryProtected(key, buffer, activeBuffers)) continue;
        if (direction === "forward") this.removeHotProcessedEntry(key);
        else this.removeReverseEntry(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  private enforceColdCache(policy: CachePolicy) {
    while (true) {
      const residency = this.coldCacheResidency();
      if (residency.bytes <= policy.coldByteBudget && residency.entries <= policy.coldEntryBudget) return;
      const oldest = this.coldProcessedBuffers.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.removeColdProcessedEntry(oldest);
    }
  }

  private enforceCachePolicies() {
    const policy = this.cachePolicy();
    if (!policy.pcm16Enabled) {
      this.enforceLegacyCacheCap(this.processedBuffers);
      this.enforceLegacyCacheCap(this.reverseBuffers);
      return;
    }
    this.enforceColdCache(policy);
    this.enforceHotCache(policy);
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

  private inflateColdProcessedBuffer(key: string, descriptor?: ProcessedBufferDescriptor): AudioBuffer | undefined {
    const cold = this.coldProcessedBuffers.get(key);
    if (!cold) return undefined;
    const entry = this.coldProcessedEntries.get(key);
    if (entry && !this.currentCacheEntry(entry)) {
      this.removeProcessedEntry(key);
      return undefined;
    }
    this.coldProcessedBuffers.delete(key);
    this.coldProcessedBuffers.set(key, cold);
    const buffer = this.getContext().createBuffer(cold.channels.length, cold.length, cold.sampleRate);
    for (let channel = 0; channel < cold.channels.length; channel++) {
      const target = buffer.getChannelData(channel), source = cold.channels[channel];
      for (let frame = 0; frame < source.length; frame++) target[frame] = source[frame] / 32768;
    }
    this.cacheProcessedBuffer(this.processedBuffers, key, buffer, descriptor, true);
    return buffer;
  }

  private getPlaybackBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity): PlaybackBufferResolution {
    const original = this.buffers.get(orbitId);
    if (!original) return { status: "missing-original" };
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) {
      const descriptor = this.describeProcessedBuffer(this.processedBufferRequest(orbitId, planetId, 1, 0));
      return {
        status: "ready",
        buffer: original,
        key: descriptor.key,
        usingProcessedBuffer: false,
        descriptor
      };
    }
    const descriptor = this.describeProcessedBuffer(this.processedBufferRequest(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd));
    const processed = this.touchCachedBuffer(this.processedBuffers, descriptor.key, descriptor);
    if (processed) return { status: "ready", buffer: processed, key: descriptor.key, usingProcessedBuffer: true, descriptor };
    // Playing the original here silently discards requested speed/pitch. The
    // caller skips this trigger until its explicit prewarm/render completes.
    return { status: "pending", cacheKey: descriptor.key };
  }

  private ensurePlaybackMiss(
    resolution: Extract<PlaybackBufferResolution, { status: "pending" }>,
    orbitId: string,
    planetId: string,
    speed: number,
    pitchCents: number,
    reverse: boolean,
    sampleStart: number,
    sampleEnd: number,
    scope?: PlaybackRenderScope
  ) {
    if (!this.buffers.has(orbitId) || scope?.signal?.aborted) return;
    const request = this.processedBufferRequest(
      orbitId, planetId, speed, pitchCents, sampleStart, sampleEnd,
      reverse ? "reverse" : "forward"
    );
    void this.ensureProcessedBuffer(request, {
      ownerId: scope?.ownerId ?? `playback:${resolution.cacheKey}`,
      priority: "playback",
      ...(scope?.signal ? { signal: scope.signal } : {})
    }).then(() => undefined, () => undefined);
  }

  private createPlayback(
    id: string, orbitId: string, planetId: string, barId: string,
    mode: "loop" | "sequence", planetVolume: number, planetAudioPan: number, tapeRate = 1,
    userSpeed = 1, pitchCents = 0, reverse = false, sampleStart = 0, sampleEnd = Infinity,
    scope?: PlaybackRenderScope
  ) {
    const context = this.getContext();
    const resolved = this.getPlaybackBuffer(orbitId, planetId, userSpeed, pitchCents, sampleStart, sampleEnd);
    const orbitRuntime = this.orbitRuntimes.get(orbitId);
    if (resolved.status === "pending") {
      if (orbitRuntime) this.ensurePlaybackMiss(resolved, orbitId, planetId, userSpeed, pitchCents, reverse, sampleStart, sampleEnd, scope);
      return null;
    }
    if (resolved.status !== "ready" || !orbitRuntime) return null;
    let playbackBuffer = resolved.buffer;
    if (reverse) {
      playbackBuffer = this.ensureReversedBuffer(resolved.descriptor, resolved.buffer);
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
      id, orbitId, planetId, barId, source, planetGainNode: planetGain, planetPanNode, planetAudioPan, mode, isReverse: reverse,
      processedWindow: resolved.usingProcessedBuffer ? this.processedWindows.get(resolved.key) : undefined
    };
    this.active.set(id, playback);
    source.onended = () => {
      if (this.active.get(id)?.source === source) this.active.delete(id);
      this.enforceCachePolicies();
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

  private createReversedBuffer(key: string, source: AudioBuffer, descriptor: ProcessedBufferDescriptor) {
    const reversed = this.getContext().createBuffer(
      source.numberOfChannels, source.length, source.sampleRate
    );
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const input = source.getChannelData(channel);
      const output = reversed.getChannelData(channel);
      for (let index = 0; index < input.length; index++) output[index] = input[input.length - 1 - index];
    }
    this.cacheProcessedBuffer(this.reverseBuffers, key, reversed, descriptor);
    return reversed;
  }

  private ensureReversedBuffer(descriptor: ProcessedBufferDescriptor, source: AudioBuffer) {
    const reverseKey = `${descriptor.key}:reverse`;
    return this.touchCachedBuffer(this.reverseBuffers, reverseKey, descriptor) ??
      this.createReversedBuffer(reverseKey, source, descriptor);
  }

  syncLoop(
    orbitId: string, planetId: string, barId: string, inside: boolean,
    audioTime: number, planetVolume: number, planetAudioPan: number,
    tapeRate: number, userSpeed: number, pitchCents: number,
    reverse = false, sampleStart = 0, sampleEnd = Infinity, scope?: PlaybackRenderScope
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
        const now = this.getContext().currentTime;
        this.advanceLoopPlaybackPhase(current, now);
        current.planetGainNode.gain.setValueAtTime(planetVolume, now);
        current.source.playbackRate.setValueAtTime(tapeRate, now);
        return;
      }
    }
    const created = this.createPlayback(
      key, orbitId, planetId, barId, "loop", planetVolume, planetAudioPan,
      tapeRate, userSpeed, pitchCents, reverse, sampleStart, sampleEnd, scope
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
    created.playback.playbackPhaseOffset = safeOffset;
    created.playback.playbackPhaseAt = created.context.currentTime;
    created.playback.source.start(created.context.currentTime, safeOffset);
  }

  triggerSequence(
    orbitId: string, planetId: string, barId: string, planetVolume: number, planetAudioPan: number,
    tapeRate: number, pitchCents: number, reverse: boolean,
    retriggerMode: SequenceRetriggerMode, sampleStart = 0, sampleEnd = Infinity, scope?: PlaybackRenderScope
  ) {
    if (retriggerMode === "ignore-until-end" && this.hasActiveSequencePlayback(orbitId)) return;
    if (retriggerMode === "cut-previous") this.stopActiveSequencePlaybacksForOrbit(orbitId);
    const id = `sequence:${planetId}:${barId}:${crypto.randomUUID()}`;
    const created = this.createPlayback(
      id, orbitId, planetId, barId, "sequence", planetVolume, planetAudioPan,
      tapeRate, 1, pitchCents, reverse, sampleStart, sampleEnd, scope
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
    this.enforceCachePolicies();
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
      if (playback.planetId === planetId) {
        playback.planetAudioPan = audioPan;
        playback.planetPanNode.setPan(audioPan);
      }
    }
  }

  setActivePlanetTapeRate(planetId: string, tapeRate: number) {
    const context = this.getContext();
    for (const playback of this.active.values()) {
      if (playback.planetId === planetId && playback.mode === "loop") {
        this.advanceLoopPlaybackPhase(playback, context.currentTime);
        playback.source.playbackRate.setValueAtTime(tapeRate, context.currentTime);
      }
    }
  }

  hasProcessedBuffer(orbitId: string, planetId: string, speed: number, pitchCents: number, sampleStart = 0, sampleEnd = Infinity) {
    const normalizedSpeed = this.normalizedSpeed(speed);
    const roundedPitch = Math.round(pitchCents);
    if (Math.abs(normalizedSpeed - 1) < .0001 && roundedPitch === 0) return true;
    const descriptor = this.describeProcessedBuffer(this.processedBufferRequest(orbitId, planetId, normalizedSpeed, roundedPitch, sampleStart, sampleEnd));
    return this.touchCachedBuffer(this.processedBuffers, descriptor.key, descriptor) !== undefined ||
      (this.coldProcessedBuffers.has(descriptor.key) && this.currentCacheEntry(this.coldProcessedEntries.get(descriptor.key)));
  }

  private async renderPlanetBuffer(
    descriptor: ProcessedBufferDescriptor,
    shouldCancel: () => boolean = () => false,
    shouldPreempt: () => boolean = () => false,
    onRenderedFrames: (frames: number) => void = () => {}
  ) {
    const { key, lease, request, window: renderWindow } = descriptor;
    const original = lease.buffer;
    if (!this.currentCacheEntry(this.cacheEntryFor(descriptor, "forward", original))) throw new Error("Audio source changed before rendering.");
    if (shouldCancel()) throw this.abortError();

    const pitchRate = Math.pow(2, request.pitchCents / 1200);
    const outputLength = Math.max(1, Math.ceil(original.length / request.speed));
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
    soundTouch.tempo = request.speed;
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
      onRenderedFrames(frames);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (shouldCancel()) throw this.abortError();
      if (shouldPreempt()) throw this.preemptError();
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
    if (!this.currentCacheEntry(this.cacheEntryFor(descriptor, "forward", original))) throw new Error("Audio source changed before rendering.");
    if (shouldCancel()) throw this.abortError();
    if (shouldPreempt()) throw this.preemptError();
    this.cacheProcessedBuffer(this.processedBuffers, key, physical, descriptor);
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
    this.invalidateDspJobsForOrbit(orbitId);
    this.buffers.delete(orbitId);
    this.sourceLeases.delete(orbitId);
    this.clearOrbitResidencies(orbitId);
    this.waveformPeaks.delete(orbitId);
    this.publishWaveformPeaks(orbitId, null);
    this.clearOrbitProcessedCaches(orbitId);
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
