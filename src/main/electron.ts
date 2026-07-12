import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f3ee",
    title: "Orbitonic MVP",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (process.argv.includes("--dev")) {
    void win.loadURL("http://localhost:5173");
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

type SavePayload = {
  project: Record<string, unknown> & {
    projectName?: string;
    orbits?: Array<{ id: string; audioName: string; audioPath?: string }>;
  };
  assets: Array<{ orbitId: string; fileName: string; bytes: Uint8Array }>;
};

ipcMain.handle("project:save", async (_event, payload: SavePayload, currentPath?: string) => {
  try {
    let projectPath = currentPath;
    if (!projectPath) {
      const result = await dialog.showSaveDialog({
        title: "Save Orbitonic Project",
        defaultPath: `${payload.project.projectName ?? "Untitled Session"}.orbitonic`,
        filters: [{ name: "Orbitonic Project", extensions: ["orbitonic"] }]
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      projectPath = result.filePath.endsWith(".orbitonic") ? result.filePath : `${result.filePath}.orbitonic`;
    }
    const projectDir = path.dirname(projectPath);
    const audioDir = path.join(projectDir, "audio");
    await fs.mkdir(audioDir, { recursive: true });
    const usedNames = new Set<string>();
    const audioPaths: Record<string, string> = {};
    for (let index = 0; index < payload.assets.length; index++) {
      const asset = payload.assets[index];
      const safeBase = asset.fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
      let name = `${String(index + 1).padStart(3, "0")}_${safeBase}`;
      let suffix = 2;
      while (usedNames.has(name)) name = `${String(index + 1).padStart(3, "0")}_${suffix++}_${safeBase}`;
      usedNames.add(name);
      await fs.writeFile(path.join(audioDir, name), Buffer.from(asset.bytes));
      audioPaths[asset.orbitId] = `audio/${name}`;
    }
    const project = structuredClone(payload.project) as SavePayload["project"];
    if (Array.isArray(project.orbits)) {
      project.orbits = project.orbits.map((orbit) => ({
        ...orbit, audioPath: audioPaths[orbit.id] ?? orbit.audioPath
      }));
    }
    await fs.writeFile(projectPath, JSON.stringify(project, null, 2), "utf8");
    return { ok: true, path: projectPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("project:open", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "Open Orbitonic Project",
      properties: ["openFile"],
      filters: [{ name: "Orbitonic Project", extensions: ["orbitonic"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const projectPath = result.filePaths[0];
    const text = await fs.readFile(projectPath, "utf8");
    const project = JSON.parse(text) as { orbits?: Array<{ id: string; audioPath?: string }> };
    const assets: Array<{ orbitId: string; bytes?: Uint8Array; error?: string }> = [];
    for (const orbit of project.orbits ?? []) {
      if (!orbit.audioPath) {
        assets.push({ orbitId: orbit.id, error: "No audio path saved." });
        continue;
      }
      try {
        const bytes = await fs.readFile(path.resolve(path.dirname(projectPath), orbit.audioPath));
        assets.push({ orbitId: orbit.id, bytes: new Uint8Array(bytes) });
      } catch {
        assets.push({ orbitId: orbit.id, error: `Missing audio: ${orbit.audioPath}` });
      }
    }
    return { ok: true, path: projectPath, text, assets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

type RecordingSavePayload = {
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
};

ipcMain.handle("recording:save", async (_event, payload: RecordingSavePayload) => {
  try {
    const safeName = path.basename(payload.fileName).replace(/[^a-zA-Z0-9._-]/g, "_") || "orbitonic-recording.wav";
    const result = await dialog.showSaveDialog({
      title: "Save Live Recording",
      defaultPath: safeName.endsWith(".wav") ? safeName : `${safeName}.wav`,
      filters: [{ name: "WAV Audio", extensions: ["wav"] }, { name: "All Files", extensions: ["*"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const filePath = result.filePath.endsWith(".wav") ? result.filePath : `${result.filePath}.wav`;
    await fs.writeFile(filePath, Buffer.from(payload.data));
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
