import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orbitonicAPI", {
  saveProject: (payload: unknown, currentPath?: string) =>
    ipcRenderer.invoke("project:save", payload, currentPath),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveRecording: (bytes: Uint8Array, suggestedName: string) =>
    ipcRenderer.invoke("recording:save", bytes, suggestedName)
});
