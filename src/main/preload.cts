import { contextBridge, ipcRenderer } from "electron";

type SampleFormat = "pcm16" | "pcm24" | "float32";
type AppPreferences = { export: { container: "wav"; sampleFormat: SampleFormat } };
type PreferencesPatch = { export?: { container?: unknown; sampleFormat?: unknown } };
type MenuAction = "open-project" | "save-project" | "save-project-as" | "preferences";

type SaveProjectPayload = {
  project: Record<string, unknown>;
  assets: Array<{ orbitId: string; fileName: string; bytes: Uint8Array }>;
};

contextBridge.exposeInMainWorld("orbitonicAPI", {
  saveProject: (payload: SaveProjectPayload, currentPath?: string) =>
    ipcRenderer.invoke("project:save", payload, currentPath),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveRecording: (bytes: Uint8Array, suggestedName: string) =>
    ipcRenderer.invoke("recording:save", bytes, suggestedName),
  getPreferences: (): Promise<AppPreferences> => ipcRenderer.invoke("preferences:get"),
  setPreferences: (patch: PreferencesPatch): Promise<AppPreferences> => ipcRenderer.invoke("preferences:set", patch),
  onMenuAction: (listener: (action: MenuAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on("menu:action", handler);
    return () => ipcRenderer.removeListener("menu:action", handler);
  }
});
