import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const evidence = "plugins/src/orbitronica-reverb/clean-room-evidence.md";
execFileSync("git", ["ls-files", "--error-unmatch", evidence], { stdio: "inherit" });
const text = readFileSync(evidence, "utf8");
for (const required of ["85fd86a014b40219a63ae1016955f87c37a27b5d", "a7c89f728a4e7a1fa6403c178d8d04f5616e12ef93ffea9ecdc432ca91641851", "reviewer sign-off"]) if (!text.toLowerCase().includes(required.toLowerCase())) throw new Error(`clean-room evidence missing ${required}`);
const forbidden = /freeverb3|gnu general public license|\bgpl\b|\blgpl\b/i;
for (const file of ["plugins/src/orbitronica-reverb/index.ts", "public/wam/orbitronica-reverb/index.js"]) {
  const source = readFileSync(file, "utf8");
  if (forbidden.test(source)) throw new Error(`prohibited derivative material found in ${file}`);
}
console.log(`Verified reverb clean-room evidence and source scan (${createHash("sha256").update(text).digest("hex")}).`);
