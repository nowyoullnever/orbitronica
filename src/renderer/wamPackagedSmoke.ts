import { initializeWamHost } from "@webaudiomodules/sdk";

type DelayNode = AudioNode & {
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  destroy(): void;
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
  let gui: HTMLElement | undefined;
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
    const before = await instance.audioNode.getState();
    await instance.audioNode.setState(before);
    const after = await instance.audioNode.getState();

    gui = await instance.createGui();
    if (!(gui instanceof HTMLElement)) throw new Error("Delay createGui() did not return an HTMLElement.");
    document.body.append(gui);
    instance.destroyGui(gui);
    gui.remove();
    gui = undefined;

    instance.audioNode.connect(recorder);
    instance.audioNode.disconnect(recorder);
    recorder.disconnect();
    instance.audioNode.destroy();
    instance = undefined;
    await context.close();
    report("pass", {
      origin: window.location.protocol,
      entryUrl,
      recorderAndWamSharedContext: true,
      stateRoundTrip: before !== undefined && after !== undefined,
      asyncGuiLifecycle: true,
      destroyed: true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined"
    });
  } catch (error) {
    try { gui && instance?.destroyGui(gui); } catch { /* best-effort smoke cleanup */ }
    try { instance?.audioNode.destroy(); } catch { /* best-effort smoke cleanup */ }
    try { await context.close(); } catch { /* best-effort smoke cleanup */ }
    report("fail", { origin: window.location.protocol, error: error instanceof Error ? error.message : String(error) });
  }
}

void run();
