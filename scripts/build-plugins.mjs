import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const firstPartyIds = ["orbitronica-filter", "orbitronica-overdrive", "orbitronica-compressor", "orbitronica-bitcrusher", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"];
// A verifier may direct builds to an empty tree. Normal production builds retain
// the established public/wam output and never touch vendored Burns artifacts.
const outputRoot = path.resolve(process.env.ORBITRONICA_PLUGIN_OUTPUT ?? "public/wam");
for (const id of firstPartyIds) {
  const source = path.resolve("plugins/src", id);
  const output = path.join(outputRoot, id);
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  await build({ entryPoints: [path.join(source, "index.ts")], outfile: path.join(output, "index.js"), bundle: true, format: "esm", target: "es2022", legalComments: "none" });
  for (const name of ["descriptor.json", "NOTICE.txt", "manifest.json"]) cpSync(path.join(source, name), path.join(output, name));
  if (!existsSync(path.join(output, "index.js"))) throw new Error(`${id} build did not produce index.js`);
}
