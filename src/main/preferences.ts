import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SampleFormat = "pcm16" | "pcm24" | "float32";

export type AppPreferences = {
  export: {
    container: "wav";
    sampleFormat: SampleFormat;
  };
};

export type PreferencesPatch = {
  export?: {
    container?: unknown;
    sampleFormat?: unknown;
  };
};

export const DEFAULT_PREFERENCES: AppPreferences = {
  export: { container: "wav", sampleFormat: "pcm16" }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Converts untrusted file contents or IPC patches to the one supported schema. */
export function normalizePreferences(value: unknown): AppPreferences {
  const exportValue = isRecord(value) && isRecord(value.export) ? value.export : {};
  return {
    export: {
      container: "wav",
      sampleFormat: exportValue.sampleFormat === "pcm24" || exportValue.sampleFormat === "float32"
        ? exportValue.sampleFormat
        : "pcm16"
    }
  };
}

/** Nested merge is deliberately limited to the public preference schema. */
export function mergePreferences(current: AppPreferences, patch: unknown): AppPreferences {
  const exportPatch = isRecord(patch) && isRecord(patch.export) ? patch.export : {};
  return normalizePreferences({ export: { ...current.export, ...exportPatch } });
}

export async function readPreferences(filePath: string): Promise<AppPreferences> {
  try {
    return normalizePreferences(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

async function writePreferences(filePath: string, preferences: AppPreferences): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    // Do not delete the old file first: a failed replacement must preserve it.
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Serializes full read/merge/write transactions so overlapping partial patches cannot lose data. */
export class PreferencesStore {
  private queue: Promise<void> = Promise.resolve();
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get(): Promise<AppPreferences> {
    return readPreferences(this.filePath);
  }

  set(patch: PreferencesPatch): Promise<AppPreferences> {
    const transaction = this.queue.then(async () => {
      const next = mergePreferences(await readPreferences(this.filePath), patch);
      await writePreferences(this.filePath, next);
      return readPreferences(this.filePath);
    });
    this.queue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }
}
