import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        app: path.resolve(import.meta.dirname, "index.html"),
        wamSmoke: path.resolve(import.meta.dirname, "wam-smoke.html")
      }
    }
  }
});
