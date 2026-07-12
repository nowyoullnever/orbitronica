import path from "node:path";

export type ProjectOrbitAssetRecord = {
  id: string;
  audioName?: string;
  audioPath?: string;
};

type ProjectShape = Record<string, unknown> & {
  orbits?: unknown;
  scenes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validOrbits(value: unknown): ProjectOrbitAssetRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((orbit): orbit is ProjectOrbitAssetRecord =>
    isRecord(orbit) && typeof orbit.id === "string" && orbit.id.length > 0);
}

/** Discovers nested v5 or legacy top-level v4/unversioned orbits without Electron side effects. */
export function collectProjectOrbits(project: unknown): ProjectOrbitAssetRecord[] {
  if (!isRecord(project)) return [];
  const value = project as ProjectShape;
  if (Array.isArray(value.scenes)) {
    return value.scenes.flatMap((scene) => isRecord(scene) ? validOrbits(scene.orbits) : []);
  }
  return validOrbits(value.orbits);
}

export function portableAudioPath(fileName: string): string {
  return path.posix.join("audio", fileName);
}

/** Returns an immutable project copy with paths applied at the original nesting depth. */
export function rewriteProjectAudioPaths<T extends Record<string, unknown>>(
  project: T,
  audioPaths: ReadonlyMap<string, string> | Readonly<Record<string, string>>
): T {
  const lookup = audioPaths instanceof Map
    ? (id: string) => audioPaths.get(id)
    : (id: string) => Object.prototype.hasOwnProperty.call(audioPaths, id) ? audioPaths[id] : undefined;
  const copy = structuredClone(project) as ProjectShape;
  const rewrite = (value: unknown) => Array.isArray(value) ? value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return entry;
    const audioPath = lookup(entry.id);
    return typeof audioPath === "string" ? { ...entry, audioPath } : entry;
  }) : value;

  if (Array.isArray(copy.scenes)) {
    copy.scenes = copy.scenes.map((scene) => isRecord(scene)
      ? { ...scene, orbits: rewrite(scene.orbits) }
      : scene);
  } else if (Array.isArray(copy.orbits)) {
    copy.orbits = rewrite(copy.orbits);
  }
  return copy as T;
}

export type ProjectAssetDescriptor = {
  orbitId: string;
  audioPath?: string;
  absolutePath?: string;
  error?: string;
};

export function resolveProjectAssetPath(projectDirectory: string, audioPath: string): string | null {
  if (!audioPath || path.isAbsolute(audioPath)) return null;
  const root = path.resolve(projectDirectory);
  const absolute = path.resolve(root, audioPath);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return absolute;
}

export function describeProjectAssets(project: unknown, projectDirectory: string): ProjectAssetDescriptor[] {
  return collectProjectOrbits(project).map((orbit) => {
    if (!orbit.audioPath) return { orbitId: orbit.id, error: "No audio path saved." };
    const absolutePath = resolveProjectAssetPath(projectDirectory, orbit.audioPath);
    if (!absolutePath) {
      return { orbitId: orbit.id, audioPath: orbit.audioPath, error: `Unsafe audio path: ${orbit.audioPath}` };
    }
    return { orbitId: orbit.id, audioPath: orbit.audioPath, absolutePath };
  });
}
