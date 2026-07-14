import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWamAssets } from "../scripts/verify-wam-assets.mjs";

const repository = path.resolve(new URL("..", import.meta.url).pathname);
const source = path.join(repository, "public");

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "orbitronica-wam-assets-"));
  const root = path.join(directory, "public");
  cpSync(source, root, { recursive: true });
  return { directory, root };
}

async function rejectsMutation(label: string, mutate: (root: string) => void, expected: RegExp) {
  const { directory, root } = fixture();
  try {
    mutate(root);
    await assert.rejects(verifyWamAssets(root), expected, label);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("WAM asset verifier rejects manifest and payload mutations without rewriting any manifest", async () => {
  const before = new Map<string, string>();
  for (const id of ["burns-simple-delay", "burns-simple-eq", "orbitronica-filter", "orbitronica-overdrive", "orbitronica-compressor", "orbitronica-bitcrusher", "orbitronica-flanger", "orbitronica-phaser", "orbitronica-reverb"])
    before.set(id, createHash("sha256").update(readFileSync(path.join(source, "wam", id, "manifest.json"))).digest("hex"));

  await rejectsMutation("missing manifest", (root) => rmSync(path.join(root, "wam", "orbitronica-filter", "manifest.json")), /missing manifest/);
  await rejectsMutation("extra unlisted asset", (root) => writeFileSync(path.join(root, "wam", "orbitronica-filter", "unexpected.txt"), "not declared"), /asset list mismatch/);
  await rejectsMutation("hashed payload", (root) => writeFileSync(path.join(root, "wam", "orbitronica-filter", "index.js"), "mutated"), /hash mismatch/);
  await rejectsMutation("unsafe entry", (root) => {
    const file = path.join(root, "wam", "orbitronica-filter", "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")); manifest.entry = "../index.js"; writeFileSync(file, JSON.stringify(manifest));
  }, /relative POSIX path|not canonical/);
  await rejectsMutation("source escape", (root) => {
    const file = path.join(root, "wam", "orbitronica-filter", "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")); manifest.sourcePath = "../outside"; writeFileSync(file, JSON.stringify(manifest));
  }, /sourcePath.*relative POSIX path|sourcePath.*not canonical/);
  await rejectsMutation("wrong catalog metadata", (root) => {
    const file = path.join(root, "wam", "orbitronica-filter", "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")); manifest.license = "Unknown"; writeFileSync(file, JSON.stringify(manifest));
  }, /manifest disagrees with catalog/);
  await rejectsMutation("symlink asset", (root) => {
    const plugin = path.join(root, "wam", "orbitronica-filter");
    rmSync(path.join(plugin, "NOTICE.txt")); symlinkSync("descriptor.json", path.join(plugin, "NOTICE.txt"));
  }, /symlink is forbidden|asset is a symlink/);

  for (const [id, expected] of before) {
    const actual = createHash("sha256").update(readFileSync(path.join(source, "wam", id, "manifest.json"))).digest("hex");
    assert.equal(actual, expected, `${id} canonical manifest must remain byte-identical after negative verification`);
  }
});

test("WAM asset verifier rejects a first-party sourcePath symlink escape", async () => {
  const { directory, root } = fixture();
  try {
    const canonicalRoot = path.join(directory, "canonical");
    cpSync(path.join(repository, "plugins"), path.join(canonicalRoot, "plugins"), { recursive: true });
    const sourcePath = path.join(canonicalRoot, "plugins", "src", "orbitronica-filter");
    const outside = path.join(directory, "outside");
    cpSync(sourcePath, outside, { recursive: true });
    rmSync(sourcePath, { recursive: true });
    symlinkSync(outside, sourcePath);
    await assert.rejects(verifyWamAssets(root, { canonicalRoot }), /orbitronica-filter sourcePath must not contain a symlink/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
