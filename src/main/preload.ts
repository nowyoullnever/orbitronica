import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orbitonicAPI", {
  saveProject: (payload: unknown, currentPath?: string) =>
    ipcRenderer.invoke("project:save", payload, currentPath),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveRecording: (payload: { fileName: string; mimeType: string; data: ArrayBuffer }) =>
    ipcRenderer.invoke("recording:save", payload)
});
