import path from "node:path";

const PROJECT_EXTENSION = ".orb";

/** Applies the new-project extension without changing ordinary saves to an existing path. */
export function newProjectPath(filePath: string): string {
  if (filePath.toLowerCase().endsWith(PROJECT_EXTENSION)) return filePath;
  const extension = path.extname(filePath);
  return `${extension ? filePath.slice(0, -extension.length) : filePath}${PROJECT_EXTENSION}`;
}

export const projectDialogExtensions = ["orb", "orbitonic"];
