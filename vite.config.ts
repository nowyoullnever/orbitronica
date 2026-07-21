import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();

export default defineConfig({
  define: {
    __ORBITRONICA_BUILD_COMMIT__: JSON.stringify(buildCommit)
  },
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        app: path.resolve(import.meta.dirname, "index.html"),
        wamSmoke: path.resolve(import.meta.dirname, "wam-smoke.html"),
        wamDspTest: path.resolve(import.meta.dirname, "wam-dsp-test.html"),
        audioCacheSmoke: path.resolve(import.meta.dirname, "audio-cache-smoke.html")
      }
    }
  }
});
