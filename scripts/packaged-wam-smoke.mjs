import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { findPackagedExecutable, runPackagedAndParse } from "./lib/run-packaged.mjs";

const dist = path.resolve("dist");
const executable = findPackagedExecutable();
if (!executable) throw new Error(`No unpacked Orbitronica executable found below ${path.dirname(dist)}.`);
const wamRoot = path.join(dist, "wam");
if (!existsSync(wamRoot)) throw new Error(`Packaged WAM directory missing: ${wamRoot}`);
for (const catalogId of readdirSync(wamRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
  for (const asset of ["index.js", "descriptor.json", "manifest.json"]) if (!existsSync(path.join(wamRoot, catalogId, asset))) throw new Error(`Packaged WAM asset missing for ${catalogId}: ${asset}`);
}

const pluginCount = readdirSync(wamRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
const { result, raw } = await runPackagedAndParse({
  executable,
  args: ["--wam-smoke"],
  marker: "ORBITRONICA_WAM_SMOKE",
  timeoutMs: 5_000 + pluginCount * 10_000,
  failureLabel: "Packaged WAM smoke"
});
if (result.status !== "pass" || result.origin !== "file:") {
  throw new Error(`Packaged WAM smoke did not prove file:// success: ${raw}`);
}
if (result.rackRemovalCompleted !== true || result.cleanupDidNotBlockHost !== true || !Array.isArray(result.events) || result.events.some((event) => !event.ok)) {
  throw new Error(`Packaged WAM smoke did not prove non-blocking rack removal: ${raw}`);
}
console.log(`Packaged WAM smoke passed with ${path.relative(process.cwd(), executable)}.`);
