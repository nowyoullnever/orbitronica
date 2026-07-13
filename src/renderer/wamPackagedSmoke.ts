import { initializeWamHost } from "@webaudiomodules/sdk";
import { adaptWamInstance } from "./audio/wamCatalog.ts";
import { OrbitWamRack } from "./audio/wamRack.ts";
import { cloneJsonValue } from "./audio/wamHost.ts";

type DelayNode = AudioNode & {
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  destroy(): Promise<void> | void;
};

type DelayInstance = {
  audioNode: DelayNode;
  createGui(): Promise<HTMLElement>;
  destroyGui(gui: HTMLElement): void;
};

type DelayConstructor = {
  createInstance(groupId: string, context: AudioContext): Promise<DelayInstance>;
};

const result = document.querySelector<HTMLElement>("#result");
const report = (status: "pass" | "fail", detail: Record<string, unknown>) => {
  const payload = { status, ...detail };
  result!.textContent = JSON.stringify(payload);
  console.log(`ORBITRONICA_WAM_SMOKE ${JSON.stringify(payload)}`);
};

async function run() {
  const context = new AudioContext();
  let instance: DelayInstance | undefined;
  let cleanupInvoked = false;
  try {
    await context.resume();
    // The recorder is registered on the same real context before the WAM host.
    // This catches AudioWorklet registration/name coexistence in the packaged
    // file-origin renderer without starting a user recording/export.
    const recorderUrl = new URL("./audio/recorder-processor.js", import.meta.url).toString();
    await context.audioWorklet.addModule(recorderUrl);
    const recorder = new AudioWorkletNode(context, "orbitronica-pcm-capture");

    const [groupId] = await initializeWamHost(context) as [string, string];
    const entryUrl = new URL("./wam/burns-simple-delay/index.js", window.location.href).toString();
    const module = await import(/* @vite-ignore */ entryUrl) as { default: DelayConstructor };
    instance = await module.default.createInstance(groupId, context);
    const hosted = adaptWamInstance(instance);
    const destroy = hosted.destroy;
    hosted.destroy = () => {
      cleanupInvoked = true;
      return destroy?.();
    };
    const input = context.createGain();
    const destination = context.createGain();
    destination.connect(recorder);
    const rack = new OrbitWamRack(
      input,
      destination,
      async () => hosted,
      new Map(),
      () => undefined,
      { cleanupDeadlineMs: 1_000, stateDeadlineMs: 5_000 },
    );
    const slot = {
      id: "packaged-burns-delay",
      catalogId: "burns-simple-delay",
      pluginVersion: "0.2.54",
      bypassed: false,
    } as const;
    await rack.reconcile([slot]);
    const before = await hosted.getState?.();
    if (before !== undefined) await hosted.setState?.(cloneJsonValue(before));
    const after = await hosted.getState?.();
    await rack.mountGui(slot.id, document.body);

    let removalTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      rack.reconcile([]),
      new Promise<never>((_, reject) => {
        removalTimer = setTimeout(
          () => reject(new Error("Rack removal waited for third-party cleanup.")),
          1_000,
        );
      }),
    ]);
    if (removalTimer) clearTimeout(removalTimer);
    if (!cleanupInvoked) throw new Error("Rack removal did not invoke plugin cleanup.");

    destination.disconnect(recorder);
    recorder.disconnect();
    instance = undefined;
    await context.close();
    report("pass", {
      origin: window.location.protocol,
      entryUrl,
      recorderAndWamSharedContext: true,
      stateRoundTrip: before !== undefined && after !== undefined,
      asyncGuiLifecycle: true,
      destroyed: true,
      rackRemovalCompleted: true,
      cleanupDidNotBlockHost: true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined"
    });
  } catch (error) {
    try { instance?.audioNode.destroy(); } catch { /* best-effort smoke cleanup */ }
    try { await context.close(); } catch { /* best-effort smoke cleanup */ }
    report("fail", { origin: window.location.protocol, error: error instanceof Error ? error.message : String(error) });
  }
}

void run();
