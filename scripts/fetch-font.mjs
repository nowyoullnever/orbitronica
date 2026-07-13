// Downloads the Mapo Flower Island (마포꽃섬) UI font from noonnu's official
// web-font CDN. The font's license permits commercial use and embedding but
// PROHIBITS redistribution of the file, so we never vendor it in the repo —
// each machine fetches its own copy from the legitimate source instead.
//
// Source page:  https://noonnu.cc/font_page/381  (provider: Mapo-gu / 마포구)
// The app falls back to a system sans-serif if this file is missing, so a
// failed download must never break `npm install`.

import { createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const FONT_URL =
  "https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2001@1.1/MapoFlowerIslandA.woff";
const OUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "MapoFlowerIsland.woff");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await exists(OUT_PATH)) {
    console.log("✓ Mapo Flower Island font already present — skipping download.");
    return;
  }

  console.log(`↓ Fetching Mapo Flower Island font from ${FONT_URL}`);
  const response = await fetch(FONT_URL);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(OUT_PATH));
  } catch (error) {
    await rm(OUT_PATH, { force: true }); // don't leave a truncated file behind
    throw error;
  }
  console.log("✓ Font installed at ./MapoFlowerIsland.woff");
}

main().catch((error) => {
  // Non-fatal by design: warn, but keep the exit code clean so install succeeds.
  console.warn(
    `\n⚠ Could not download the Mapo Flower Island font (${error.message}).\n` +
      "  The app will fall back to a system sans-serif. To install it later, run:\n" +
      "    npm run fetch:font\n" +
      "  or download it manually from https://noonnu.cc/font_page/381\n",
  );
});
