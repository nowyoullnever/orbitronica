import type { PluginSlot } from "../state/types.ts";
import type { JsonValue, WamPluginInstance } from "./wamHost.ts";

export type PluginRuntimeStatus = "idle" | "loading" | "ready" | "unavailable";
export type PluginRuntime = {
  slotId: string;
  instance: WamPluginInstance;
  status: PluginRuntimeStatus;
  generation: number;
  disposed: boolean;
};
export type WamRackFactory = (slot: PluginSlot) => Promise<WamPluginInstance>;
export type WamRackDiagnostic = (reason: "late-instance-disposed" | "hydrate-failed" | "destroy-failed", slotId: string) => void;

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Owns exactly the WAM edges for one orbit. Native AudioNode.disconnect() without
 * a destination is intentionally never used here: recorder and diagnostic taps
 * are outside the rack's ownership.
 */
export class OrbitWamRack {
  private runtimes = new Map<string, PluginRuntime>();
  private generation = 0;
  private desired: readonly PluginSlot[] = [];
  private disposed = false;

  private readonly input: AudioNode;
  private readonly destination: AudioNode;
  private readonly create: WamRackFactory;
  private readonly states: Map<string, JsonValue>;
  private readonly diagnostic: WamRackDiagnostic;
  constructor(input: AudioNode, destination: AudioNode, create: WamRackFactory, states: Map<string, JsonValue>, diagnostic: WamRackDiagnostic = () => undefined) {
    this.input = input; this.destination = destination; this.create = create; this.states = states; this.diagnostic = diagnostic;
  }

  getRuntime(slotId: string) { return this.runtimes.get(slotId); }
  getStatus(slotId: string): PluginRuntimeStatus { return this.runtimes.get(slotId)?.status ?? "idle"; }
  /** A missing/unavailable runtime remains dry; durable bypass is never mutated. */
  effectiveBypass(slot: PluginSlot) { return slot.bypassed || this.getStatus(slot.id) !== "ready"; }
  snapshotStates() { return new Map([...this.states].map(([id, value]) => [id, cloneJson(value)])); }

  async reconcile(slots: readonly PluginSlot[], ownerGeneration?: number): Promise<void> {
    if (this.disposed) return;
    const generation = ownerGeneration ?? ++this.generation;
    this.generation = Math.max(this.generation, generation);
    this.desired = slots.map((slot) => ({ ...slot }));
    const desiredIds = new Set(slots.map((slot) => slot.id));
    await Promise.all([...this.runtimes.values()].filter((runtime) => !desiredIds.has(runtime.slotId)).map((runtime) => this.dispose(runtime)));
    // Publish dry or fully-ready topology immediately; async work never makes a
    // half-connected chain audible.
    this.rewire();
    await Promise.all(slots.map((slot) => this.ensure(slot, generation)));
    if (!this.disposed && generation === this.generation) this.rewire();
  }

  private async ensure(slot: PluginSlot, generation: number): Promise<void> {
    const prior = this.runtimes.get(slot.id);
    if (prior && !prior.disposed && prior.status === "ready") return;
    if (prior?.status === "loading") return;
    const placeholder: PluginRuntime = prior ?? { slotId: slot.id, instance: null as unknown as WamPluginInstance, status: "loading", generation, disposed: false };
    placeholder.status = "loading"; placeholder.generation = generation; this.runtimes.set(slot.id, placeholder);
    try {
      const instance = await this.create(slot);
      if (this.disposed || generation !== this.generation || !this.desired.some((item) => item.id === slot.id)) {
        await this.destroyInstance(instance, slot.id); this.diagnostic("late-instance-disposed", slot.id); return;
      }
      placeholder.instance = instance;
      const saved = this.states.get(slot.id);
      if (saved !== undefined && instance.setState) await instance.setState(cloneJson(saved));
      placeholder.status = "ready";
    } catch {
      placeholder.status = "unavailable";
      this.diagnostic("hydrate-failed", slot.id);
    }
  }

  /** Takes a fresh state snapshot when possible; failed reads preserve last-good state. */
  async snapshotActiveState(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (runtime) => {
      if (runtime.status !== "ready" || runtime.disposed || !runtime.instance.getState) return;
      try { this.states.set(runtime.slotId, cloneJson(await runtime.instance.getState() as JsonValue)); }
      catch { this.diagnostic("hydrate-failed", runtime.slotId); }
    }));
  }

  private disconnectOwned(source: AudioNode, destination: AudioNode) {
    try { source.disconnect(destination); } catch { /* no owned edge */ }
  }
  private rewire() {
    // Remove only rack-owned edges, then connect either a full ready unbypassed
    // chain or the dry route. This preserves the single downstream invariant.
    this.disconnectOwned(this.input, this.destination);
    for (const runtime of this.runtimes.values()) {
      if (!runtime.instance?.audioNode) continue;
      this.disconnectOwned(this.input, runtime.instance.audioNode);
      this.disconnectOwned(runtime.instance.audioNode, this.destination);
      for (const other of this.runtimes.values()) if (other !== runtime && other.instance?.audioNode) this.disconnectOwned(runtime.instance.audioNode, other.instance.audioNode);
    }
    const active = this.desired.filter((slot) => !this.effectiveBypass(slot)).map((slot) => this.runtimes.get(slot.id)!).filter(Boolean);
    let upstream: AudioNode = this.input;
    for (const runtime of active) { upstream.connect(runtime.instance.audioNode); upstream = runtime.instance.audioNode; }
    upstream.connect(this.destination);
  }

  private async destroyInstance(instance: WamPluginInstance, slotId: string) {
    try { await instance.destroy?.(); } catch { this.diagnostic("destroy-failed", slotId); }
  }
  private async dispose(runtime: PluginRuntime) {
    if (runtime.disposed) return;
    runtime.disposed = true; this.runtimes.delete(runtime.slotId);
    if (runtime.instance?.audioNode) {
      this.disconnectOwned(this.input, runtime.instance.audioNode);
      this.disconnectOwned(runtime.instance.audioNode, this.destination);
    }
    await this.destroyInstance(runtime.instance, runtime.slotId);
  }
  async freeze(): Promise<void> { await this.snapshotActiveState(); await Promise.all([...this.runtimes.values()].map((runtime) => this.dispose(runtime))); this.rewire(); }
  async disposeAll(): Promise<void> { this.disposed = true; ++this.generation; await this.freeze(); }
}

/** Store lifecycle mirrors retained audio: history references keep deleted slot state alive. */
export function prunePluginStates(store: Map<string, JsonValue>, retainedSlotIds: ReadonlySet<string>) {
  for (const id of store.keys()) if (!retainedSlotIds.has(id)) store.delete(id);
}
export function collectRetainedPluginSlotIds(scenes: readonly { orbits: readonly { plugins?: readonly PluginSlot[] }[] }[]) {
  const ids = new Set<string>(); for (const scene of scenes) for (const orbit of scene.orbits) for (const slot of orbit.plugins ?? []) ids.add(slot.id); return ids;
}
export function duplicatePluginSlots(
  slots: readonly PluginSlot[] | undefined, state: ReadonlyMap<string, JsonValue>, nextId: () => string
): { slots: PluginSlot[]; state: Map<string, JsonValue> } {
  const copied = new Map<string, JsonValue>();
  const cloned = (slots ?? []).map((slot) => { const id = nextId(); const value = state.get(slot.id); if (value !== undefined) copied.set(id, cloneJson(value)); return { ...slot, id }; });
  return { slots: cloned, state: copied };
}

export type SceneRack = { freeze(): Promise<void>; reconcile(slots: readonly PluginSlot[], generation: number): Promise<void> };
/**
 * Last-wins scene transaction. Playback invalidation is deliberately separate
 * from hydration generation: callers can keep their existing playback epoch.
 */
export class SceneWamCoordinator {
  private epoch = 0;
  private ownerSceneId: string | null = null;
  private readonly racksForScene: (sceneId: string) => readonly { rack: SceneRack; slots: readonly PluginSlot[] }[];
  constructor(racksForScene: (sceneId: string) => readonly { rack: SceneRack; slots: readonly PluginSlot[] }[]) { this.racksForScene = racksForScene; }
  get runtimeOwnerSceneId() { return this.ownerSceneId; }
  async transition(fromSceneId: string | null, targetSceneId: string): Promise<boolean> {
    const epoch = ++this.epoch;
    this.ownerSceneId = null;
    if (fromSceneId) await Promise.all(this.racksForScene(fromSceneId).map(({ rack }) => rack.freeze()));
    if (epoch !== this.epoch) return false;
    const targets = this.racksForScene(targetSceneId);
    await Promise.all(targets.map(({ rack, slots }) => rack.reconcile(slots, epoch)));
    if (epoch !== this.epoch) return false;
    this.ownerSceneId = targetSceneId;
    return true;
  }
}
