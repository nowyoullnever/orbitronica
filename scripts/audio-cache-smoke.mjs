import path from "node:path";
import { findPackagedExecutable, runPackagedAndParse } from "./lib/run-packaged.mjs";

const executable = findPackagedExecutable();
if (!executable) throw new Error("No unpacked Orbitronica executable found; run npm run build first.");

const modes = [
  { name: "float32-default", args: ["--audio-cache-smoke"] },
  { name: "pcm16-cold", args: ["--audio-cache-smoke", "--pcm16-cold-cache"] }
];
const results = [];
for (const mode of modes) {
  const { result, raw } = await runPackagedAndParse({
    executable,
    args: mode.args,
    marker: "ORBITRONICA_AUDIO_CACHE",
    timeoutMs: 180_000,
    failureLabel: `Audio-cache packaged smoke (${mode.name})`
  });
  const invariants = result.invariants;
  if (result.status !== "pass" || result.environment?.protocol !== "file:" || !invariants || Object.values(invariants).some((value) => value !== true)) {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) failed its functional invariants: ${raw}`);
  }
  if (result.fixture?.durationSeconds !== 180 || result.fixture?.sampleRate !== 44_100 || result.fixture?.channels !== 2 || result.fixture?.windowSeconds?.start !== 60 || result.fixture?.windowSeconds?.end !== 75 || !/^[a-f0-9]{64}$/.test(result.fixture?.sha256 ?? "") || result.fixture?.encoding !== "channel-major-f32le") {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) did not report the locked 180s stereo fixture: ${raw}`);
  }
  if (!/^[a-f0-9]{40}$/.test(result.reproducibility?.buildCommit ?? "") || !result.reproducibility?.packagedBuildPath || !result.reproducibility?.runtime?.electron || !result.reproducibility?.runtime?.chromium || !result.reproducibility?.runtime?.platform || !result.reproducibility?.runtime?.cpuModel || !result.reproducibility?.warmupProcedure || !result.reproducibility?.settlingProcedure || !result.runMetrics?.latency || !result.runMetrics?.appRss || !result.runMetrics?.cold || typeof result.runMetrics?.longTaskMaximumMs !== "number") {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) did not report reproducible build and run evidence: ${raw}`);
  }
  if (!Array.isArray(result.measuredRuns) || result.measuredRuns.length !== 5 || !result.measuredRuns.every((run) => run.cacheHit === true)) {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) did not report five cache-hit preflights: ${raw}`);
  }
  if (result.scheduler?.maximumRunning !== 1 || result.sourceStaleRejections !== 1 || result.miss?.originalFallbacks !== 0 || result.miss?.selfHealed !== true || result.miss?.noLateSequenceReplay !== true) {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) lost scheduler or playback safety evidence: ${raw}`);
  }
  if (mode.name === "pcm16-cold" && (result.environment?.pcm16Enabled !== true || result.cold?.hits < 1 || result.cache?.coldBytes > result.cache?.coldByteBudget || result.cache?.coldEntries > result.cache?.coldEntryBudget || result.cache?.protectedOverageDuringProtection?.bytes <= 0 || result.cache?.protectedOverageDuringProtection?.entries <= 0)) {
    throw new Error(`Audio-cache packaged smoke (${mode.name}) did not prove bounded cold promotion and protected overage: ${raw}`);
  }
  results.push({ mode: mode.name, result });
}

console.log(`Audio-cache packaged smoke passed with ${path.relative(process.cwd(), executable)}.`);
console.log(`ORBITRONICA_AUDIO_CACHE_SUMMARY ${JSON.stringify(results)}`);
