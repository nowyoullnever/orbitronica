import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The one piece of hashing logic that is genuinely identical across
// verify-wam-assets.mjs, verify-plugins-deterministic.mjs, and
// update-wam-hashes.mjs: sha256 of a single file's bytes, hex-encoded.
//
// The three scripts' *tree-walking* is intentionally NOT unified here:
// - update-wam-hashes.mjs hashes only the immediate children of a plugin's
//   output directory (non-recursive) because build-plugins.mjs always
//   produces a flat directory per plugin.
// - verify-plugins-deterministic.mjs recursively walks and returns a nested
//   { relativePath: { type, sha256 } } map (order-sensitive, compared via
//   JSON.stringify) to catch generated-path/type drift, not just content.
// - verify-wam-assets.mjs recursively walks into a flat, globally-sorted
//   list of relative names (filesBelow) and hashes each named asset
//   separately, to support vendored/wrapped-vendored plugins that may nest
//   assets in subdirectories, and to compare that list against a manifest.
// Forcing these into one traversal would change either recursion depth,
// output shape, or sort/comparison semantics, so only the leaf primitive is
// shared.
export function hashFile(absolutePath) {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}
