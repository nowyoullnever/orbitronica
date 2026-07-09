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
      saveRecording(bytes: Uint8Array, suggestedName: string): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
    };
  }
}
