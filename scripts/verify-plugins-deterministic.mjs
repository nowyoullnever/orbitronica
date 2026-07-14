import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ids = ["orbitronica-filter", "orbitronica-overdrive", "orbitronica-compressor", "orbitronica-bitcrusher", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"];
function snapshot(root) {
  const walk = (directory, prefix = "") => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return Object.entries(walk(absolute, `${relative}/`));
    if (!entry.isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`unexpected generated entry: ${relative}`);
    return [[relative, { type: "file", sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") }]];
  }));
  return Object.fromEntries(ids.map((id) => [id, walk(path.join(root, id))]));
}
function buildInto(root) {
  const run = spawnSync(process.execPath, ["scripts/build-plugins.mjs"], { stdio: "inherit", env: { ...process.env, ORBITRONICA_PLUGIN_OUTPUT: root } });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
const temporary = mkdtempSync(path.join(os.tmpdir(), "orbitronica-plugin-determinism-"));
try {
  const first = path.join(temporary, "a"), second = path.join(temporary, "b");
  buildInto(first); buildInto(second);
  const a = snapshot(first), b = snapshot(second);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("isolated clean first-party plugin A/B builds differ in generated paths, file types, or hashes");
  console.log("Verified isolated deterministic first-party plugin builds.");
} finally { rmSync(temporary, { recursive: true, force: true }); }
