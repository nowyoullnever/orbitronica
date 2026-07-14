import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(`WAM asset verification failed: ${message}`); }
function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) fail(`${label} must be a relative POSIX path`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) fail(`${label} is not canonical: ${value}`);
  return normalized;
}
function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail(`${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`); }
}
function filesBelow(root, current = root, names = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink is forbidden: ${absolute}`);
    if (entry.isDirectory()) filesBelow(root, absolute, names);
    else if (entry.isFile()) names.push(path.relative(root, absolute).split(path.sep).join("/"));
    else fail(`unsupported filesystem entry: ${absolute}`);
  }
  return names.sort();
}
function equalBytes(left, right, label) {
  if (!readFileSync(left).equals(readFileSync(right))) fail(`${label} differs from canonical manifest`);
}
function canonicalSourcePath(canonicalRoot, sourcePath, label) {
  const candidate = path.resolve(canonicalRoot, sourcePath);
  if (!existsSync(candidate)) fail(`${label} is missing: ${candidate}`);
  let current = canonicalRoot;
  for (const segment of path.relative(canonicalRoot, candidate).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) fail(`${label} must not contain a symlink: ${current}`);
  }
  const root = realpathSync(canonicalRoot), resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail(`${label} escapes canonical root: ${candidate}`);
  return candidate;
}
function manifestOrigin(manifest, label) {
  if (!manifest || typeof manifest !== "object") fail(`${label} must be an object`);
  for (const key of ["catalogId", "origin", "package", "packageVersion", "pluginVersion", "license", "source", "entry", "descriptor", "assets"]) {
    if (typeof manifest[key] !== (key === "assets" ? "object" : "string") || !manifest[key]) fail(`${label}.${key} is required`);
  }
  if (!["first-party", "vendored", "wrapped-vendored"].includes(manifest.origin)) fail(`${label}.origin is invalid`);
  safeRelative(manifest.entry, `${label}.entry`); safeRelative(manifest.descriptor, `${label}.descriptor`);
  if (manifest.origin === "first-party") {
    safeRelative(manifest.sourcePath, `${label}.sourcePath`);
    if (typeof manifest.buildTool !== "string" || !manifest.buildTool) fail(`${label}.buildTool is required`);
  } else {
    for (const key of ["tarballUrl", "packageSha256", "npmIntegrity", "gitHead"]) if (typeof manifest[key] !== "string" || !manifest[key]) fail(`${label}.${key} is required`);
  }
  if (manifest.origin === "wrapped-vendored") {
    if (!manifest.adapter || typeof manifest.adapter !== "object") fail(`${label}.adapter is required`);
    for (const key of ["entry", "upstreamEntry", "sourcePath", "buildTool"]) {
      if (typeof manifest.adapter[key] !== "string" || !manifest.adapter[key]) fail(`${label}.adapter.${key} is required`);
    }
    safeRelative(manifest.adapter.entry, `${label}.adapter.entry`); safeRelative(manifest.adapter.upstreamEntry, `${label}.adapter.upstreamEntry`); safeRelative(manifest.adapter.sourcePath, `${label}.adapter.sourcePath`);
  }
}

export async function verifyWamAssets(root = "public", { mode = "auto", canonicalRoot = repoRoot } = {}) {
  const absoluteRoot = path.resolve(root);
  const effectiveMode = mode === "auto" ? (path.basename(absoluteRoot) === "dist" ? "dist" : "public") : mode;
  if (!["public", "dist"].includes(effectiveMode)) fail(`unknown mode: ${effectiveMode}`);
  const wamRoot = path.join(absoluteRoot, "wam");
  if (!existsSync(wamRoot) || !lstatSync(wamRoot).isDirectory()) fail(`missing WAM root: ${wamRoot}`);
  const { WAM_CATALOG_DATA } = await import(pathToFileURL(path.join(repoRoot, "src/renderer/audio/wamCatalogData.ts")).href);
  const catalog = new Map(WAM_CATALOG_DATA.map((entry) => [entry.id, entry]));
  const directories = readdirSync(wamRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (directories.join("\0") !== [...catalog.keys()].sort().join("\0")) fail(`catalog directories mismatch: expected ${[...catalog.keys()].join(", ")}, got ${directories.join(", ")}`);

  for (const id of directories) {
    const entry = catalog.get(id); const pluginRoot = path.join(wamRoot, id); const manifestPath = path.join(pluginRoot, "manifest.json");
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) fail(`missing manifest: ${manifestPath}`);
    const manifest = readJson(manifestPath, `${id}/manifest.json`); manifestOrigin(manifest, `${id}/manifest.json`);
    if (manifest.catalogId !== id || manifest.packageVersion !== entry.packageVersion || manifest.pluginVersion !== entry.pluginVersion || manifest.license !== entry.license) fail(`${id} manifest disagrees with catalog`);
    if (safeRelative(manifest.entry, `${id}.entry`) !== entry.entry.slice(`wam/${id}/`.length) || safeRelative(manifest.descriptor, `${id}.descriptor`) !== entry.descriptor.slice(`wam/${id}/`.length)) fail(`${id} manifest paths disagree with catalog`);
    const expected = manifest.assets;
    const expectedNames = Object.keys(expected).map((name) => safeRelative(name, `${id}.assets`)).sort();
    if (new Set(expectedNames).size !== expectedNames.length) fail(`${id} manifest has duplicate normalized asset names`);
    if (expectedNames.includes("manifest.json")) fail(`${id} manifest must not hash itself`);
    const actualNames = filesBelow(pluginRoot).filter((name) => name !== "manifest.json");
    if (actualNames.join("\0") !== expectedNames.join("\0")) fail(`${id} asset list mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`);
    for (const name of expectedNames) {
      if (typeof expected[name] !== "string" || !SHA256.test(expected[name])) fail(`${id} invalid SHA-256 for ${name}`);
      const asset = path.join(pluginRoot, ...name.split("/"));
      if (lstatSync(asset).isSymbolicLink()) fail(`${id} asset is a symlink: ${name}`);
      const hash = createHash("sha256").update(readFileSync(asset)).digest("hex");
      if (hash !== expected[name]) fail(`${id} hash mismatch for ${name}: ${hash}`);
    }
    if (effectiveMode === "public" && (manifest.origin === "first-party" || manifest.origin === "wrapped-vendored")) {
      const sourcePath = manifest.origin === "first-party" ? manifest.sourcePath : manifest.adapter.sourcePath;
      const canonical = path.join(canonicalSourcePath(canonicalRoot, sourcePath, `${id} sourcePath`), "manifest.json");
      if (!existsSync(canonical)) fail(`${id} canonical manifest is missing: ${canonical}`);
      equalBytes(canonical, manifestPath, `${id} public manifest`);
    }
  }
  return { mode: effectiveMode, catalogIds: directories };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? "public";
  const result = await verifyWamAssets(root);
  console.log(`Verified WAM assets (${result.mode}): ${result.catalogIds.join(", ")}.`);
}
