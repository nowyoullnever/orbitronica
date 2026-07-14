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
    id: "burns-simple-eq",
    displayName: "Burns Simple EQ",
    pluginVersion: "0.2.54",
    packageVersion: "0.2.54",
    license: "MIT",
    entry: "wam/burns-simple-eq/index.js",
    descriptor: "wam/burns-simple-eq/descriptor.json",
    hasGui: true,
  },
  {
    id: "orbitronica-overdrive",
    displayName: "Orbitronica Overdrive",
    pluginVersion: "1.0.0",
    packageVersion: "0.1.0",
    license: "MIT",
    entry: "wam/orbitronica-overdrive/index.js",
    descriptor: "wam/orbitronica-overdrive/descriptor.json",
    hasGui: true,
  },
  {
    id: "orbitronica-compressor",
    displayName: "Orbitronica Compressor",
    pluginVersion: "1.0.0",
    packageVersion: "0.1.0",
    license: "MIT",
    entry: "wam/orbitronica-compressor/index.js",
    descriptor: "wam/orbitronica-compressor/descriptor.json",
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
