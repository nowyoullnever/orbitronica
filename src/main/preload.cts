import { contextBridge, ipcRenderer } from "electron";

type SaveProjectPayload = {
  project: Record<string, unknown>;
  assets: Array<{ orbitId: string; fileName: string; bytes: Uint8Array }>;
};

contextBridge.exposeInMainWorld("orbitonicAPI", {
  saveProject: (payload: SaveProjectPayload, currentPath?: string) =>
    ipcRenderer.invoke("project:save", payload, currentPath),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveRecording: (bytes: Uint8Array, suggestedName: string) =>
    ipcRenderer.invoke("recording:save", bytes, suggestedName)
});
