import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const candidates = [
  path.resolve("dist/mac-arm64/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/mac/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/linux-unpacked/orbitronic-mvp"),
  path.resolve("dist/win-unpacked/Orbitronica.exe")
];
const executable = candidates.find(existsSync);
if (!executable) throw new Error("No unpacked Orbitronica executable found; run npm run build first.");
const child = spawn(executable, ["--wam-dsp-test"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
const timeout = setTimeout(() => child.kill("SIGKILL"), 100_000);
const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(timeout);
const marker = output.match(/ORBITRONICA_WAM_DSP\s+(\{[^\n]+\})/);
if (exitCode !== 0 || !marker) throw new Error(`WAM DSP harness failed (exit ${exitCode}): ${output}`);
let result; try { result = JSON.parse(marker[1]); } catch { throw new Error(`WAM DSP harness emitted invalid JSON: ${marker[1]}`); }
// Six controls at both mandatory sample rates, plus safety and state evidence.
if (result.status !== "pass" || !Array.isArray(result.results) || result.results.length < 15 || result.results.some((item) => !item.ok)) {
  throw new Error(`WAM DSP harness has missing or failed metrics: ${marker[1]}`);
}
console.log(`WAM DSP metrics passed with ${path.relative(process.cwd(), executable)}.`);
