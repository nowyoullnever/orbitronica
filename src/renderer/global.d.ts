import type { SerializableProjectV4, SerializableProjectV5, SerializableProjectV6 } from "./state/types";

export {};

type ProjectAssetPayload = { orbitId: string; fileName: string; bytes: Uint8Array };
type SaveProjectPayload = {
  project: SerializableProjectV6 | SerializableProjectV5 | SerializableProjectV4;
  assets: ProjectAssetPayload[];
};
type ProjectAssetResult = { orbitId: string; bytes?: Uint8Array; error?: string };
type SampleFormat = "pcm16" | "pcm24" | "float32";
type AppPreferences = { export: { container: "wav"; sampleFormat: SampleFormat } };
type PreferencesPatch = { export?: { container?: unknown; sampleFormat?: unknown } };
type MenuAction = "open-project" | "save-project" | "save-project-as" | "preferences";

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
      getPreferences(): Promise<AppPreferences>;
      setPreferences(patch: PreferencesPatch): Promise<AppPreferences>;
      onMenuAction(listener: (action: MenuAction) => void): () => void;
    };
  }
}
