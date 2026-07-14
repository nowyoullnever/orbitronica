import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const candidates = [
  path.resolve("dist/mac-arm64/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/mac/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/linux-unpacked/orbitronic-mvp"),
  path.resolve("dist/win-unpacked/Orbitronica.exe")
];
const executable = candidates.find(existsSync);
if (!executable) throw new Error(`No unpacked Orbitronica executable found below ${path.dirname(dist)}.`);
const wamRoot = path.join(dist, "wam");
if (!existsSync(wamRoot)) throw new Error(`Packaged WAM directory missing: ${wamRoot}`);
for (const catalogId of readdirSync(wamRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
  for (const asset of ["index.js", "descriptor.json", "manifest.json"]) if (!existsSync(path.join(wamRoot, catalogId, asset))) throw new Error(`Packaged WAM asset missing for ${catalogId}: ${asset}`);
}

const child = spawn(executable, ["--wam-smoke"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
const pluginCount = readdirSync(wamRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000 + pluginCount * 10_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
clearTimeout(timeout);
const marker = output.match(/ORBITRONICA_WAM_SMOKE\s+(\{[^\n]+\})/);
if (exitCode !== 0 || !marker) throw new Error(`Packaged WAM smoke failed (exit ${exitCode}): ${output}`);
let result; try { result = JSON.parse(marker[1]); } catch { throw new Error(`Packaged WAM smoke emitted invalid JSON: ${marker[1]}`); }
if (result.status !== "pass" || result.origin !== "file:") {
  throw new Error(`Packaged WAM smoke did not prove file:// success: ${marker[1]}`);
}
if (result.rackRemovalCompleted !== true || result.cleanupDidNotBlockHost !== true || !Array.isArray(result.events) || result.events.some((event) => !event.ok)) {
  throw new Error(`Packaged WAM smoke did not prove non-blocking rack removal: ${marker[1]}`);
}
console.log(`Packaged WAM smoke passed with ${path.relative(process.cwd(), executable)}.`);
