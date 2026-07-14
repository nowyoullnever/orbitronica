import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const id = "orbitronica-filter", root = path.resolve("public/wam", id), manifest = path.resolve("plugins/src", id, "manifest.json");
const source = JSON.parse(readFileSync(manifest, "utf8"));
source.assets = Object.fromEntries(readdirSync(root).filter((name) => name !== "manifest.json").sort().map((name) => [name, createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")]));
writeFileSync(manifest, `${JSON.stringify(source, null, 2)}\n`);
writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(source, null, 2)}\n`);
