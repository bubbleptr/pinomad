// launchd appends the host's stdout and stderr to <dataDir>/logs/host.log and
// keeps that file open for the process's whole lifetime. Rotation therefore has
// to copy the file and truncate it in place: renaming it would leave launchd
// writing to the unlinked inode. launchd opens the path with O_APPEND, so the
// next write after the truncate starts at offset 0 and the file stays bounded.
// Lines written between the copy and the truncate can be lost; that is the
// accepted cost of copytruncate.
import { copyFile, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

/** Rotate once host.log grows past this; launchd owns the file, so this stays fixed. */
export const HOST_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Keep host.log.1 through host.log.3; the next rotation drops the oldest. */
export const HOST_LOG_HISTORY = 3;
/** Copying at most ~10 MiB is cheap; ten minutes keeps growth comfortably bounded. */
export const HOST_LOG_CHECK_INTERVAL_MS = 10 * 60 * 1000;

const hostLogPath = (dataDir: string): string => join(dataDir, "logs", "host.log");

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

/**
 * Rotates <dataDir>/logs/host.log when it exceeds the limit.
 *
 * On Linux and foreground runs the file does not exist, in which case this is a
 * no-op. That is deliberate: the file's presence is the only signal needed, and
 * an already installed launchd service picks rotation up without reinstalling
 * its plist.
 */
export async function rotateHostLog(dataDir: string): Promise<boolean> {
  const log = hostLogPath(dataDir);
  let size: number;
  try {
    size = (await stat(log)).size;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (size <= HOST_LOG_MAX_BYTES) return false;

  await rm(`${log}.${HOST_LOG_HISTORY}`, { force: true });
  for (let index = HOST_LOG_HISTORY - 1; index >= 1; index -= 1) {
    try {
      await rename(`${log}.${index}`, `${log}.${index + 1}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  await copyFile(log, `${log}.1`);
  // Truncate the same inode; launchd's open descriptor keeps pointing at it.
  await truncate(log, 0);
  return true;
}

/**
 * Checks once at startup and then every interval. The timer is unref'd so it
 * never holds a shutting-down host open. Rotation failures are logged as one
 * JSON line and otherwise ignored: a full disk or a permission problem must not
 * crash the host or make the service manager restart it.
 */
export function startHostLogRotation(dataDir: string): () => void {
  let running = false;
  const check = (): void => {
    if (running) return;
    running = true;
    void rotateHostLog(dataDir)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${JSON.stringify({ event: "log-rotation-failed", error: message })}\n`);
      })
      .finally(() => {
        running = false;
      });
  };
  check();
  const timer = setInterval(check, HOST_LOG_CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
