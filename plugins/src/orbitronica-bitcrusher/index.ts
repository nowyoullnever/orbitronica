import { WebAudioModule, WamNode, addFunctionModule } from "@webaudiomodules/sdk";
import { createKnobPanel, fmt } from "../shared/knobPanel";

type Params = { bitDepth: number; reduction: number; mix: number };
type State = { schemaVersion: 1; params: Params };
const MODULE_ID = "com.orbitronica.bitcrusher";
const PROOF_ID = "com.orbitronica.bitcrusher.worklet-proof";
const defaults: Params = { bitDepth: 8, reduction: 1, mix: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dangerous = (value: unknown): boolean => !!value && typeof value === "object" && Object.entries(value as Record<string, unknown>).some(([key, child]) => key === "__proto__" || key === "constructor" || key === "prototype" || dangerous(child));

// WamNode.addModules installs the SDK base classes. This Blob module is deliberately
// registered separately so packaged file:// proves the actual WamProcessor path before
// any DSP instance is constructed. A rejected registration promise is evicted for retry.
const installed = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
const installProcessor = (context: BaseAudioContext, moduleId: string, minimal: boolean) => {
  let byModule = installed.get(context); if (!byModule) { byModule = new Map(); installed.set(context, byModule); }
  const existing = byModule.get(moduleId); if (existing) return existing;
  const pending = (async () => {
    await WamNode.addModules(context, moduleId);
    await addFunctionModule(context.audioWorklet, (id: string, isMinimal: boolean) => {
      const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
      const scope = globalThis as typeof globalThis & { webAudioModules: { getModuleScope(id: string): { WamProcessor: typeof AudioWorkletProcessor; WamParameterInfo: new (id: string, config: object) => unknown } } };
      const moduleScope = scope.webAudioModules.getModuleScope(id);
      const BaseProcessor = moduleScope.WamProcessor as typeof AudioWorkletProcessor & { prototype: { _generateWamParameterInfo(): object; _process(start: number, end: number, inputs: Float32Array[][], outputs: Float32Array[][]): void; _parameterState: Record<string, { value: number }> } };
      const ParameterInfo = moduleScope.WamParameterInfo;
      class Processor extends BaseProcessor {
        #held: number[] = []; #count: number[] = [];
        _generateWamParameterInfo() {
          if (isMinimal) return {};
          return {
            bitDepth: new ParameterInfo("bitDepth", { label: "Bit depth", defaultValue: 8, minValue: 1, maxValue: 16, discreteStep: 1 }),
            reduction: new ParameterInfo("reduction", { label: "Reduction", defaultValue: 1, minValue: 1, maxValue: 64, discreteStep: 1 }),
            mix: new ParameterInfo("mix", { label: "Mix", defaultValue: 0, minValue: 0, maxValue: 1 }),
          };
        }
        _process(start: number, end: number, inputs: Float32Array[][], outputs: Float32Array[][]) {
          const input = inputs[0] || [], output = outputs[0] || [], state = this._parameterState || {};
          for (let channel = 0; channel < output.length; channel++) {
            const source = input[channel] || input[0], target = output[channel];
            if (!source) { target.fill(0, start, end); continue; }
            if (isMinimal) { target.set(source.subarray(start, end), start); continue; }
            const held = this.#held[channel] ?? 0, count = this.#count[channel] ?? 0;
            let last = held, remaining = count;
            for (let frame = start; frame < end; frame++) {
              const depth = Math.round((state.bitDepth && state.bitDepth.value) || 8);
              const reduction = Math.round((state.reduction && state.reduction.value) || 1);
              const mix = (state.mix && state.mix.value) ?? 0;
              if (remaining <= 0) { const levels = 2 ** clampValue(depth, 1, 16), bounded = clampValue(source[frame], -1, 1); last = Math.round((bounded + 1) * (levels - 1) / 2) * 2 / (levels - 1) - 1; remaining = clampValue(reduction, 1, 64); }
              remaining--;
              const dry = Math.cos(clampValue(mix, 0, 1) * Math.PI / 2), wet = Math.sin(clampValue(mix, 0, 1) * Math.PI / 2);
              target[frame] = source[frame] * dry + last * wet;
            }
            this.#held[channel] = last; this.#count[channel] = remaining;
          }
        }
      }
      registerProcessor(id, Processor);
    }, moduleId, minimal);
  })();
  byModule.set(moduleId, pending);
  pending.catch(() => { if (byModule?.get(moduleId) === pending) byModule.delete(moduleId); });
  return pending;
};

class BitcrusherModule extends WebAudioModule {
  constructor(groupId: string, context: BaseAudioContext, private readonly moduleIdOverride = MODULE_ID) {
    super(groupId, context); this._descriptor = { ...this._descriptor, identifier: moduleIdOverride, name: moduleIdOverride === PROOF_ID ? "Orbitronica WamProcessor Proof" : "Orbitronica Bitcrusher", vendor: "Orbitronica", version: "1.0.0" };
  }
  async createAudioNode() { await installProcessor(this.audioContext, this.moduleIdOverride, this.moduleIdOverride === PROOF_ID); const node = new BitcrusherNode(this, this.moduleIdOverride); await node._initialize(); return node; }
}

class BitcrusherNode extends WamNode {
  #state: State = { schemaVersion: 1, params: { ...defaults } };
  constructor(module: BitcrusherModule, moduleId: string) { super(module, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { moduleId } }); }
  private async apply(params: Params) { await this.setParameterValues(Object.fromEntries(Object.entries(params).map(([id, value]) => [id, { id, value, normalized: false }]))); }
  async getState(): Promise<State> { return structuredClone(this.#state); }
  async setState(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value) || dangerous(value)) throw new Error("invalid-bitcrusher-state");
    const source = value as { schemaVersion?: unknown; params?: unknown };
    if (source.schemaVersion !== undefined && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-bitcrusher-state");
    const incoming = source.params ?? source;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || dangerous(incoming)) throw new Error("invalid-bitcrusher-state");
    const record = incoming as Record<string, unknown>, previous = this.#state.params;
    const raw = { bitDepth: record.bitDepth ?? previous.bitDepth, reduction: record.reduction ?? previous.reduction, mix: record.mix ?? previous.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-bitcrusher-state");
    const next: State = { schemaVersion: 1, params: { bitDepth: Math.round(clamp(raw.bitDepth as number, 1, 16)), reduction: Math.round(clamp(raw.reduction as number, 1, 64)), mix: clamp(raw.mix as number, 0, 1) } };
    await this.apply(next.params); this.#state = next;
  }
}

/** Packaged smoke calls this before the bitcrusher catalog entry is constructed. */
export async function proveMinimalWamProcessor(groupId: string, context: BaseAudioContext) {
  const module = new BitcrusherModule(groupId, context, PROOF_ID); const node = await module.createAudioNode(); node.destroy();
}
export async function createBitcrusherInstance(groupId: string, context: BaseAudioContext) {
  const module = new BitcrusherModule(groupId, context); const audioNode = await module.createAudioNode();
  return { audioNode, createGui: () => createKnobPanel("Orbitronica Bitcrusher", audioNode, [
    { kind: "knob", key: "bitDepth", label: "Bits", min: 1, max: 16, step: 1, format: fmt.int },
    { kind: "knob", key: "reduction", label: "Downsample", min: 1, max: 64, step: 1, format: fmt.int },
    { kind: "knob", key: "mix", label: "Mix", min: 0, max: 1, format: fmt.pct },
  ]), destroyGui: (gui: HTMLElement) => gui.remove() };
}
export default { createInstance: createBitcrusherInstance };
