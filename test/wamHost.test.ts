import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { cloneJsonValue, WamHost, type WamModuleLoader } from "../src/renderer/audio/wamHost.ts";

class FakeNode {
  readonly edges = new Set<FakeNode>();
  connect(destination: FakeNode) { this.edges.add(destination); return destination; }
  disconnect(destination?: FakeNode) {
    if (destination) this.edges.delete(destination);
    else this.edges.clear();
  }
}

const context = {} as AudioContext;
const secondContext = {} as AudioContext;

test("initializes a WAM module once per context and retries failed initialization", async () => {
  let hostInitializations = 0;
  const host = new WamHost(async () => { hostInitializations++; });
  let loads = 0;
  const loader: WamModuleLoader = async () => {
    loads++;
    return { createInstance: async () => ({ audioNode: new FakeNode() as unknown as AudioNode, getState: async () => ({}), setState: async () => {} }) };
  };
  await Promise.all([
    host.createPluginInstance(context, loader),
    host.createPluginInstance(context, loader)
  ]);
  await host.createPluginInstance(secondContext, loader);
  assert.equal(loads, 2);
  assert.equal(hostInitializations, 2);

  const retryHost = new WamHost(async () => {});
  let attempts = 0;
  const flaky: WamModuleLoader = async () => {
    if (++attempts === 1) throw new Error("registration failed");
    return { createInstance: async () => ({ audioNode: new FakeNode() as unknown as AudioNode, getState: async () => ({}), setState: async () => {} }) };
  };
  await assert.rejects(retryHost.createPluginInstance(context, flaky));
  await retryHost.createPluginInstance(context, flaky);
  assert.equal(attempts, 2);
});

test("caches modules per catalog within one context and retries only the failed catalog", async () => {
  const host = new WamHost(async () => {});
  let loadsA = 0;
  let loadsB = 0;
  const loaderA: WamModuleLoader = async () => {
    loadsA++;
    return { createInstance: async () => ({ audioNode: new FakeNode() as unknown as AudioNode }) };
  };
  const loaderB: WamModuleLoader = async () => {
    loadsB++;
    if (loadsB === 1) throw new Error("B is temporarily unavailable");
    return { createInstance: async () => ({ audioNode: new FakeNode() as unknown as AudioNode }) };
  };

  await host.createPluginInstance(context, loaderA, "catalog-a");
  await assert.rejects(host.createPluginInstance(context, loaderB, "catalog-b"), /wam-operation-failed/);
  await host.createPluginInstance(context, loaderA, "catalog-a");
  await Promise.all([
    host.createPluginInstance(context, loaderB, "catalog-b"),
    host.createPluginInstance(context, loaderB, "catalog-b")
  ]);
  await host.createPluginInstance(context, loaderA, "catalog-a");
  await host.createPluginInstance(context, loaderB, "catalog-b");

  assert.equal(loadsA, 1, "A→B→A must retain A's module cache entry");
  assert.equal(loadsB, 2, "a failed B load retries without evicting A, then concurrent B loads deduplicate");
});

test("trusted catalog preserves identity and non-empty presentation metadata", async () => {
  const { WAM_CATALOG } = await import("../src/renderer/audio/wamCatalog.ts");
  assert.deepEqual(Object.keys(WAM_CATALOG), ["burns-simple-delay"]);
  for (const [catalogId, entry] of Object.entries(WAM_CATALOG)) {
    assert.equal(entry.id, catalogId, `catalog key ${catalogId} must equal entry.id`);
    assert.equal(typeof entry.displayName, "string");
    assert.ok(entry.displayName.trim().length > 0, `${catalogId} must have a non-empty displayName`);
    assert.ok(entry.pluginVersion.length > 0);
    assert.ok(entry.entry.length > 0);
    assert.ok(entry.descriptor.length > 0);
  }
});

test("catalog typing is generic without widening the literal ID union", () => {
  const catalog = fs.readFileSync(new URL("../src/renderer/audio/wamCatalog.ts", import.meta.url), "utf8");
  assert.match(catalog, /displayName:\s*string/);
  assert.match(catalog, /pluginVersion:\s*string/);
  assert.match(catalog, /hasGui:\s*boolean/);
  assert.match(catalog, /export type WamCatalogId = keyof typeof WAM_CATALOG/);
  assert.doesNotMatch(catalog, /id:\s*"burns-simple-delay"/,
    "catalog entry metadata must accept heterogeneous future trusted plugins");
});

test("catalog runtime lookup returns only own trusted IDs", async () => {
  const { WAM_CATALOG, getWamCatalogEntry } = await import("../src/renderer/audio/wamCatalog.ts");
  for (const unknownId of ["untrusted-url", "__proto__", "constructor", "toString"]) {
    assert.equal(getWamCatalogEntry(unknownId), undefined, `${unknownId} is not an own catalog ID`);
  }
  assert.equal(getWamCatalogEntry("burns-simple-delay"), WAM_CATALOG["burns-simple-delay"]);
});

test("trusted catalog restore and URL resolution remain allowlist-driven", async () => {
  const { WAM_CATALOG, getWamCatalogEntry, resolveCatalogEntryForRestore, catalogEntryUrl } = await import("../src/renderer/audio/wamCatalog.ts");
  assert.equal(getWamCatalogEntry("burns-simple-delay")?.license, "MIT");
  assert.equal(resolveCatalogEntryForRestore("burns-simple-delay", "0.0.1")?.pluginVersion, "0.2.54", "version mismatch must still attempt trusted restore");
  assert.equal(resolveCatalogEntryForRestore("untrusted-url", "0.2.54"), undefined);
  assert.equal(catalogEntryUrl(WAM_CATALOG["burns-simple-delay"], "file:///bundle/index.html"), "file:///bundle/wam/burns-simple-delay/index.js");
});

test("catalog adapter forwards WAM-node state and destroy while retaining instance GUI ownership", async () => {
  const { adaptWamInstance } = await import("../src/renderer/audio/wamCatalog.ts");
  const node = new FakeNode() as unknown as AudioNode & {
    getState(): Promise<unknown>; setState(value: unknown): Promise<void>; destroy(): void;
  };
  let saved: unknown; let destroyed = 0; let guiDestroyed = 0;
  (node as any).getState = async () => ({ delay: .25 });
  (node as any).setState = async (value: unknown) => { saved = value; };
  (node as any).destroy = () => { destroyed++; };
  const gui = { remove() {} } as unknown as HTMLElement;
  const adapted = adaptWamInstance({
    audioNode: node,
    createGui: async () => gui,
    destroyGui: async (value) => { assert.equal(value, gui); guiDestroyed++; }
  });
  assert.deepEqual(await adapted.getState?.(), { delay: .25 });
  await adapted.setState?.({ delay: .75 });
  assert.deepEqual(saved, { delay: .75 });
  assert.equal(await adapted.createGui?.(), gui);
  await adapted.destroyGui?.(gui);
  await adapted.destroy?.();
  assert.equal(guiDestroyed, 1); assert.equal(destroyed, 1);
});

test("timeout opens a bounded catalog circuit and late instance is destroyed", async () => {
  let time = 0;
  let destroyed = 0;
  const host = new WamHost(async () => ["group"], {
    deadlineMs: 20,
    circuitThreshold: 1,
    circuitCooldownMs: 100,
    maxDetachedPerCatalog: 1,
    now: () => time
  });
  const loader: WamModuleLoader = async () => ({
    createInstance: async () => {
      await new Promise((done) => setTimeout(done, 40));
      return { audioNode: new FakeNode() as unknown as AudioNode, destroy: () => { destroyed++; } };
    }
  });
  await assert.rejects(host.createPluginInstance(context, loader, "burns-simple-delay"), /wam-timeout/);
  await assert.rejects(host.createPluginInstance(context, loader, "burns-simple-delay"), /wam-circuit-open/);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(destroyed, 1, JSON.stringify(host.getDiagnostics()));
  const diagnostics = host.getDiagnostics();
  assert.ok(diagnostics.events.some((event) => event.outcome === "timeout" && event.reason === "timeout"));
  assert.ok(diagnostics.events.some((event) => event.outcome === "late-disposed"));
  assert.equal(JSON.stringify(diagnostics), JSON.stringify(diagnostics).replace(/https?:\/\//g, ""), "diagnostics do not retain raw URLs");
});

test("state boundary rejects non-JSON values without lossy coercion", () => {
  assert.deepEqual(cloneJsonValue({ valid: [1, true, null] }), { valid: [1, true, null] });
  assert.throws(() => cloneJsonValue({ invalid: undefined }), /invalid-state/);
  assert.throws(() => cloneJsonValue({ invalid: Infinity }), /invalid-state/);
  assert.throws(() => cloneJsonValue(new Date()), /invalid-state/);
  const circular: unknown[] = []; circular.push(circular);
  assert.throws(() => cloneJsonValue(circular), /invalid-state/);
  const protoKey = cloneJsonValue(JSON.parse('{"__proto__":{"state":"data"}}')) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(protoKey), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(protoKey, "__proto__")?.value, { state: "data" });
});
