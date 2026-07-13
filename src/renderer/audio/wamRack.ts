import type { PluginSlot } from "../state/types.ts";
import { cloneJsonValue, type JsonValue, type WamPluginInstance } from "./wamHost.ts";

export type PluginRuntimeStatus = "idle" | "loading" | "ready" | "unavailable";
export type PluginRuntime = {
  slotId: string;
  instance: WamPluginInstance;
  status: PluginRuntimeStatus;
  generation: number;
  disposed: boolean;
  destroyPromise?: Promise<void>;
};
export type WamRackFactory = (slot: PluginSlot) => Promise<WamPluginInstance>;
export type WamRackDiagnostic = (
  reason: "late-instance-disposed" | "hydrate-failed" | "destroy-failed",
  slotId: string,
) => void;

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
  private guis = new Map<
    string,
    { gui: HTMLElement; runtime: PluginRuntime }
  >();

  private readonly input: AudioNode;
  private readonly destination: AudioNode;
  private readonly create: WamRackFactory;
  private readonly states: Map<string, JsonValue>;
  private readonly diagnostic: WamRackDiagnostic;
  constructor(
    input: AudioNode,
    destination: AudioNode,
    create: WamRackFactory,
    states: Map<string, JsonValue>,
    diagnostic: WamRackDiagnostic = () => undefined,
  ) {
    this.input = input;
    this.destination = destination;
    this.create = create;
    this.states = states;
    this.diagnostic = diagnostic;
  }

  getRuntime(slotId: string) {
    return this.runtimes.get(slotId);
  }
  getStatus(slotId: string): PluginRuntimeStatus {
    return this.runtimes.get(slotId)?.status ?? "idle";
  }
  /**
   * Revokes every in-flight hydration lease before an owner freezes or removes
   * this rack.  A create() that settles after this point sees a different
   * generation (and no desired slot) and is destroyed instead of reconnecting
   * a scene that is no longer audible.
   */
  invalidate(): void {
    ++this.generation;
    this.desired = [];
    this.rewire();
  }
  /** Mounting is idempotent and late createGui results are destroyed, which makes
   * the React StrictMode mount/unmount probe safe. */
  async mountGui(slotId: string, container: HTMLElement): Promise<void> {
    const runtime = this.runtimes.get(slotId);
    if (
      !runtime ||
      runtime.status !== "ready" ||
      runtime.disposed ||
      !runtime.instance.createGui
    )
      return;
    const existing = this.guis.get(slotId);
    if (existing) {
      if (existing.gui.parentElement !== container)
        container.append(existing.gui);
      return;
    }
    const instance = runtime.instance;
    const createGui = instance.createGui!;
    try {
      const gui = await createGui();
      if (
        this.disposed ||
        runtime.disposed ||
        this.runtimes.get(slotId) !== runtime ||
        runtime.instance !== instance
      ) {
        await instance.destroyGui?.(gui);
        gui.remove();
        return;
      }
      const prior = this.guis.get(slotId);
      if (prior) {
        await instance.destroyGui?.(gui);
        gui.remove();
        return;
      }
      this.guis.set(slotId, { gui, runtime });
      container.append(gui);
    } catch {
      this.diagnostic("hydrate-failed", slotId);
    }
  }
  async unmountGui(
    slotId: string,
    expectedRuntime?: PluginRuntime,
  ): Promise<void> {
    const mounted = this.guis.get(slotId);
    if (!mounted || (expectedRuntime && mounted.runtime !== expectedRuntime))
      return;
    // Delete before awaiting plugin code. A newer runtime may mount while the
    // old destroyGui is pending; its mapping must remain untouched.
    if (this.guis.get(slotId) === mounted) this.guis.delete(slotId);
    try {
      await mounted.runtime.instance.destroyGui?.(mounted.gui);
    } catch {
      this.diagnostic("destroy-failed", slotId);
    }
    try {
      mounted.gui.remove();
    } catch {
      /* detached plugin GUI */
    }
  }
  /** A missing/unavailable runtime remains dry; durable bypass is never mutated. */
  effectiveBypass(slot: PluginSlot) {
    return slot.bypassed || this.getStatus(slot.id) !== "ready";
  }
  snapshotStates() {
    return new Map([...this.states].map(([id, value]) => [id, cloneJsonValue(value)]));
  }

  async reconcile(
    slots: readonly PluginSlot[],
    ownerGeneration?: number,
  ): Promise<void> {
    if (this.disposed) return;
    // A rack lease is local, but a scene owner can supply a larger generation.
    // Never lower the local lease after an invalidation: a stale scene epoch
    // must not become valid merely because it is numerically smaller.
    const generation = Math.max(++this.generation, ownerGeneration ?? 0);
    this.generation = generation;
    this.desired = slots.map((slot) => ({ ...slot }));
    const desiredIds = new Set(slots.map((slot) => slot.id));
    await Promise.all(
      [...this.runtimes.values()]
        .filter((runtime) => !desiredIds.has(runtime.slotId))
        .map((runtime) => this.dispose(runtime)),
    );
    // Publish dry or fully-ready topology immediately; async work never makes a
    // half-connected chain audible.
    this.rewire();
    await Promise.all(slots.map((slot) => this.ensure(slot, generation)));
    if (!this.disposed && generation === this.generation) this.rewire();
  }

  private async ensure(slot: PluginSlot, generation: number): Promise<void> {
    const prior = this.runtimes.get(slot.id);
    if (prior && !prior.disposed && prior.status === "ready") return;
    // A newer reconcile for the same slot must not wait behind an older,
    // non-cancellable create. Retire that placeholder and start a generation-
    // owned attempt; the old result observes `disposed`/identity mismatch and
    // destroys itself instead of leaving the latest request loading forever.
    if (prior?.status === "loading") prior.disposed = true;
    const placeholder: PluginRuntime = {
      slotId: slot.id,
      instance: null as unknown as WamPluginInstance,
      status: "loading",
      generation,
      disposed: false,
    };
    this.runtimes.set(slot.id, placeholder);
    const ownsLease = () =>
      !this.disposed &&
      generation === this.generation &&
      !placeholder.disposed &&
      this.runtimes.get(slot.id) === placeholder &&
      this.desired.some((item) => item.id === slot.id);
    try {
      const instance = await this.create(slot);
      if (!ownsLease()) {
        await this.destroyInstance(instance, slot.id);
        this.diagnostic("late-instance-disposed", slot.id);
        return;
      }
      placeholder.instance = instance;
      const saved = this.states.get(slot.id);
      try {
        if (saved !== undefined && instance.setState) {
          await instance.setState(cloneJsonValue(saved));
        }
      } catch {
        // A superseding reconcile owns this slot now. Do not publish an old
        // failure into its placeholder; retire only this instance.
        if (!ownsLease()) {
          await this.destroyRuntimeInstance(placeholder);
          this.diagnostic("late-instance-disposed", slot.id);
          return;
        }
        placeholder.status = "unavailable";
        this.diagnostic("hydrate-failed", slot.id);
        return;
      }
      // setState is asynchronous too: re-check ownership after it settles so a
      // stale hydrate cannot revive, leak, or rewire a retired instance.
      if (!ownsLease()) {
        await this.destroyRuntimeInstance(placeholder);
        this.diagnostic("late-instance-disposed", slot.id);
        return;
      }
      placeholder.status = "ready";
    } catch {
      // create() failures have no instance to retire. Only the current
      // placeholder may publish unavailable; stale attempts are silent.
      if (
        this.runtimes.get(slot.id) === placeholder &&
        !placeholder.disposed &&
        generation === this.generation &&
        !this.disposed
      ) {
        placeholder.status = "unavailable";
        this.diagnostic("hydrate-failed", slot.id);
      }
    }
  }

  /** Takes a fresh state snapshot when possible; failed reads preserve last-good state. */
  async snapshotActiveState(): Promise<void> {
    const captured = await this.captureRuntimeStates([
      ...this.runtimes.values(),
    ]);
    for (const [slotId, value] of captured) this.states.set(slotId, value);
  }

  private async captureRuntimeStates(
    runtimes: readonly PluginRuntime[],
  ): Promise<Map<string, JsonValue>> {
    const captured = new Map<string, JsonValue>();
    await Promise.all(
      runtimes.map(async (runtime) => {
        if (
          runtime.status !== "ready" ||
          runtime.disposed ||
          !runtime.instance.getState
        )
          return;
        try {
          captured.set(
            runtime.slotId,
            cloneJsonValue((await runtime.instance.getState()) as JsonValue),
          );
        } catch {
          this.diagnostic("hydrate-failed", runtime.slotId);
        }
      }),
    );
    return captured;
  }

  /**
   * Save barrier capture: unlike freeze recovery this never publishes a partial
   * snapshot. The caller commits this staging map only after every live slot is
   * JSON-safe, so a failed plugin cannot silently write a mixed-age project.
   */
  async captureActiveStateForSave(): Promise<Map<string, JsonValue>> {
    const captured = new Map<string, JsonValue>();
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (
          runtime.status !== "ready" ||
          runtime.disposed ||
          !runtime.instance.getState
        )
          return;
        captured.set(
          runtime.slotId,
          cloneJsonValue((await runtime.instance.getState()) as JsonValue),
        );
      }),
    );
    return captured;
  }

  private disconnectOwned(source: AudioNode, destination: AudioNode) {
    try {
      source.disconnect(destination);
    } catch {
      /* no owned edge */
    }
  }
  private rewire() {
    // Remove only rack-owned edges, then connect either a full ready unbypassed
    // chain or the dry route. This preserves the single downstream invariant.
    this.disconnectOwned(this.input, this.destination);
    for (const runtime of this.runtimes.values()) {
      if (!runtime.instance?.audioNode) continue;
      this.disconnectOwned(this.input, runtime.instance.audioNode);
      this.disconnectOwned(runtime.instance.audioNode, this.destination);
      for (const other of this.runtimes.values())
        if (other !== runtime && other.instance?.audioNode)
          this.disconnectOwned(
            runtime.instance.audioNode,
            other.instance.audioNode,
          );
    }
    const active = this.desired
      .filter((slot) => !this.effectiveBypass(slot))
      .map((slot) => this.runtimes.get(slot.id)!)
      .filter(Boolean);
    let upstream: AudioNode = this.input;
    for (const runtime of active) {
      upstream.connect(runtime.instance.audioNode);
      upstream = runtime.instance.audioNode;
    }
    upstream.connect(this.destination);
  }

  private async destroyInstance(instance: WamPluginInstance, slotId: string) {
    try {
      await instance.destroy?.();
    } catch {
      this.diagnostic("destroy-failed", slotId);
    }
  }
  private destroyRuntimeInstance(runtime: PluginRuntime): Promise<void> {
    return (runtime.destroyPromise ??= this.destroyInstance(
      runtime.instance,
      runtime.slotId,
    ));
  }
  private async dispose(runtime: PluginRuntime) {
    if (runtime.disposed) return;
    runtime.disposed = true;
    await this.unmountGui(runtime.slotId, runtime);
    // Never let an old teardown erase a newer same-slot runtime.
    if (this.runtimes.get(runtime.slotId) === runtime) {
      this.runtimes.delete(runtime.slotId);
    }
    if (runtime.instance?.audioNode) {
      this.disconnectOwned(this.input, runtime.instance.audioNode);
      this.disconnectOwned(runtime.instance.audioNode, this.destination);
    }
    await this.destroyRuntimeInstance(runtime);
  }
  async freeze(allowDisposed = false): Promise<void> {
    // Freeze is a destructive transaction. It owns a lease and stages state
    // reads; a later thaw/reconcile invalidates that lease before this method
    // can commit state, dispose a runtime, or restore the dry topology.
    const lease = ++this.generation;
    this.desired = [];
    this.rewire();
    const capturedRuntimes = [...this.runtimes.values()];
    const capturedStates = await this.captureRuntimeStates(capturedRuntimes);
    if ((!allowDisposed && this.disposed) || lease !== this.generation) return;
    for (const [slotId, value] of capturedStates)
      this.states.set(slotId, value);
    await Promise.all(capturedRuntimes.map((runtime) => this.dispose(runtime)));
    if (!this.disposed && lease === this.generation) this.rewire();
  }
  async disposeAll(): Promise<void> {
    this.disposed = true;
    ++this.generation;
    await this.freeze(true);
  }
}

/** Store lifecycle mirrors retained audio: history references keep deleted slot state alive. */
export function prunePluginStates(
  store: Map<string, JsonValue>,
  retainedSlotIds: ReadonlySet<string>,
) {
  for (const id of store.keys()) if (!retainedSlotIds.has(id)) store.delete(id);
}
export function collectRetainedPluginSlotIds(
  scenes: readonly { orbits: readonly { plugins?: readonly PluginSlot[] }[] }[],
) {
  const ids = new Set<string>();
  for (const scene of scenes)
    for (const orbit of scene.orbits)
      for (const slot of orbit.plugins ?? []) ids.add(slot.id);
  return ids;
}
export function duplicatePluginSlots(
  slots: readonly PluginSlot[] | undefined,
  state: ReadonlyMap<string, JsonValue>,
  nextId: () => string,
): { slots: PluginSlot[]; state: Map<string, JsonValue> } {
  const copied = new Map<string, JsonValue>();
  const cloned = (slots ?? []).map((slot) => {
    const id = nextId();
    const value = state.get(slot.id);
    if (value !== undefined) copied.set(id, cloneJsonValue(value));
    return { ...slot, id };
  });
  return { slots: cloned, state: copied };
}
