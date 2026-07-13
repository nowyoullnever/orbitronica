/** Main-process boundary for renderer supplied save payloads. */
export type ValidatedProjectSavePayload = {
  project: Record<string, unknown> & { projectName?: string };
  assets: Array<{ orbitId: string; fileName: string; bytes: Uint8Array }>;
};

export const PROJECT_PAYLOAD_LIMITS = {
  maxProjectBytes: 8_000_000,
  maxAssets: 256,
  maxAssetBytes: 128_000_000,
  maxTotalAssetBytes: 512_000_000
} as const;

function invalid(message: string): never { throw new Error(`Invalid project IPC payload: ${message}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Validate all renderer-controlled data before it reaches fs APIs. */
export function validateProjectSavePayload(payload: unknown): asserts payload is ValidatedProjectSavePayload {
  if (!isRecord(payload) || !isRecord(payload.project) || !Array.isArray(payload.assets)) invalid("malformed project or assets");
  let text: string;
  try { text = JSON.stringify(payload.project); } catch { invalid("project is not JSON serializable"); }
  if (new TextEncoder().encode(text).byteLength > PROJECT_PAYLOAD_LIMITS.maxProjectBytes) invalid("project exceeds size limit");
  const assets = payload.assets;
  if (assets.length > PROJECT_PAYLOAD_LIMITS.maxAssets) invalid("too many assets");
  const ids = new Set<string>(); let totalBytes = 0;
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.orbitId !== "string" || !asset.orbitId || asset.orbitId.length > 128 ||
      typeof asset.fileName !== "string" || !asset.fileName || asset.fileName.length > 255 || !(asset.bytes instanceof Uint8Array)) invalid("malformed asset");
    if (ids.has(asset.orbitId)) invalid("duplicate asset orbit ID");
    ids.add(asset.orbitId); totalBytes += asset.bytes.byteLength;
    if (asset.bytes.byteLength > PROJECT_PAYLOAD_LIMITS.maxAssetBytes || totalBytes > PROJECT_PAYLOAD_LIMITS.maxTotalAssetBytes) invalid("assets exceed size limit");
  }
}
