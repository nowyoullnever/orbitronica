import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeProjectAssets, portableAudioPath, rewriteProjectAudioPaths
} from "./projectAssets.js";
import { PreferencesStore } from "./preferences.js";
import { newProjectPath, projectDialogExtensions } from "./projectPaths.js";
import { validateProjectSavePayload } from "./projectPayload.js";
import { installAppMenu } from "./appMenu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("Orbitronica");

function createWindow() {
  const wamSmoke = process.argv.includes("--wam-smoke");
  const wamDspTest = process.argv.includes("--wam-dsp-test");
  const pcm16ColdCache = process.argv.includes("--pcm16-cold-cache");
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f3ee",
    title: "Orbitronica",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWindow = win;

  if (wamSmoke || wamDspTest) {
    const marker = wamDspTest ? "ORBITRONICA_WAM_DSP" : "ORBITRONICA_WAM_SMOKE";
    const timeout = setTimeout(() => {
      console.error(`${marker} {\"status\":\"fail\",\"error\":\"renderer timeout\"}`);
      app.exit(1);
    }, wamDspTest ? 90_000 : 30_000);
    win.webContents.on("console-message", (_event, _level, message) => {
      if (!message.startsWith(`${marker} `)) return;
      clearTimeout(timeout);
      console.log(message);
      app.exit(message.includes('"status":"pass"') ? 0 : 1);
    });
    win.webContents.on("did-fail-load", (_event, _errorCode, errorDescription) => {
      clearTimeout(timeout);
      console.error(`${marker} {"status":"fail","error":${JSON.stringify(errorDescription)}}`);
      app.exit(1);
    });
  }

  if (process.argv.includes("--dev")) {
    void win.loadURL("http://localhost:5173");
  } else {
    void win.loadFile(
      path.join(__dirname, "../dist", wamDspTest ? "wam-dsp-test.html" : wamSmoke ? "wam-smoke.html" : "index.html"),
      pcm16ColdCache && !wamSmoke && !wamDspTest ? { query: { pcm16ColdCache: "1" } } : undefined
    );
  }
}

let preferencesStore: PreferencesStore | undefined;
let mainWindow: BrowserWindow | undefined;
let activeProjectPath: string | undefined;

function ipcFailure(message: string): never { throw new Error(`Invalid project IPC payload: ${message}`); }
function requireTrustedSender(event: IpcMainInvokeEvent) {
  // A sandboxed renderer can still be compromised; only the window we created may
  // request project filesystem operations. Do not use sender supplied paths as authority.
  if (!mainWindow || event.sender !== mainWindow.webContents) ipcFailure("untrusted sender");
}

function getPreferencesStore() {
  preferencesStore ??= new PreferencesStore(path.join(app.getPath("userData"), "preferences.json"));
  return preferencesStore;
}

ipcMain.handle("preferences:get", (event) => {
  requireTrustedSender(event);
  return getPreferencesStore().get();
});
ipcMain.handle("preferences:set", (event, patch) => {
  requireTrustedSender(event);
  return getPreferencesStore().set(patch);
});

ipcMain.handle("project:save", async (event, payload: unknown, currentPath?: unknown) => {
  try {
    requireTrustedSender(event);
    validateProjectSavePayload(payload);
    // The renderer can request a save, but it never grants itself a filesystem path.
    // Existing paths must have originated from this main process's dialog/open flow.
    let projectPath = typeof currentPath === "string" && currentPath === activeProjectPath ? activeProjectPath : undefined;
    if (!projectPath) {
      const result = await dialog.showSaveDialog({
        title: "Save Orbitronica Project",
        defaultPath: `${payload.project.projectName ?? "Untitled Session"}.orb`,
        filters: [{ name: "Orbitronica Project", extensions: projectDialogExtensions }]
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
    activeProjectPath = projectPath;
    return { ok: true, path: projectPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("project:open", async (event) => {
  try {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Open Orbitronica Project",
      properties: ["openFile"],
      filters: [{ name: "Orbitronica Project", extensions: projectDialogExtensions }]
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
    activeProjectPath = projectPath;
    return { ok: true, path: projectPath, text, assets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("recording:save", async (event, bytes: Uint8Array, suggestedName: string) => {
  try {
    requireTrustedSender(event);
    const result = await dialog.showSaveDialog({
      title: "Save Recording",
      defaultPath: suggestedName,
      filters: [{ name: "WAV Audio", extensions: ["wav"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const filePath = /\.wav$/i.test(result.filePath) ? result.filePath : `${result.filePath}.wav`;
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
