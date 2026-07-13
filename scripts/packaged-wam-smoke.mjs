import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
for (const asset of ["index.js", "descriptor.json", "screenshot.png", "manifest.json"]) {
  if (!existsSync(path.join(dist, "wam", "burns-simple-delay", asset))) {
    throw new Error(`Packaged WAM asset missing: ${asset}`);
  }
}

const child = spawn(executable, ["--wam-smoke"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
clearTimeout(timeout);
const marker = output.match(/ORBITRONICA_WAM_SMOKE\s+(\{[^\n]+\})/);
if (exitCode !== 0 || !marker) throw new Error(`Packaged WAM smoke failed (exit ${exitCode}): ${output}`);
const result = JSON.parse(marker[1]);
if (result.status !== "pass" || result.origin !== "file:") {
  throw new Error(`Packaged WAM smoke did not prove file:// success: ${marker[1]}`);
}
if (result.rackRemovalCompleted !== true || result.cleanupDidNotBlockHost !== true) {
  throw new Error(`Packaged WAM smoke did not prove non-blocking rack removal: ${marker[1]}`);
}
console.log(`Packaged WAM smoke passed with ${path.relative(process.cwd(), executable)}.`);
