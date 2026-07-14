import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PACKAGED_EXECUTABLE_CANDIDATES = [
  path.resolve("dist/mac-arm64/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/mac/Orbitronica.app/Contents/MacOS/Orbitronica"),
  path.resolve("dist/linux-unpacked/orbitronic-mvp"),
  path.resolve("dist/win-unpacked/Orbitronica.exe")
];

// Returns the first packaged Orbitronica executable that exists on disk, or
// undefined if none of the platform-specific unpacked output paths exist.
export function findPackagedExecutable() {
  return PACKAGED_EXECUTABLE_CANDIDATES.find(existsSync);
}

// Spawns `executable` with `args`, mirrors its stdout/stderr to this
// process's stdout/stderr while also collecting it, waits for exit, then
// extracts and JSON.parses the `marker <json>` line the packaged harness
// prints on completion.
//
// `timeoutMs` (or `computeTimeoutMs(output-so-far n/a; pass a number)`)
// bounds how long to wait before SIGKILL-ing the child.
// Throws with a message prefixed by `failureLabel` if the process exits
// non-zero, no marker line is found, or the marker payload is not valid
// JSON. Does not itself check `result.status`; callers apply their own
// pass/fail semantics on the parsed result.
export async function runPackagedAndParse({ executable, args, marker, timeoutMs, failureLabel }) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  clearTimeout(timeout);
  const markerPattern = new RegExp(`${marker}\\s+(\\{[^\\n]+\\})`);
  const match = output.match(markerPattern);
  if (exitCode !== 0 || !match) throw new Error(`${failureLabel} failed (exit ${exitCode}): ${output}`);
  try {
    return { result: JSON.parse(match[1]), raw: match[1], output };
  } catch {
    throw new Error(`${failureLabel} emitted invalid JSON: ${match[1]}`);
  }
}
