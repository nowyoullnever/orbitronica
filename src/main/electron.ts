import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeProjectAssets, portableAudioPath, rewriteProjectAudioPaths
} from "./projectAssets.js";
import { newProjectPath, projectDialogExtensions } from "./projectPaths.js";
import { PreferencesStore } from "./preferences.js";
import { installAppMenu } from "./appMenu.js";

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
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
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
  project: Record<string, unknown> & { projectName?: string };
  assets: Array<{ orbitId: string; fileName: string; bytes: Uint8Array }>;
};

let preferencesStore: PreferencesStore | undefined;

function getPreferencesStore() {
  preferencesStore ??= new PreferencesStore(path.join(app.getPath("userData"), "preferences.json"));
  return preferencesStore;
}

ipcMain.handle("preferences:get", () => getPreferencesStore().get());
ipcMain.handle("preferences:set", (_event, patch) => getPreferencesStore().set(patch));

ipcMain.handle("project:save", async (_event, payload: SavePayload, currentPath?: string) => {
  try {
    let projectPath = currentPath;
    if (!projectPath) {
      const result = await dialog.showSaveDialog({
        title: "Save Orbitonic Project",
        defaultPath: `${payload.project.projectName ?? "Untitled Session"}.orb`,
        filters: [{ name: "Orbitonic Project", extensions: projectDialogExtensions }]
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      projectPath = newProjectPath(result.filePath);
    }
    const projectDir = path.dirname(projectPath);
    const audioDir = path.join(projectDir, "audio");
    await fs.mkdir(audioDir, { recursive: true });
    const usedNames = new Set<string>();
    const audioPaths = new Map<string, string>();
    for (let index = 0; index < payload.assets.length; index++) {
      const asset = payload.assets[index];
      const safeBase = asset.fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
      let name = `${String(index + 1).padStart(3, "0")}_${safeBase}`;
      let suffix = 2;
      while (usedNames.has(name)) name = `${String(index + 1).padStart(3, "0")}_${suffix++}_${safeBase}`;
      usedNames.add(name);
      await fs.writeFile(path.join(audioDir, name), Buffer.from(asset.bytes));
      audioPaths.set(asset.orbitId, portableAudioPath(name));
    }
    const project = rewriteProjectAudioPaths(payload.project, audioPaths);
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
      filters: [{ name: "Orbitonic Project", extensions: projectDialogExtensions }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const projectPath = result.filePaths[0];
    const text = await fs.readFile(projectPath, "utf8");
    const project = JSON.parse(text) as unknown;
    const assets: Array<{ orbitId: string; bytes?: Uint8Array; error?: string }> = [];
    for (const descriptor of describeProjectAssets(project, path.dirname(projectPath))) {
      if (descriptor.error || !descriptor.absolutePath) {
        assets.push({ orbitId: descriptor.orbitId, error: descriptor.error ?? "No audio path saved." });
        continue;
      }
      try {
        const bytes = await fs.readFile(descriptor.absolutePath);
        assets.push({ orbitId: descriptor.orbitId, bytes: new Uint8Array(bytes) });
      } catch {
        assets.push({ orbitId: descriptor.orbitId, error: `Missing audio: ${descriptor.audioPath}` });
      }
    }
    return { ok: true, path: projectPath, text, assets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("recording:save", async (_event, bytes: Uint8Array, suggestedName: string) => {
  try {
    const result = await dialog.showSaveDialog({
      title: "Save Recording",
      defaultPath: suggestedName,
      filters: [{ name: "WebM Audio", extensions: ["webm"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const filePath = result.filePath.endsWith(".webm") ? result.filePath : `${result.filePath}.webm`;
    await fs.writeFile(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(() => {
  installAppMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
