/** DOM-free serializable source of truth for the trusted WAM allowlist. */
export type WamCatalogDataEntry = Readonly<{
  id: string;
  displayName: string;
  pluginVersion: string;
  packageVersion: string;
  license: string;
  entry: string;
  descriptor: string;
  hasGui: boolean;
}>;

export const WAM_CATALOG_DATA = [
  {
    id: "burns-simple-delay",
    displayName: "Burns Simple Delay",
    pluginVersion: "0.2.54",
    packageVersion: "0.2.54",
    license: "MIT",
    entry: "wam/burns-simple-delay/index.js",
    descriptor: "wam/burns-simple-delay/descriptor.json",
    hasGui: true,
  },
  {
    id: "orbitronica-filter",
    displayName: "Orbitronica Filter",
    pluginVersion: "1.0.0",
    packageVersion: "0.1.0",
    license: "MIT",
    entry: "wam/orbitronica-filter/index.js",
    descriptor: "wam/orbitronica-filter/descriptor.json",
    hasGui: true,
  },
] as const satisfies readonly WamCatalogDataEntry[];
