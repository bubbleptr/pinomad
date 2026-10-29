// Data-directory lock, same mechanism as the host (apps/host/src/host.ts): (CI probe)
// proper-lockfile on the directory itself. SQLite has no cross-process writer
// protection worth trusting here — a second server would corrupt state.
// Duplicated rather than shared so the host is untouched.

import lockfile from "proper-lockfile";

// `stale` is judged by the contender: a lock whose mtime is older than the
// contender's stale value gets broken. Holders refresh every stale/2, so every
// participant must use the same stale value — a smaller one would steal a live
// lock; that's why callers only tune retries, never stale below the default.

/** Locks `dir`; the returned function releases. Throws when another process holds a fresh lock. */
export async function lockDataDir(
  dir: string,
  options?: { readonly staleMs?: number; readonly retries?: number },
): Promise<() => Promise<void>> {
  const stale = Math.max(2000, options?.staleMs ?? 10_000);
  let releasing = false;
  const release = await lockfile
    .lock(dir, {
      realpath: false,
      stale,
      // proper-lockfile always breaks a stale lock; retries only cover a live holder.
      retries: { retries: options?.retries ?? Math.ceil(stale / 1000) + 2, minTimeout: 1000, maxTimeout: 1000 },
      onCompromised: (error: Error) => {
        // Its mtime stat doesn't check `released`: an in-flight stat that lands
        // after our own unlock reports ECOMPROMISED from a timer callback where
        // the throw only pollutes. A real compromise (lock removed under us)
        // still throws — running unlocked would risk the database.
        if (!releasing) throw error;
      },
    })
    .catch((error: unknown) => {
      // Only a held lock means "running"; anything else (an unwritable parent
      // for `<dir>.lock`, say) must surface as itself or deploys misdiagnose.
      if ((error as { code?: string }).code !== "ELOCKED") throw error;
      throw new Error(`Data directory is already in use by a running process: ${dir}`, { cause: error });
    });
  return async () => {
    releasing = true;
    await release();
  };
}
