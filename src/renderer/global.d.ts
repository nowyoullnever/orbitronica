import type { SerializableProjectV4, SerializableProjectV5 } from "./state/types";

export {};

type ProjectAssetPayload = { orbitId: string; fileName: string; bytes: Uint8Array };
type SaveProjectPayload = {
  project: SerializableProjectV5 | SerializableProjectV4;
  assets: ProjectAssetPayload[];
};
type ProjectAssetResult = { orbitId: string; bytes?: Uint8Array; error?: string };

declare global {
  interface Window {
    orbitonicAPI?: {
      saveProject(payload: SaveProjectPayload, currentPath?: string): Promise<{
        ok: boolean; path?: string; error?: string; canceled?: boolean
      }>;
      openProject(): Promise<{
        ok: boolean;
        path?: string;
        text?: string;
        assets?: ProjectAssetResult[];
        error?: string;
        canceled?: boolean;
      }>;
      saveRecording(bytes: Uint8Array, suggestedName: string): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
    };
  }
}
