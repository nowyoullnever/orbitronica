export {};

declare global {
  interface Window {
    orbitonicAPI?: {
      saveProject(payload: unknown, currentPath?: string): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
      openProject(): Promise<{
        ok: boolean;
        path?: string;
        text?: string;
        assets?: Array<{ orbitId: string; bytes?: Uint8Array; error?: string }>;
        error?: string;
        canceled?: boolean;
      }>;
      loadAutomationSample(filePath: string): Promise<{
        ok: boolean; fileName?: string; bytes?: Uint8Array; error?: string;
      }>;
      saveRecording(payload: { fileName: string; mimeType: string; data: ArrayBuffer }): Promise<{
        ok: boolean; path?: string; error?: string; canceled?: boolean;
      }>;
    };
  }
}
