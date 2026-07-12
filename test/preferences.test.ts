import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PREFERENCES, PreferencesStore, mergePreferences, normalizePreferences, readPreferences
} from "../src/main/preferences.ts";

async function temporaryStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbitronica-preferences-"));
  return { directory, filePath: path.join(directory, "preferences.json"), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("preferences normalize missing, malformed, and invalid values to canonical defaults", async () => {
  const fixture = await temporaryStore();
  try {
    assert.deepEqual(await readPreferences(fixture.filePath), DEFAULT_PREFERENCES);
    await fs.writeFile(fixture.filePath, "{broken", "utf8");
    assert.deepEqual(await readPreferences(fixture.filePath), DEFAULT_PREFERENCES);
    assert.deepEqual(normalizePreferences({ export: { container: "webm", sampleFormat: "bad" }, unknown: true }), DEFAULT_PREFERENCES);
    assert.deepEqual(mergePreferences(DEFAULT_PREFERENCES, { export: { sampleFormat: "pcm24" } }), {
      export: { container: "wav", sampleFormat: "pcm24" }
    });
  } finally { await fixture.cleanup(); }
});

test("preferences store deep-merges, writes canonical JSON, and cleans temporary files", async () => {
  const fixture = await temporaryStore();
  try {
    const store = new PreferencesStore(fixture.filePath);
    assert.deepEqual(await store.set({ export: { sampleFormat: "float32" } }), {
      export: { container: "wav", sampleFormat: "float32" }
    });
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.filePath, "utf8")), {
      export: { container: "wav", sampleFormat: "float32" }
    });
    assert.deepEqual((await fs.readdir(fixture.directory)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await fixture.cleanup(); }
});

test("preferences store queues overlapping partial updates in invocation order", async () => {
  const fixture = await temporaryStore();
  try {
    const store = new PreferencesStore(fixture.filePath);
    const first = store.set({ export: { sampleFormat: "pcm24" } });
    const second = store.set({ export: { container: "not-wav", sampleFormat: "float32" } });
    await Promise.all([first, second]);
    assert.deepEqual(await store.get(), { export: { container: "wav", sampleFormat: "float32" } });
  } finally { await fixture.cleanup(); }
});
