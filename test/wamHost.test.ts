import assert from "node:assert/strict";
import test from "node:test";
import { WamHost, type WamModuleLoader } from "../src/renderer/audio/wamHost.ts";

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
  const source = new FakeNode();
  const destination = new FakeNode();
  await Promise.all([
    host.insertPreFader(context, source as unknown as AudioNode, destination as unknown as AudioNode, loader),
    host.insertPreFader(context, source as unknown as AudioNode, destination as unknown as AudioNode, loader)
  ]);
  await host.insertPreFader(secondContext, source as unknown as AudioNode, destination as unknown as AudioNode, loader);
  assert.equal(loads, 2);
  assert.equal(hostInitializations, 2);

  const retryHost = new WamHost(async () => {});
  let attempts = 0;
  const flaky: WamModuleLoader = async () => {
    if (++attempts === 1) throw new Error("registration failed");
    return { createInstance: async () => ({ audioNode: new FakeNode() as unknown as AudioNode, getState: async () => ({}), setState: async () => {} }) };
  };
  await assert.rejects(retryHost.insertPreFader(context, source as unknown as AudioNode, destination as unknown as AudioNode, flaky));
  await retryHost.insertPreFader(context, source as unknown as AudioNode, destination as unknown as AudioNode, flaky);
  assert.equal(attempts, 2);
});

test("pre-fader insert round-trips state, GUI, and the dry connection during cleanup", async () => {
  const host = new WamHost(async () => {});
  const source = new FakeNode();
  const destination = new FakeNode();
  const wamNode = new FakeNode();
  source.connect(destination);
  let state: unknown = { mix: .25 };
  let destroyed = 0;
  let removed = 0;
  const gui = { remove: () => { removed++; } } as unknown as HTMLElement;
  const loader: WamModuleLoader = async () => ({
    createInstance: async () => ({
      audioNode: wamNode as unknown as AudioNode,
      getState: async () => state,
      setState: async (next) => { state = next; },
      createGui: () => gui,
      destroy: async () => { destroyed++; }
    })
  });
  const insert = await host.insertPreFader(context, source as unknown as AudioNode, destination as unknown as AudioNode, loader);
  assert.equal(source.edges.has(destination), false, "dry route is replaced before the orbit gain/fader");
  assert.equal(source.edges.has(wamNode), true);
  assert.equal(wamNode.edges.has(destination), true);
  await insert.setState({ mix: .8, enabled: true });
  assert.deepEqual(await insert.getState(), { mix: .8, enabled: true });
  const container = { append: (element: HTMLElement) => assert.equal(element, gui) } as unknown as HTMLElement;
  insert.mountGui(container);
  await insert.cleanup();
  await insert.cleanup();
  assert.equal(removed, 1);
  assert.equal(destroyed, 1);
  assert.equal(source.edges.has(wamNode), false);
  assert.equal(wamNode.edges.has(destination), false);
  assert.equal(source.edges.has(destination), true, "cleanup restores the dry pre-fader route");
});
