import { initializeWamHost } from "@webaudiomodules/sdk";
import { WAM_CATALOG, adaptWamInstance, catalogEntryUrl } from "./audio/wamCatalog.ts";
import { OrbitWamRack } from "./audio/wamRack.ts";
import { cloneJsonValue } from "./audio/wamHost.ts";

type SmokeEvent = { catalogId: string; phase: string; durationMs: number; ok: boolean; error?: string };
type WamNode = AudioNode & { getState?(): Promise<unknown>; setState?(state: unknown): Promise<void>; destroy?(): Promise<void> | void; setParameterValues?(values: Record<string, { value: number }>): Promise<void>; getParameterValues?(normalized?: boolean, ...ids: string[]): Promise<Record<string, { value: number }>> };
type BurnsEqNode = WamNode & { paramMgr?: { getState(): Promise<unknown>; setState(state: Record<string, number>): Promise<void>; getParamsValues(): Record<string, number> } };
const PARAMETER_PROBES: Record<string, Record<string, unknown>> = {
  "burns-simple-eq": { lowGain: -9, lowFrequency: 180, mediumGain: 7, mediumFrequency: 1200, mediumQuality: .3, highGain: 8, highFrequency: 6500 },
  "orbitronica-overdrive": { drive: .8, tone: 2400, outputGain: 5, mix: .65 },
  "orbitronica-compressor": { threshold: -40, knee: 8, ratio: 12, attack: .2, release: .8, makeupGain: 6 },
  "orbitronica-bitcrusher": { bitDepth: 3, reduction: 8, mix: .65 },
  "orbitronica-flanger": { rate: 2.4, depth: .007, feedback: .6, mix: .65 },
  "orbitronica-phaser": { rate: 1.7, depth: .8, stages: 7, feedback: .6, mix: .65 },
  "orbitronica-reverb": { roomSize: .8, damping: .55, width: .7, mix: .65 },
  "orbitronica-filter": { type: "peaking", frequency: 1800, Q: 3, gain: 9 },
};
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
  if (catalogId === "orbitronica-bitcrusher") await phase(catalogId, "minimal-wamprocessor-packaged-proof", async () => {
    const proof = imported as typeof imported & { proveMinimalWamProcessor?: (group: string, audio: AudioContext) => Promise<void> };
    if (!proof.proveMinimalWamProcessor) throw new Error("minimal-wamprocessor-proof-missing");
    await proof.proveMinimalWamProcessor(groupId, context);
  });
  if (catalogId === "orbitronica-bitcrusher") await phase(catalogId, "worklet-multi-instance-registration", async () => {
    const [first, second] = await Promise.all([imported.default!.createInstance(groupId, context), imported.default!.createInstance(groupId, context)]);
    if (first.audioNode === second.audioNode) throw new Error("worklet-instances-not-independent");
    first.audioNode.destroy?.(); second.audioNode.destroy?.();
  });
  const instance = await phase(catalogId, "create-instance", () => imported.default!.createInstance(groupId, context));
  const hosted = adaptWamInstance(instance);
  const input = context.createGain(); const destination = context.createGain(); destination.connect(recorder);
  const rack = new OrbitWamRack(input, destination, async () => hosted, new Map(), () => undefined, { cleanupDeadlineMs: 1_000, stateDeadlineMs: 5_000 });
  const slot = { id: `packaged-${catalogId}`, catalogId, pluginVersion: entry.pluginVersion, bypassed: false } as const;
  await phase(catalogId, "connect-render", () => rack.reconcile([slot]));
  const before = await phase(catalogId, "get-set-state", async () => { const state = await hosted.getState?.(); if (state !== undefined) await hosted.setState?.(cloneJsonValue(state)); return state; });
  const probe = PARAMETER_PROBES[catalogId];
  if (probe) await phase(catalogId, "parameter-state-restore", async () => {
    if (catalogId.startsWith("orbitronica-")) { await hosted.setState?.({ schemaVersion: 1, params: probe } as never); const restored = await hosted.getState?.(); if (JSON.stringify(restored) !== JSON.stringify({ schemaVersion: 1, params: probe })) throw new Error("state-restore-mismatch"); }
    else { const paramMgr = (instance.audioNode as BurnsEqNode).paramMgr; if (!paramMgr) throw new Error("parameter-api-missing"); await paramMgr.setState(probe as Record<string, number>); const values = paramMgr.getParamsValues(); for (const [id, value] of Object.entries(probe)) if (typeof value !== "number" || Math.abs(values[id] - value) > 1e-6) throw new Error(`parameter-mismatch:${id}:${values[id]}`); const restored = await paramMgr.getState(); if (!Object.values(probe).every((value) => JSON.stringify(restored).includes(String(value)))) throw new Error("state-restore-mismatch"); await paramMgr.setState(cloneJsonValue(restored) as Record<string, number>); }
  });
  if (["orbitronica-overdrive", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"].includes(catalogId)) await phase(catalogId, "strict-malformed-state-rejection", async () => {
    const initial = await hosted.getState?.();
    for (const malformed of [[], 1, { schemaVersion: 1, params: [] }, { schemaVersion: 1, params: 1 }, JSON.parse('{"schemaVersion":1,"params":{"__proto__":{"polluted":true}}}')]) {
      let rejected = false; try { await hosted.setState?.(malformed); } catch { rejected = true; }
      if (!rejected) throw new Error("malformed-state-accepted");
      if (JSON.stringify(await hosted.getState?.()) !== JSON.stringify(initial)) throw new Error("malformed-state-not-atomic");
    }
  });
  await phase(catalogId, "lifecycle-25-cycles", async () => {
    for (let cycle = 0; cycle < 25; cycle++) await rack.reconcile(cycle % 2 ? [] : [slot]);
    await rack.reconcile([slot]);
  });
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
