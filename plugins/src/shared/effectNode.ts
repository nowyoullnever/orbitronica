/*
 * Shared, dependency-free runtime boilerplate for Orbitronica's first-party
 * WAM plugins.  esbuild bundles this module into each plugin's `index.js`
 * (bundle: true), exactly like `shared/knobPanel.ts`.
 *
 * IMPORTANT — this module is opt-in per plugin.  Several first-party plugins
 * (orbitronica-filter, orbitronica-overdrive, orbitronica-compressor,
 * orbitronica-bitcrusher, orbitronica-reverb) have their prototype-pollution
 * guard bodies and/or `setState` validate/merge/throw blocks pinned as
 * literal source text by pre-existing regression tests
 * (test/wamHost.test.ts, test/packagedWamCompatibility.test.ts read the raw
 * .ts source and assert.match against strings like `/__proto__/`,
 * `/invalid-compressor-state/`, `/schemaVersion !== 0/`, `/getParamsValues/`
 * *in that plugin's own file*). Moving that logic here would remove the
 * pinned text from those files and break those tests, so those plugins keep
 * their guard/setState bodies inline and only pull in the pieces that are
 * not text-pinned (clamp, the input-node shim, the paramMgr shim). See the
 * Phase 3 migration report for the exact per-plugin breakdown.
 */

/** Clamps `value` into [min, max]. Identical to every plugin's local `clamp`. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Recognizes a plain, non-array object state record (own-prototype check rejects Object.create(null) / exotic prototypes too). */
export const isStateRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Recursively rejects `__proto__`/`constructor`/`prototype` keys anywhere in
 * `value` (own keys at any nesting depth). This is the exact recursive
 * predicate every plugin duplicated under names like `isDangerous`,
 * `dangerous`, or `hasDangerousKey`.
 */
export const hasDangerousKey = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || hasDangerousKey(child)) return true;
  }
  return false;
};

/** Minimal shape every plugin node exposes to the input-node redirect shim. */
export type ShimTarget = {
  getState(): Promise<unknown>;
  setState(value: unknown): Promise<void>;
  destroy(): void;
};

/**
 * Redirects a native-graph plugin's `input` GainNode so the WAM host can
 * drive the whole composite node through `audioNode` (== `input`) alone:
 * `connect`/`disconnect` are rebound to the plugin's real `output` node, and
 * `destroy`/`getState`/`setState` (and, optionally, `paramMgr`) are
 * installed. Mirrors the `Object.defineProperties(this.input, {...})` block
 * that was copied, identically in shape, across the native first-party
 * effects (overdrive, compressor, flanger, phaser, reverb).
 */
export function installNodeShim(input: AudioNode, output: AudioNode, node: ShimTarget, paramMgr?: unknown): void {
  const props: PropertyDescriptorMap = {
    connect: { value: output.connect.bind(output) },
    disconnect: { value: output.disconnect.bind(output) },
    destroy: { value: () => node.destroy() },
    getState: { value: () => node.getState() },
    setState: { value: (value: unknown) => node.setState(value) },
  };
  if (paramMgr !== undefined) props.paramMgr = { value: paramMgr };
  Object.defineProperties(input, props);
}

/**
 * Builds the `{ getState, getParamsValues, setState }` ParamMgr-shaped shim
 * that flanger/phaser/reverb each hand-rolled inline as an object literal
 * passed straight into their `Object.defineProperties` call.
 */
export function createParamMgrShim<Params extends Record<string, number>>(
  getParams: () => Params,
  setState: (state: { schemaVersion: 1; params: Params }) => Promise<void>,
) {
  return {
    getState: async () => structuredClone(getParams()),
    getParamsValues: () => structuredClone(getParams()),
    setState: async (params: Params) => setState({ schemaVersion: 1, params }),
  };
}

/** One parameter's validation/clamp bounds for {@link setStateFromRecord}. */
export type ParamSpec<K extends string = string> = {
  key: K;
  min: number;
  max: number;
  /** Round to the nearest integer after clamping (e.g. phaser's `stages`). */
  round?: boolean;
};

/**
 * The `setState` validate → merge → clamp → throw pattern duplicated across
 * every plugin's `setState`. Only used by plugins whose exact error-id
 * strings are *not* pinned as literal source text by an existing test
 * (currently: flanger, phaser) — see the module doc comment above for why
 * the others keep this inline.
 *
 * Reproduces, byte-for-byte in behavior, the flanger/phaser pattern:
 *   1. reject non-plain-object / prototype-polluting `value`
 *   2. accept only schemaVersion undefined/0/1
 *   3. unwrap `value.params` (or treat `value` itself as the params record)
 *   4. merge `incoming[key] ?? current[key]` per spec
 *   5. reject unless every merged value is a finite number
 *   6. clamp (and optionally round) each value
 */
export function setStateFromRecord<P extends Record<string, number>>(
  value: unknown,
  name: string,
  current: P,
  specs: readonly ParamSpec<Extract<keyof P, string>>[],
): { schemaVersion: 1; params: P } {
  if (!isStateRecord(value) || hasDangerousKey(value)) throw new Error(`invalid-${name}-state`);
  const source = value as { schemaVersion?: unknown; params?: unknown };
  if (source.schemaVersion !== undefined && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error(`unsupported-${name}-state`);
  const incoming = source.params === undefined ? source : source.params;
  if (!isStateRecord(incoming) || hasDangerousKey(incoming)) throw new Error(`invalid-${name}-state`);
  const raw = {} as Record<string, unknown>;
  for (const spec of specs) raw[spec.key] = incoming[spec.key] ?? current[spec.key];
  if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error(`invalid-${name}-state`);
  const params = {} as Record<string, number>;
  for (const spec of specs) {
    const clamped = clamp(raw[spec.key] as number, spec.min, spec.max);
    params[spec.key] = spec.round ? Math.round(clamped) : clamped;
  }
  return { schemaVersion: 1, params: params as P };
}
