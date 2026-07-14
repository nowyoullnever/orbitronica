/**
 * Bounded, renderer-local WAM boundary. It is deliberately not a sandbox:
 * third-party code is restricted to the compiled catalog before reaching here.
 */
export type { JsonPrimitive, JsonValue } from "../state/types";
import type { JsonValue } from "../state/types";

export type WamPluginInstance = {
  audioNode: AudioNode;
  getState?(): Promise<unknown>;
  setState?(state: JsonValue): Promise<void>;
  createGui?(): Promise<HTMLElement> | HTMLElement;
  destroyGui?(gui: HTMLElement): Promise<void> | void;
  destroy?(): Promise<void> | void;
};

export type WamPluginModule = {
  createInstance(context: AudioContext, hostGroupId?: string): Promise<WamPluginInstance>;
};

export type WamModuleLoader = (context: AudioContext, hostGroupId?: string) => Promise<WamPluginModule>;
export type WamHostInitializer = (context: AudioContext) => Promise<unknown>;
export type WamDiagnosticSeverity = "info" | "warning" | "error";
export type WamDiagnostic = Readonly<{
  event: "host-init" | "module-load" | "instance-create" | "state" | "gui" | "cleanup" | "circuit";
  outcome: "started" | "ready" | "failed" | "timeout" | "late-disposed" | "open";
  severity: WamDiagnosticSeverity;
  catalogId: string;
  correlation: string;
  durationMs: number;
  reason?: "timeout" | "circuit-open" | "invalid-state" | "operation-failed";
}>;

export type WamHostOptions = Readonly<{
  deadlineMs?: number;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  maxDetachedPerCatalog?: number;
  diagnosticCapacity?: number;
  now?: () => number;
  correlation?: () => string;
}>;

type Circuit = { failures: number; detached: number; openUntil: number };
type HostRegistration = { groupId?: string };
const defaultOptions = { deadlineMs: 5_000, circuitThreshold: 2, circuitCooldownMs: 15_000, maxDetachedPerCatalog: 1, diagnosticCapacity: 64 } as const;

/** Copy only JSON values at the WAM boundary; retain neither plugin objects nor lossy numbers. */
export function cloneJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid-state");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("invalid-state");
    seen.add(value);
    try { return value.map((item) => cloneJsonValue(item, seen)); }
    finally { seen.delete(value); }
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-state");
    if (seen.has(value)) throw new Error("invalid-state");
    seen.add(value);
    try {
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // Assignment to __proto__ invokes Object.prototype's legacy setter.
        // Define an own enumerable data property so JSON keys remain data.
        Object.defineProperty(result, key, {
          value: cloneJsonValue(item, seen), enumerable: true, configurable: true, writable: true
        });
      }
      return result;
    } finally { seen.delete(value); }
  }
  throw new Error("invalid-state");
}

const initializeSdkHost: WamHostInitializer = async (context) => {
  const { initializeWamHost } = await import("@webaudiomodules/sdk");
  return initializeWamHost(context);
};

export class WamHost {
  private readonly initializeHost: WamHostInitializer;
  private readonly opts: Required<Omit<WamHostOptions, "now" | "correlation">> & Pick<WamHostOptions, "now" | "correlation">;
  private readonly hostInitializations = new WeakMap<AudioContext, Promise<HostRegistration>>();
  // A single AudioContext can host more than one catalog entry.  Keep the
  // expensive SDK module load deduplicated per entry, rather than letting the
  // first catalog loaded for a context impersonate every later plugin.
  private readonly moduleLoads = new WeakMap<AudioContext, Map<string, Promise<WamPluginModule>>>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly diagnostics: WamDiagnostic[] = [];
  private droppedDiagnostics = 0;
  private sequence = 0;

  constructor(initializeHost: WamHostInitializer = initializeSdkHost, options: WamHostOptions = {}) {
    this.initializeHost = initializeHost;
    this.opts = { ...defaultOptions, ...options };
  }

  getDiagnostics(): Readonly<{ events: readonly WamDiagnostic[]; dropped: number }> {
    return { events: [...this.diagnostics], dropped: this.droppedDiagnostics };
  }

  private now() { return this.opts.now?.() ?? performance.now(); }
  private correlation() { return this.opts.correlation?.() ?? `w${++this.sequence}`; }
  private emit(event: WamDiagnostic["event"], outcome: WamDiagnostic["outcome"], severity: WamDiagnosticSeverity, catalogId: string, correlation: string, started: number, reason?: WamDiagnostic["reason"]) {
    const item: WamDiagnostic = { event, outcome, severity, catalogId: catalogId.slice(0, 64), correlation: correlation.slice(0, 32), durationMs: Math.max(0, Math.floor(this.now() - started)), ...(reason ? { reason } : {}) };
    if (this.diagnostics.length === this.opts.diagnosticCapacity) { this.diagnostics.shift(); this.droppedDiagnostics++; }
    this.diagnostics.push(item);
  }

  private circuit(catalogId: string) { return this.circuits.get(catalogId) ?? { failures: 0, detached: 0, openUntil: 0 }; }
  private accept(catalogId: string, started: number, correlation: string): Circuit {
    const circuit = this.circuit(catalogId);
    if (circuit.openUntil > this.now() || circuit.detached >= this.opts.maxDetachedPerCatalog) {
      this.emit("circuit", "open", "warning", catalogId, correlation, started, "circuit-open");
      throw new Error("wam-circuit-open");
    }
    this.circuits.set(catalogId, circuit);
    return circuit;
  }
  private fail(catalogId: string, circuit: Circuit) {
    circuit.failures++;
    if (circuit.failures >= this.opts.circuitThreshold) circuit.openUntil = this.now() + this.opts.circuitCooldownMs;
    this.circuits.set(catalogId, circuit);
  }
  private success(catalogId: string) { this.circuits.set(catalogId, { failures: 0, detached: 0, openUntil: 0 }); }

  private async bounded<T>(catalogId: string, event: WamDiagnostic["event"], task: Promise<T>, late?: (value: T) => Promise<void> | void): Promise<T> {
    const started = this.now(); const correlation = this.correlation(); const circuit = this.accept(catalogId, started, correlation);
    // Keep the original task reachable after the publication race times out.
    // Some WAM SDK promises are non-cancellable and must be disposed late.
    const detachedTask = Promise.resolve(task);
    this.emit(event, "started", "info", catalogId, correlation, started);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("wam-timeout")), this.opts.deadlineMs); });
    try {
      const result = await Promise.race([detachedTask, deadline]);
      if (timeout) clearTimeout(timeout);
      this.success(catalogId);
      this.emit(event, "ready", "info", catalogId, correlation, started);
      return result;
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      const timedOut = error instanceof Error && error.message === "wam-timeout";
      this.fail(catalogId, circuit);
      this.emit(event, timedOut ? "timeout" : "failed", "warning", catalogId, correlation, started, timedOut ? "timeout" : "operation-failed");
      if (timedOut) {
        circuit.detached++;
        this.circuits.set(catalogId, circuit);
        void detachedTask.then(async (lateValue) => {
          try { await late?.(lateValue); } finally {
            circuit.detached = Math.max(0, circuit.detached - 1);
            this.circuits.set(catalogId, circuit);
            this.emit(event, "late-disposed", "info", catalogId, correlation, started);
          }
        }, () => { circuit.detached = Math.max(0, circuit.detached - 1); this.circuits.set(catalogId, circuit); });
      }
      throw new Error(timedOut ? "wam-timeout" : "wam-operation-failed");
    }
  }

  private async initialize(context: AudioContext): Promise<HostRegistration> {
    const cached = this.hostInitializations.get(context); if (cached) return cached;
    const initialization = this.bounded("host", "host-init", this.initializeHost(context)).then((value) => {
      const tuple = Array.isArray(value) ? value : [];
      return { groupId: typeof tuple[0] === "string" ? tuple[0] : undefined };
    });
    this.hostInitializations.set(context, initialization);
    try { return await initialization; } catch (error) { this.hostInitializations.delete(context); throw error; }
  }

  private async loadModule(context: AudioContext, loader: WamModuleLoader, hostGroupId: string | undefined, catalogId: string): Promise<WamPluginModule> {
    let loadsForContext = this.moduleLoads.get(context);
    if (!loadsForContext) {
      loadsForContext = new Map();
      this.moduleLoads.set(context, loadsForContext);
    }
    const cached = loadsForContext.get(catalogId); if (cached) return cached;
    const load = this.bounded(catalogId, "module-load", loader(context, hostGroupId));
    loadsForContext.set(catalogId, load);
    try { return await load; } catch (error) {
      // Do not evict an independently cached catalog entry, and do not let a
      // late failure erase a retry which has already replaced this promise.
      if (loadsForContext.get(catalogId) === load) loadsForContext.delete(catalogId);
      if (loadsForContext.size === 0) this.moduleLoads.delete(context);
      throw error;
    }
  }

  /** Creates an unconnected instance for a rack that owns its own topology. */
  async createPluginInstance(context: AudioContext, loader: WamModuleLoader, catalogId = "spike"): Promise<WamPluginInstance> {
    const registration = await this.initialize(context);
    const module = await this.loadModule(context, loader, registration.groupId, catalogId);
    return this.bounded(catalogId, "instance-create", module.createInstance(context, registration.groupId), async (late) => { await late.destroy?.(); });
  }

}
