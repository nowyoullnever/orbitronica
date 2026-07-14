import assert from "node:assert/strict";
import test from "node:test";
import {
  clamp,
  createParamMgrShim,
  hasDangerousKey,
  installNodeShim,
  isStateRecord,
  setStateFromRecord,
  type ParamSpec,
} from "../plugins/src/shared/effectNode.ts";

test("clamp bounds values into [min, max], including NaN/Infinity edge cases", () => {
  const cases: Array<[number, number, number, number]> = [
    [5, 0, 10, 5],
    [-5, 0, 10, 0],
    [15, 0, 10, 10],
    [0, 0, 10, 0],
    [10, 0, 10, 10],
    [Infinity, 0, 10, 10],
    [-Infinity, 0, 10, 0],
  ];
  for (const [value, min, max, expected] of cases) assert.equal(clamp(value, min, max), expected);
  // Math.min/Math.max propagate NaN through both branches, matching every plugin's local clamp.
  assert.ok(Number.isNaN(clamp(NaN, 0, 10)));
});

test("isStateRecord accepts only plain, non-array objects with Object.prototype", () => {
  assert.equal(isStateRecord({}), true);
  assert.equal(isStateRecord({ a: 1 }), true);
  assert.equal(isStateRecord([]), false);
  assert.equal(isStateRecord(null), false);
  assert.equal(isStateRecord(undefined), false);
  assert.equal(isStateRecord("string"), false);
  assert.equal(isStateRecord(42), false);
  assert.equal(isStateRecord(Object.create(null)), false);
  assert.equal(isStateRecord(new Date()), false);
});

test("hasDangerousKey rejects __proto__/constructor/prototype as own keys, at any nesting depth", () => {
  assert.equal(hasDangerousKey({ a: 1 }), false);
  assert.equal(hasDangerousKey({ a: { b: 2 } }), false);
  assert.equal(hasDangerousKey(JSON.parse('{"__proto__":{"x":1}}')), true);
  assert.equal(hasDangerousKey({ constructor: 1 }), true);
  assert.equal(hasDangerousKey({ prototype: 1 }), true);
  assert.equal(hasDangerousKey({ nested: { deeper: JSON.parse('{"__proto__":{}}') } }), true);
  assert.equal(hasDangerousKey({ nested: JSON.parse('{"constructor":1}') }), true);
  assert.equal(hasDangerousKey(5), false);
  assert.equal(hasDangerousKey(null), false);
  assert.equal(hasDangerousKey("str"), false);
});

test("installNodeShim redirects connect/disconnect to output and installs destroy/getState/setState", async () => {
  const calls: string[] = [];
  const input = { connect: () => calls.push("input-connect"), disconnect: () => calls.push("input-disconnect") } as unknown as AudioNode;
  const output = { connect: () => calls.push("output-connect"), disconnect: () => calls.push("output-disconnect") } as unknown as AudioNode;
  const node = {
    getState: async () => ({ ok: true }),
    setState: async (_value: unknown) => { calls.push("setState"); },
    destroy: () => calls.push("destroy"),
  };
  installNodeShim(input, output, node);

  (input as unknown as { connect(): void }).connect();
  (input as unknown as { disconnect(): void }).disconnect();
  assert.deepEqual(calls, ["output-connect", "output-disconnect"]);

  const shimmed = input as unknown as { destroy(): void; getState(): Promise<unknown>; setState(v: unknown): Promise<void>; paramMgr?: unknown };
  shimmed.destroy();
  await shimmed.setState({});
  assert.deepEqual(await shimmed.getState(), { ok: true });
  assert.equal(shimmed.paramMgr, undefined, "paramMgr is omitted when not supplied");
});

test("installNodeShim installs paramMgr only when supplied", () => {
  const input = { connect() {}, disconnect() {} } as unknown as AudioNode;
  const output = { connect() {}, disconnect() {} } as unknown as AudioNode;
  const node = { getState: async () => ({}), setState: async () => {}, destroy() {} };
  const paramMgr = { getState: async () => ({}), getParamsValues: () => ({}), setState: async () => {} };
  installNodeShim(input, output, node, paramMgr);
  assert.equal((input as unknown as { paramMgr: unknown }).paramMgr, paramMgr);
});

test("createParamMgrShim exposes getState/getParamsValues as clones and routes setState through schemaVersion 1", async () => {
  let captured: unknown;
  const params = { rate: 0.5, depth: 0.002 };
  const shim = createParamMgrShim(
    () => params,
    async (state) => { captured = state; },
  );
  const gotState = await shim.getState();
  assert.deepEqual(gotState, params);
  assert.notEqual(gotState, params, "getState must return a structured clone, not the live object");
  assert.deepEqual(shim.getParamsValues(), params);
  assert.notEqual(shim.getParamsValues(), params, "getParamsValues must return a structured clone, not the live object");
  await shim.setState({ rate: 0.9, depth: 0.001 });
  assert.deepEqual(captured, { schemaVersion: 1, params: { rate: 0.9, depth: 0.001 } });
});

type FlangerLikeParams = { rate: number; depth: number; feedback: number; mix: number };
const flangerSpecs: readonly ParamSpec<keyof FlangerLikeParams & string>[] = [
  { key: "rate", min: 0.05, max: 10 },
  { key: "depth", min: 0, max: 0.009 },
  { key: "feedback", min: -0.95, max: 0.95 },
  { key: "mix", min: 0, max: 1 },
];
const flangerDefaults: FlangerLikeParams = { rate: 0.25, depth: 0.003, feedback: 0.25, mix: 0 };

test("setStateFromRecord merges partial params (incoming ?? old) and clamps out-of-range values", () => {
  const next = setStateFromRecord({ schemaVersion: 1, params: { rate: 99 } }, "flanger-like", flangerDefaults, flangerSpecs);
  assert.deepEqual(next, { schemaVersion: 1, params: { rate: 10, depth: 0.003, feedback: 0.25, mix: 0 } });
});

test("setStateFromRecord accepts a bare params object (no schemaVersion/params envelope)", () => {
  const next = setStateFromRecord({ mix: 0.5 }, "flanger-like", flangerDefaults, flangerSpecs);
  assert.deepEqual(next.params, { rate: 0.25, depth: 0.003, feedback: 0.25, mix: 0.5 });
});

test("setStateFromRecord accepts schemaVersion 0 and 1, rejects any other schemaVersion", () => {
  assert.doesNotThrow(() => setStateFromRecord({ schemaVersion: 0, params: {} }, "flanger-like", flangerDefaults, flangerSpecs));
  assert.doesNotThrow(() => setStateFromRecord({ schemaVersion: 1, params: {} }, "flanger-like", flangerDefaults, flangerSpecs));
  assert.doesNotThrow(() => setStateFromRecord({ params: {} }, "flanger-like", flangerDefaults, flangerSpecs));
  assert.throws(() => setStateFromRecord({ schemaVersion: 2, params: {} }, "flanger-like", flangerDefaults, flangerSpecs), /unsupported-flanger-like-state/);
});

test("setStateFromRecord rounds parameters flagged with round (e.g. phaser stages)", () => {
  type PhaserLikeParams = { stages: number };
  const specs: readonly ParamSpec<"stages">[] = [{ key: "stages", min: 4, max: 8, round: true }];
  const next = setStateFromRecord({ stages: 6.6 }, "phaser-like", { stages: 6 } as PhaserLikeParams, specs);
  assert.deepEqual(next.params, { stages: 7 });
  const clampedThenRounded = setStateFromRecord({ stages: 8.9 }, "phaser-like", { stages: 6 } as PhaserLikeParams, specs);
  assert.deepEqual(clampedThenRounded.params, { stages: 8 }, "clamp to max (8) happens before rounding");
});

test("setStateFromRecord produces the exact invalid-<name>-state / unsupported-<name>-state error ids", () => {
  assert.throws(() => setStateFromRecord(null, "widget", flangerDefaults as unknown as Record<string, number>, []), /^Error: invalid-widget-state$/);
  assert.throws(() => setStateFromRecord([1, 2], "widget", flangerDefaults as unknown as Record<string, number>, []), /^Error: invalid-widget-state$/);
  assert.throws(() => setStateFromRecord({ schemaVersion: 7 }, "widget", flangerDefaults as unknown as Record<string, number>, []), /^Error: unsupported-widget-state$/);
  assert.throws(() => setStateFromRecord({ rate: "not-a-number" }, "widget", flangerDefaults, flangerSpecs), /^Error: invalid-widget-state$/);
  assert.throws(() => setStateFromRecord({ rate: NaN }, "widget", flangerDefaults, flangerSpecs), /^Error: invalid-widget-state$/);
  assert.throws(() => setStateFromRecord({ rate: Infinity }, "widget", flangerDefaults, flangerSpecs), /^Error: invalid-widget-state$/);
});

test("setStateFromRecord rejects prototype-polluting state, own and nested", () => {
  assert.throws(() => setStateFromRecord(JSON.parse('{"__proto__":{"rate":1}}'), "widget", flangerDefaults, flangerSpecs), /invalid-widget-state/);
  assert.throws(() => setStateFromRecord({ params: JSON.parse('{"__proto__":{"rate":1}}') }, "widget", flangerDefaults, flangerSpecs), /invalid-widget-state/);
  assert.throws(() => setStateFromRecord({ constructor: {} }, "widget", flangerDefaults, flangerSpecs), /invalid-widget-state/);
  assert.throws(() => setStateFromRecord({ nested: { prototype: 1 } }, "widget", flangerDefaults, flangerSpecs), /invalid-widget-state/);
});
