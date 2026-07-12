/**
 * The renderer's executable WAM allowlist. Project documents may name only a
 * catalog id; they never provide a URL, module specifier, or import option.
 */
import type { JsonValue, WamPluginInstance, WamPluginModule } from "./wamHost.ts";

export type WamCatalogEntry = Readonly<{
  id: "burns-simple-delay";
  pluginVersion: "0.2.54";
  packageVersion: "0.2.54";
  license: "MIT";
  entry: "wam/burns-simple-delay/index.js";
  descriptor: "wam/burns-simple-delay/descriptor.json";
  hasGui: true;
}>;

export const WAM_CATALOG = {
  "burns-simple-delay": {
    id: "burns-simple-delay",
    pluginVersion: "0.2.54",
    packageVersion: "0.2.54",
    license: "MIT",
    entry: "wam/burns-simple-delay/index.js",
    descriptor: "wam/burns-simple-delay/descriptor.json",
    hasGui: true
  }
} as const satisfies Record<string, WamCatalogEntry>;

export type WamCatalogId = keyof typeof WAM_CATALOG;

export function getWamCatalogEntry(id: string): WamCatalogEntry | undefined {
  return WAM_CATALOG[id as WamCatalogId];
}

/**
 * Restore is allowlist-driven, not producer-version-gated. `pluginVersion` in
 * a document identifies the state producer for future migrations; a known
 * trusted catalog entry still gets one guarded hydrate attempt when it differs.
 */
export function resolveCatalogEntryForRestore(catalogId: string, _storedPluginVersion: string): WamCatalogEntry | undefined {
  return getWamCatalogEntry(catalogId);
}

/** Resolves only a compiled allowlist asset under the current renderer root. */
export function catalogEntryUrl(entry: WamCatalogEntry, locationHref = window.location.href): string {
  return new URL(`./${entry.entry}`, locationHref).toString();
}

type WamAudioNode = AudioNode & {
  getState?(): Promise<unknown>;
  setState?(state: JsonValue): Promise<void>;
  destroy?(): Promise<void> | void;
};

type WamInstance = {
  audioNode: WamAudioNode;
  createGui?(): Promise<HTMLElement> | HTMLElement;
  destroyGui?(gui: HTMLElement): Promise<void> | void;
};

type WamConstructor = {
  createInstance(groupId: string, context: AudioContext): Promise<{
    audioNode: WamAudioNode;
    createGui?(): Promise<HTMLElement> | HTMLElement;
    destroyGui?(gui: HTMLElement): Promise<void> | void;
  }>;
};

/**
 * WAM 2 instances expose GUI ownership on the instance but state and destroy
 * on its WamNode. Keep that split explicit rather than relying on an accidental
 * structural cast: racks consume one host-facing instance shape.
 */
export function adaptWamInstance(instance: WamInstance): WamPluginInstance {
  const node = instance.audioNode;
  return {
    audioNode: node,
    getState: node.getState?.bind(node),
    setState: node.setState?.bind(node),
    destroy: node.destroy?.bind(node),
    createGui: instance.createGui?.bind(instance),
    destroyGui: instance.destroyGui?.bind(instance)
  };
}

/**
 * Imports one audited artifact. `vite-ignore` is intentional: the compiled
 * catalog, rather than user-controlled project data, determines this URL.
 */
export async function loadCatalogModule(entry: WamCatalogEntry): Promise<WamPluginModule> {
  const moduleUrl = catalogEntryUrl(entry);
  const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: WamConstructor };
  if (!imported.default || typeof imported.default.createInstance !== "function") {
    throw new Error("catalog-module-invalid");
  }
  return {
    createInstance: async (context, hostGroupId) => {
      if (!hostGroupId) throw new Error("wam-host-group-missing");
      const instance = await imported.default!.createInstance(hostGroupId, context);
      if (!instance?.audioNode) throw new Error("catalog-instance-invalid");
      return adaptWamInstance(instance);
    }
  };
}
