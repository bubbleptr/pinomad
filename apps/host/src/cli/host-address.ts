import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Holds `session.sqlite`, the token, and the lock; one host process per data dir. */
export const DEFAULT_DATA_DIR = process.env.PINOMAD_DATA_DIR ?? join(homedir(), ".pinomad");

/** A client's `--url`, and `--token` or the token file a host on the same machine left in `--data-dir`. */
export async function hostAddress(argv: readonly string[]): Promise<{ url: string; token: string; dataDir: string }> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "data-dir": { type: "string" },
      url: { type: "string", default: "ws://127.0.0.1:7420" },
      token: { type: "string" },
    },
  });
  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  const token = values.token ?? (await readFile(join(dataDir, "token"), "utf8")).trim();
  return { url: values.url, token, dataDir };
}
