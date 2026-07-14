import { initializeWamHost } from "@webaudiomodules/sdk";
import { WAM_CATALOG, adaptWamInstance, catalogEntryUrl } from "./audio/wamCatalog.ts";
import { OrbitWamRack } from "./audio/wamRack.ts";
import { cloneJsonValue } from "./audio/wamHost.ts";

type SmokeEvent = { catalogId: string; phase: string; durationMs: number; ok: boolean; error?: string };
type WamNode = AudioNode & { getState?(): Promise<unknown>; setState?(state: unknown): Promise<void>; destroy?(): Promise<void> | void };
type WamInstance = { audioNode: WamNode; createGui?(): Promise<HTMLElement>; destroyGui?(gui: HTMLElement): void };
type WamConstructor = { createInstance(groupId: string, context: AudioContext): Promise<WamInstance> };
const result = document.querySelector<HTMLElement>("#result");
const events: SmokeEvent[] = [];
const report = (status: "pass" | "fail", detail: Record<string, unknown>) => {
  const payload = { status, origin: window.location.protocol, events, ...detail };
  result!.textContent = JSON.stringify(payload);
  console.log(`ORBITRONICA_WAM_SMOKE ${JSON.stringify(payload)}`);
};
async function phase<T>(catalogId: string, name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { const value = await run(); events.push({ catalogId, phase: name, durationMs: performance.now() - started, ok: true }); return value; }
  catch (error) { events.push({ catalogId, phase: name, durationMs: performance.now() - started, ok: false, error: error instanceof Error ? error.message : String(error) }); throw error; }
}

async function smokeEntry(catalogId: string, entry: typeof WAM_CATALOG[keyof typeof WAM_CATALOG], context: AudioContext, groupId: string, recorder: AudioNode) {
  const entryUrl = catalogEntryUrl(entry);
  const imported = await phase(catalogId, "asset-fetch-import", () => import(/* @vite-ignore */ entryUrl) as Promise<{ default?: WamConstructor }>);
  if (!imported.default || typeof imported.default.createInstance !== "function") throw new Error("catalog-module-invalid");
  events.push({ catalogId, phase: "module-contract", durationMs: 0, ok: true });
  const instance = await phase(catalogId, "create-instance", () => imported.default!.createInstance(groupId, context));
  const hosted = adaptWamInstance(instance);
  const input = context.createGain(); const destination = context.createGain(); destination.connect(recorder);
  const rack = new OrbitWamRack(input, destination, async () => hosted, new Map(), () => undefined, { cleanupDeadlineMs: 1_000, stateDeadlineMs: 5_000 });
  const slot = { id: `packaged-${catalogId}`, catalogId, pluginVersion: entry.pluginVersion, bypassed: false } as const;
  await phase(catalogId, "connect-render", () => rack.reconcile([slot]));
  const before = await phase(catalogId, "get-set-state", async () => { const state = await hosted.getState?.(); if (state !== undefined) await hosted.setState?.(cloneJsonValue(state)); return state; });
  if (hosted.createGui) await phase(catalogId, "gui-create-destroy", async () => { await rack.mountGui(slot.id, document.body); await rack.unmountGui(slot.id); });
  await phase(catalogId, "node-destroy-removal", () => rack.reconcile([]));
  destination.disconnect(); input.disconnect();
  return { entryUrl, stateRoundTrip: before !== undefined };
}

async function run() {
  const context = new AudioContext();
  try {
    await context.resume();
    const recorderUrl = new URL("./audio/recorder-processor.js", import.meta.url).toString();
    await context.audioWorklet.addModule(recorderUrl);
    const recorder = new AudioWorkletNode(context, "orbitronica-pcm-capture");
    const [groupId] = await initializeWamHost(context) as [string, string];
    const results = [];
    for (const [catalogId, entry] of Object.entries(WAM_CATALOG)) results.push(await smokeEntry(catalogId, entry, context, groupId, recorder));
    recorder.disconnect(); await context.close();
    report("pass", { results, recorderAndWamSharedContext: true, rackRemovalCompleted: true, cleanupDidNotBlockHost: true, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined" });
  } catch (error) {
    try { await context.close(); } catch { /* best effort */ }
    report("fail", { error: error instanceof Error ? error.message : String(error) });
  }
}
void run();
