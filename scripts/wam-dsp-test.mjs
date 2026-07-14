import path from "node:path";
import { findPackagedExecutable, runPackagedAndParse } from "./lib/run-packaged.mjs";

const executable = findPackagedExecutable();
if (!executable) throw new Error("No unpacked Orbitronica executable found; run npm run build first.");
const { result, raw } = await runPackagedAndParse({
  executable,
  args: ["--wam-dsp-test"],
  marker: "ORBITRONICA_WAM_DSP",
  timeoutMs: 100_000,
  failureLabel: "WAM DSP harness"
});
const legacyCatalogIds = ["burns-simple-delay", "burns-simple-eq", "orbitronica-overdrive", "orbitronica-filter"];
if (result.environment?.protocol !== "file:" || result.environment?.offlineAudioContext !== true) {
  throw new Error(`WAM DSP harness did not prove packaged Chromium OfflineAudioContext execution: ${raw}`);
}
for (const catalogId of legacyCatalogIds) {
  const covered = result.catalogHarness?.[catalogId];
  const events = result.results?.filter((item) => item.catalogId === catalogId && item.phase === "dsp" && item.ok) ?? [];
  const needsEqualPowerProof = catalogId === "orbitronica-overdrive";
  if (!covered || !Array.isArray(covered.publicControls) || !covered.publicControls.every((control) => events.some((item) => item.parameterId === control && item.metric.includes("non-neutral-public-control"))) || !events.some((item) => item.metric === "public-parameter-state-round-trip") || !events.some((item) => item.metric === "finite-bounded-stereo-extremes") || (needsEqualPowerProof && !events.some((item) => item.metric === "equal-power-projection"))) {
    throw new Error(`WAM DSP catalog harness has incomplete public-control evidence for ${catalogId}: ${raw}`);
  }
}
// First-party controls at both mandatory sample rates, plus safety/state, and
// four independently checked legacy catalog effects.
if (result.status !== "pass" || !Array.isArray(result.results) || result.results.length < 15 || result.results.some((item) => !item.ok)) {
  throw new Error(`WAM DSP harness has missing or failed metrics: ${raw}`);
}
console.log(`WAM DSP metrics passed with ${path.relative(process.cwd(), executable)}.`);
