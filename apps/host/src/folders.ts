// The folder picker's browse call (roadmap M5, project entry): a client walks the
// host's filesystem one directory at a time until it finds the folder to
// register as a project.
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FolderListing } from "@pinomad/protocol/organization.ts";

const denied = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM";
};

/**
 * One picker page: `path` (or the host user's home when absent) resolved to its
 * real path, plus its visible subdirectories in natural, case-insensitive
 * order. Child paths are `join(path, name)` — never realpath'd here; a picker
 * registration goes through `addProject`, which normalizes.
 */
export async function listFolders(path: string | undefined, home: string): Promise<FolderListing> {
  if (path !== undefined && !isAbsolute(path)) throw new Error(`Not an absolute path: ${path}`);
  const given = path ?? home;
  // Same identity rule as project paths: realpath decides what a folder is.
  const dir = await realpath(given).catch(() => {
    throw new Error(`No such directory: ${given}`);
  });
  if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${given}`);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (denied(error)) throw new Error(`Permission denied: ${given}`);
    throw error;
  }
  const folders: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    // A symlink is listed iff its target is a directory; broken links and
    // links to files are skipped, never thrown on.
    if (!isDirectory && entry.isSymbolicLink()) {
      isDirectory = await stat(join(dir, entry.name)).then(
        (target) => target.isDirectory(),
        () => false,
      );
    }
    if (isDirectory) folders.push({ name: entry.name, path: join(dir, entry.name) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
  // Resolved like `path`, so a client can match the two to show `~`.
  return { path: dir, home: await realpath(home).catch(() => home), folders };
}
