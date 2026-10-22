import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Remove a test temp dir and the data-dir lock proper-lockfile puts beside it. */
export async function removeTempDir(path: string): Promise<void> {
  await Promise.all([
    rm(path, { recursive: true, force: true }),
    rm(`${path}.lock`, { recursive: true, force: true }),
  ]);
}

/** A fresh temp data dir, tracked in `dirs` for afterEach cleanup. */
export async function tempDir(dirs: string[], prefix = "pinomad-server-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
