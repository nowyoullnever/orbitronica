import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIRST_PARTY_PLUGIN_IDS } from "./lib/plugin-ids.mjs";
import { hashFile } from "./lib/wam-hash.mjs";
for (const id of FIRST_PARTY_PLUGIN_IDS) {
  const root = path.resolve("public/wam", id), manifest = path.resolve("plugins/src", id, "manifest.json");
  const source = JSON.parse(readFileSync(manifest, "utf8"));
  source.assets = Object.fromEntries(readdirSync(root).filter((name) => name !== "manifest.json").sort().map((name) => [name, hashFile(path.join(root, name))]));
  writeFileSync(manifest, `${JSON.stringify(source, null, 2)}\n`); cpSync(manifest, path.join(root, "manifest.json"));
}
