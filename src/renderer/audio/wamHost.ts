/**
 * Small, SDK-agnostic boundary for development WAM experiments.
 *
 * Keeping the WAM module loader injected lets the renderer host a particular
 * SDK version without spreading its untyped browser globals through the audio
 * engine. A loader is initialized once for each AudioContext because WAM
 * registration is context scoped.
 */
export type WamState = unknown;

export type WamPluginInstance = {
  audioNode: AudioNode;
  getState(): Promise<WamState>;
  setState(state: WamState): Promise<void>;
  createGui?(): HTMLElement;
  destroy?(): Promise<void> | void;
};

export type WamPluginModule = {
  createInstance(context: AudioContext): Promise<WamPluginInstance>;
};

export type WamModuleLoader = (context: AudioContext) => Promise<WamPluginModule>;
export type WamHostInitializer = (context: AudioContext) => Promise<unknown>;

const initializeSdkHost: WamHostInitializer = async (context) => {
  // The SDK defines AudioWorkletNode at module evaluation time. Delay that
  // browser-only import until a real renderer asks to attach a WAM so Node
  // tests and non-WAM application startup stay environment-neutral.
  const { initializeWamHost } = await import("@webaudiomodules/sdk");
  return initializeWamHost(context);
};

export class WamInsert {
  private cleanedUp = false;
  private gui: HTMLElement | null = null;
  private readonly source: AudioNode;
  private readonly destination: AudioNode;
  private readonly instance: WamPluginInstance;

  constructor(source: AudioNode, destination: AudioNode, instance: WamPluginInstance) {
    this.source = source;
    this.destination = destination;
    this.instance = instance;
  }

  async getState(): Promise<WamState> {
    return this.instance.getState();
  }

  async setState(state: WamState): Promise<void> {
    await this.instance.setState(state);
  }

  mountGui(container: HTMLElement): HTMLElement | null {
    if (!this.instance.createGui) return null;
    this.gui?.remove();
    const gui = this.instance.createGui();
    container.append(gui);
    this.gui = gui;
    return gui;
  }

  async cleanup(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.gui?.remove();
    this.gui = null;
    try { this.source.disconnect(this.instance.audioNode); } catch { /* already disconnected */ }
    try { this.instance.audioNode.disconnect(this.destination); } catch { /* already disconnected */ }
    this.source.connect(this.destination);
    await this.instance.destroy?.();
  }
}

export class WamHost {
  private readonly initializeHost: WamHostInitializer;
  private readonly hostInitializations = new WeakMap<AudioContext, Promise<unknown>>();
  private readonly moduleLoads = new WeakMap<AudioContext, Promise<WamPluginModule>>();

  constructor(initializeHost: WamHostInitializer = initializeSdkHost) {
    this.initializeHost = initializeHost;
  }

  private async initialize(context: AudioContext): Promise<void> {
    const cached = this.hostInitializations.get(context);
    if (cached) { await cached; return; }
    const initialization = this.initializeHost(context);
    this.hostInitializations.set(context, initialization);
    try {
      await initialization;
    } catch (error) {
      this.hostInitializations.delete(context);
      throw error;
    }
  }

  private async loadModule(context: AudioContext, loader: WamModuleLoader): Promise<WamPluginModule> {
    const cached = this.moduleLoads.get(context);
    if (cached) return cached;
    const load = loader(context);
    this.moduleLoads.set(context, load);
    try {
      return await load;
    } catch (error) {
      // A failed registration is retryable, matching the recorder worklet loader.
      this.moduleLoads.delete(context);
      throw error;
    }
  }

  async insertPreFader(
    context: AudioContext,
    source: AudioNode,
    destination: AudioNode,
    loader: WamModuleLoader
  ): Promise<WamInsert> {
    await this.initialize(context);
    const module = await this.loadModule(context, loader);
    const instance = await module.createInstance(context);
    try {
      source.disconnect(destination);
      source.connect(instance.audioNode);
      instance.audioNode.connect(destination);
      return new WamInsert(source, destination, instance);
    } catch (error) {
      try { source.disconnect(instance.audioNode); } catch { /* incomplete connection */ }
      try { instance.audioNode.disconnect(destination); } catch { /* incomplete connection */ }
      source.connect(destination);
      await instance.destroy?.();
      throw error;
    }
  }
}
