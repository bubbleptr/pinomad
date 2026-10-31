import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/**
 * Rewrites a current database back to schema 3: no account devices or
 * device reports, sessions without a device column (ADR-0037). Foreign keys
 * are off on this raw connection, so the rebuild doesn't cascade.
 */
export function downgradeToSchema3(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec(`
    DROP TABLE pending_revocations;
    DROP TABLE vouchings;
    CREATE TABLE sessions_v3 (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT INTO sessions_v3 SELECT token_hash, user_id, created_at, expires_at FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_v3 RENAME TO sessions;
    DROP TABLE account_devices;
    ALTER TABLE hosts DROP COLUMN device_reports;
    PRAGMA user_version = 3;
  `);
  db.close();
}
