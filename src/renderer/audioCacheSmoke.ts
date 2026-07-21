import { audioEngine, type ProcessedBufferRequest } from "./audio/audioEngine.ts";

declare const __ORBITRONICA_BUILD_COMMIT__: string;

const result = document.querySelector<HTMLElement>("#result");
const marker = "ORBITRONICA_AUDIO_CACHE";
const fixtureSeconds = 180;
const fixtureWindow = { start: 60, end: 75 };
const fixtureSampleRate = 44_100;
const measuredRunCount = 5;
const latencyThresholds = { medianMs: 2_000, maxMs: 5_000 };

type PerformanceWithMemory = Performance & {
  readonly memory?: { readonly usedJSHeapSize: number; readonly totalJSHeapSize: number; readonly jsHeapSizeLimit: number };
};

const smokeAdapter = audioEngine.getAudioCacheSmokeAdapter();
const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
const now = () => performance.now();

function schedulerSnapshot() {
  return smokeAdapter.getDiagnostics().scheduler;
}

function median(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

async function fixtureSha256(buffer: AudioBuffer) {
  const bytes = new Uint8Array(buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT);
  let offset = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    const source = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    bytes.set(source, offset);
    offset += source.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createFixture(context: AudioContext, seconds: number, phase = 0) {
  const buffer = context.createBuffer(2, Math.round(seconds * fixtureSampleRate), fixtureSampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    const frequency = channel === 0 ? 233 : 337;
    for (let frame = 0; frame < samples.length; frame++) {
      const time = frame / fixtureSampleRate;
      samples[frame] = .68 * Math.sin(2 * Math.PI * frequency * time + phase) + .17 * Math.sin(2 * Math.PI * 31 * time);
    }
  }
  return buffer;
}

function request(orbitId: string, planetId: string, speed: number, pitchCents: number, direction: "forward" | "reverse" = "forward"): ProcessedBufferRequest {
  return { orbitId, planetId, speed, pitchCents, sampleStart: fixtureWindow.start, sampleEnd: fixtureWindow.end, direction };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(10);
  }
}

function cacheKeyFor(requestValue: ProcessedBufferRequest) {
  const before = audioEngine.getAudioCacheDiagnostics().processedKeys;
  return before.find((key) => key.includes(`${requestValue.orbitId}:${requestValue.planetId}:`));
}

async function rejectReason(promise: Promise<void>) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function run() {
  const context = new AudioContext();
  const pcm16Enabled = new URLSearchParams(window.location.search).get("pcm16ColdCache") === "1";
  const longTaskDurations: number[] = [];
  const observer = typeof PerformanceObserver === "function" ? new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) longTaskDurations.push(entry.duration);
  }) : undefined;
  try { observer?.observe({ entryTypes: ["longtask"] }); } catch {}

  const started = now();
  const fixture = createFixture(context, fixtureSeconds);
  const fixtureIdentity = {
    durationSeconds: fixtureSeconds,
    sampleRate: fixture.sampleRate,
    channels: fixture.numberOfChannels,
    frames: fixture.length,
    windowSeconds: fixtureWindow,
    sha256: await fixtureSha256(fixture),
    encoding: "channel-major-f32le"
  };
  const observed = { maxRunning: 0, maxQueueDepth: { playback: 0, selected: 0, background: 0 } };
  const sampleScheduler = () => {
    const snapshot = schedulerSnapshot();
    observed.maxRunning = Math.max(observed.maxRunning, snapshot.running);
    for (const priority of ["playback", "selected", "background"] as const) observed.maxQueueDepth[priority] = Math.max(observed.maxQueueDepth[priority], snapshot.queueDepth[priority]);
  };
  const schedulerSampler = window.setInterval(sampleScheduler, 5);
  const primaryOrbit = "audio-cache-smoke-long";
  const primaryRequest = request(primaryOrbit, "long-planet", 1.25, 200);
  const protectedCompanionRequest = request(primaryOrbit, "protected-companion", .9, -100);
  const smallFixture = createFixture(context, 2, .4);
  const raceOrbit = "audio-cache-smoke-race";
  const selfHealOrbit = "audio-cache-smoke-self-heal";
  const sequenceOrbit = "audio-cache-smoke-sequence";
  const cancellationOrbit = "audio-cache-smoke-cancel";

  let staleSourceRejections = 0;
  let cancellationRejections = 0;
  let originalFallbacks = 0;
  let coldPromotionAvoidedRender = !pcm16Enabled;
  let coldPromotionDurationMs = 0;
  let noLateSequenceReplay = false;
  let protectedOverageContained = false;
  let protectedOverageDuringProtection = { bytes: 0, entries: 0 };
  let coldOversizeContained = false;
  let selfHealed = false;
  let successfulEnsures = 0;
  const measuredRuns: Array<{ readonly index: number; readonly durationMs: number; readonly cacheHit: boolean }> = [];

  try {
    smokeAdapter.registerFixtureBuffer(raceOrbit, smallFixture, 1);
    const stale = audioEngine.ensureProcessedBuffer(request(raceOrbit, "race-planet", 1.1, 100), { ownerId: "smoke:stale", priority: "background" });
    await sleep(0);
    smokeAdapter.registerFixtureBuffer(raceOrbit, smallFixture, 1);
    if (await rejectReason(stale)) staleSourceRejections++;

    smokeAdapter.registerFixtureBuffer(cancellationOrbit, smallFixture, 1);
    const cancellation = new AbortController();
    const cancelled = audioEngine.ensureProcessedBuffer(request(cancellationOrbit, "cancel-planet", .9, -100), {
      ownerId: "smoke:cancel", priority: "background", signal: cancellation.signal
    });
    cancellation.abort();
    if (await rejectReason(cancelled)) cancellationRejections++;

    smokeAdapter.registerFixtureBuffer(primaryOrbit, fixture, 1);
    const warmStarted = now();
    await audioEngine.ensureProcessedBuffer(primaryRequest, { ownerId: "smoke:warmup", priority: "playback" });
    successfulEnsures++;
    const warmupDurationMs = now() - warmStarted;
    for (let index = 0; index < measuredRunCount; index++) {
      const before = audioEngine.getAudioCacheDiagnostics().dspScheduler.renderAttempts;
      const runStarted = now();
      await audioEngine.ensureProcessedBuffer(primaryRequest, { ownerId: `smoke:preflight:${index}`, priority: "playback" });
      successfulEnsures++;
      measuredRuns.push({ index, durationMs: now() - runStarted, cacheHit: audioEngine.getAudioCacheDiagnostics().dspScheduler.renderAttempts === before });
    }

    const primaryKey = cacheKeyFor(primaryRequest);
    if (!primaryKey) throw new Error("Warm-up did not install a primary cache key.");
    if (pcm16Enabled) {
      if (!smokeAdapter.getDiagnostics().coldKeys.includes(primaryKey)) throw new Error("PCM16 warm-up did not create a cold entry.");
      if (!smokeAdapter.dropHotProcessedBuffer(primaryRequest)) throw new Error("PCM16 warm-up did not create a hot entry.");
      const beforePromotion = audioEngine.getAudioCacheDiagnostics().dspScheduler.renderAttempts;
      const promotionStarted = now();
      coldPromotionAvoidedRender = audioEngine.hasProcessedBuffer(primaryOrbit, "long-planet", 1.25, 200, fixtureWindow.start, fixtureWindow.end) &&
        audioEngine.getAudioCacheDiagnostics().dspScheduler.renderAttempts === beforePromotion;
      coldPromotionDurationMs = now() - promotionStarted;
    }

    smokeAdapter.registerFixtureBuffer(selfHealOrbit, smallFixture, 1);
    const selfRequest = request(selfHealOrbit, "self-heal-planet", .8, 300);
    const activeBeforeMiss = smokeAdapter.getDiagnostics().activePlaybackCount;
    for (let index = 0; index < 3; index++) {
      audioEngine.syncLoop(selfHealOrbit, "self-heal-planet", "self-heal-bar", true, .2, 1, 0, 1, .8, 300, false, fixtureWindow.start, fixtureWindow.end);
    }
    if (smokeAdapter.getDiagnostics().activePlaybackCount !== activeBeforeMiss) originalFallbacks++;
    await audioEngine.ensureProcessedBuffer(selfRequest, { ownerId: "smoke:self-heal", priority: "playback" });
    successfulEnsures++;
    audioEngine.syncLoop(selfHealOrbit, "self-heal-planet", "self-heal-bar", true, .2, 1, 0, 1, .8, 300, false, fixtureWindow.start, fixtureWindow.end);
    selfHealed = smokeAdapter.getDiagnostics().activePlaybackCount === activeBeforeMiss + 1;
    audioEngine.syncLoop(selfHealOrbit, "self-heal-planet", "self-heal-bar", false, .2, 1, 0, 1, .8, 300, false, fixtureWindow.start, fixtureWindow.end);

    smokeAdapter.registerFixtureBuffer(sequenceOrbit, smallFixture, 1);
    const sequenceRequest = request(sequenceOrbit, "sequence-planet", 1, 400);
    const sequenceBefore = smokeAdapter.getDiagnostics().activePlaybackCount;
    audioEngine.triggerSequence(sequenceOrbit, "sequence-planet", "sequence-bar", 1, 0, 1, 400, false, "overlap", fixtureWindow.start, fixtureWindow.end);
    await audioEngine.ensureProcessedBuffer(sequenceRequest, { ownerId: "smoke:sequence", priority: "playback" });
    successfulEnsures++;
    noLateSequenceReplay = smokeAdapter.getDiagnostics().activePlaybackCount === sequenceBefore;
    audioEngine.triggerSequence(sequenceOrbit, "sequence-planet", "sequence-bar", 1, 0, 1, 400, false, "overlap", fixtureWindow.start, fixtureWindow.end);
    audioEngine.stopAllActivePlaybacksForOrbit(sequenceOrbit);

    if (pcm16Enabled) {
      smokeAdapter.setCachePolicy({ pcm16Enabled: true, hotByteBudget: 1, hotEntryBudget: 1, coldByteBudget: 1, coldEntryBudget: 1 });
      const constrained = audioEngine.getAudioCacheDiagnostics();
      coldOversizeContained = constrained.cache.coldBytes <= 1 && constrained.cache.coldEntries <= 1;
      audioEngine.replacePermanentResidency("smoke:protected", [primaryRequest, protectedCompanionRequest]);
      await audioEngine.ensureProcessedBuffer(primaryRequest, { ownerId: "smoke:protected-render", priority: "playback" });
      successfulEnsures++;
      await audioEngine.ensureProcessedBuffer(protectedCompanionRequest, { ownerId: "smoke:protected-companion", priority: "playback" });
      successfulEnsures++;
      const protectedDiagnostics = audioEngine.getAudioCacheDiagnostics();
      protectedOverageDuringProtection = {
        bytes: protectedDiagnostics.cache.protectedHotOverageBytes,
        entries: protectedDiagnostics.cache.protectedHotOverageEntries
      };
      protectedOverageContained = protectedDiagnostics.cache.protectedHotOverageBytes > 0;
      audioEngine.replacePermanentResidency("smoke:protected", []);
      smokeAdapter.setCachePolicy();
    }

    await waitFor(() => {
      const scheduler = smokeAdapter.getDiagnostics().scheduler;
      return scheduler.pendingJobs === 0 && scheduler.running === 0;
    }, "scheduler drain");
    sampleScheduler();
    const diagnostics = audioEngine.getAudioCacheDiagnostics();
    const measuredLatencies = measuredRuns.map((run) => run.durationMs);
    const latency = {
      warmupDurationMs,
      measuredMedianMs: median(measuredLatencies),
      measuredMaxMs: Math.max(...measuredLatencies),
      liveReady: median(measuredLatencies) <= latencyThresholds.medianMs && Math.max(...measuredLatencies) <= latencyThresholds.maxMs,
      thresholds: latencyThresholds
    };
    const memory = (performance as PerformanceWithMemory).memory;
    const invariants = {
      fileProtocol: window.location.protocol === "file:",
      maximumDspConcurrencyOne: observed.maxRunning <= 1,
      sourceRaceRejected: staleSourceRejections === 1,
      noOriginalFallback: originalFallbacks === 0,
      selfHeal: selfHealed,
      noLateSequenceReplay,
      cancellationContained: cancellationRejections === 1,
      coldPromotionAvoidedRender,
      coldPolicyBounded: !pcm16Enabled || (diagnostics.cache.coldBytes <= diagnostics.cache.coldByteBudget && diagnostics.cache.coldEntries <= diagnostics.cache.coldEntryBudget),
      hotPolicyBoundedOrProtected: !pcm16Enabled || diagnostics.cache.hotBytes <= diagnostics.cache.hotByteBudget || diagnostics.cache.protectedHotOverageBytes > 0,
      protectedOverageContained: !pcm16Enabled || protectedOverageContained,
      coldOversizeContained: !pcm16Enabled || coldOversizeContained,
      measuredPreflightsAreHits: measuredRuns.every((run) => run.cacheHit)
    };
    const payload = {
      status: Object.values(invariants).every(Boolean) ? "pass" : "fail",
      reproducibility: {
        buildCommit: __ORBITRONICA_BUILD_COMMIT__,
        warmupProcedure: "one full SoundTouch render of the locked fixture installs the primary processed cache before measurements",
        settlingProcedure: "wait for all DSP jobs and active renders to drain before collecting final diagnostics",
        measuredProcedure: `${measuredRunCount} sequential cache-hit ensureProcessedBuffer calls after warm-up`
      },
      environment: { protocol: window.location.protocol, userAgent: navigator.userAgent, pcm16Enabled, crossOriginIsolated: window.crossOriginIsolated },
      fixture: fixtureIdentity,
      measuredRuns,
      scheduler: {
        running: schedulerSnapshot().running,
        maximumRunning: observed.maxRunning,
        maximumQueueDepth: observed.maxQueueDepth,
        attempts: diagnostics.dspScheduler.renderAttempts,
        restartedFrames: diagnostics.dspScheduler.restartedFrames,
        started: diagnostics.dspScheduler.renderAttempts,
        succeeded: successfulEnsures,
        failed: staleSourceRejections,
        cancelled: cancellationRejections,
        preempted: diagnostics.dspScheduler.restartedFrames > 0 ? 1 : 0
      },
      sourceStaleRejections: staleSourceRejections,
      miss: { selfHealed, originalFallbacks, noLateSequenceReplay },
      cache: { ...diagnostics.cache, protectedOverageDuringProtection },
      cold: { hits: pcm16Enabled && coldPromotionAvoidedRender ? 1 : 0, misses: 0, promotionAvoidedRender: coldPromotionAvoidedRender, promotionDurationMs: coldPromotionDurationMs },
      latency,
      longTaskMaximumMs: Math.max(0, ...longTaskDurations),
      rendererMemory: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null,
      totalDurationMs: now() - started,
      invariants
    };
    result!.textContent = JSON.stringify(payload, null, 2);
    console.log(`${marker} ${JSON.stringify(payload)}`);
  } finally {
    window.clearInterval(schedulerSampler);
    observer?.disconnect();
    for (const orbitId of [primaryOrbit, raceOrbit, selfHealOrbit, sequenceOrbit, cancellationOrbit]) audioEngine.removeOrbit(orbitId);
    await context.close();
  }
}

void run().catch((error: unknown) => {
  const payload = {
    status: "fail",
    environment: { protocol: window.location.protocol, pcm16Enabled: new URLSearchParams(window.location.search).get("pcm16ColdCache") === "1" },
    error: error instanceof Error ? error.message : String(error)
  };
  result!.textContent = JSON.stringify(payload, null, 2);
  console.log(`${marker} ${JSON.stringify(payload)}`);
});
