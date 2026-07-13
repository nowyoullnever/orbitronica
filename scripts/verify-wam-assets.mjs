import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.argv[2] ?? "public";
const assetRoot = path.join(root, "wam", "burns-simple-delay");
const manifestPath = path.join(assetRoot, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`Missing trusted WAM manifest: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expected = manifest.assets;
if (!expected || typeof expected !== "object") throw new Error("WAM manifest must declare asset hashes.");
const actualNames = readdirSync(assetRoot).filter((name) => name !== "manifest.json").sort();
const expectedNames = Object.keys(expected).sort();
if (actualNames.join("\0") !== expectedNames.join("\0")) {
  throw new Error(`Trusted WAM asset list mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`);
}
for (const name of expectedNames) {
  if (path.basename(name) !== name) throw new Error(`WAM manifest path must be a file name: ${name}`);
  const hash = createHash("sha256").update(readFileSync(path.join(assetRoot, name))).digest("hex");
  if (hash !== expected[name]) throw new Error(`Trusted WAM hash mismatch for ${name}: ${hash}`);
}
console.log(`Verified trusted WAM assets in ${assetRoot}.`);
