// Single source of truth for the first-party WAM plugin ids. Keep this list in
// sync with plugins/src/*; every build/verify/hash-update script imports it
// from here instead of re-declaring the array.
export const FIRST_PARTY_PLUGIN_IDS = [
  "orbitronica-filter",
  "orbitronica-overdrive",
  "orbitronica-compressor",
  "orbitronica-bitcrusher",
  "orbitronica-flanger",
  "orbitronica-phaser",
  "orbitronica-reverb"
];
