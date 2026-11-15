// The host's credential store (ADR-0052 §6): plugin secrets in one JSON file
// under the data dir that only the host's user can read (0600), by plugin and
// name. Only the host reads it; clients set values and learn whether one is
// set, never what it is. A file rather than the OS keychain: the host runs
// headless on Linux as often as on macOS, and a keychain would not keep the
// agent out either — it runs as the same user (§7's sandbox does that).
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";

type Values = Record<string, Record<string, string>>;

export interface SecretStore {
  get(plugin: string, name: string): string | undefined;
  /** `null` removes the value. Resolves once the file holds it. */
  set(plugin: string, name: string, value: string | null): Promise<void>;
}

export async function openSecretStore(path: string): Promise<SecretStore> {
  let values: Values = {};
  try {
    values = parse(await readFile(path, "utf8"), path);
    // A file copied in or restored from a backup may have come with looser bits.
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let writing: Promise<void> = Promise.resolve();
  return {
    get: (plugin, name) => values[plugin]?.[name],
    set: (plugin, name, value) => {
      // In order, each from the last stored values; memory follows the file only once the file holds it.
      const write = async (): Promise<void> => {
        const next: Values = { ...values, [plugin]: { ...values[plugin] } };
        if (value === null) delete next[plugin]![name];
        else next[plugin]![name] = value;
        if (Object.keys(next[plugin]!).length === 0) delete next[plugin];
        // A new file is created 0600 and renamed over the old one, so no moment is readable to others.
        const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        }
        values = next;
      };
      const done = writing.then(write);
      writing = done.catch(() => {});
      return done;
    },
  };
}

function parse(text: string, path: string): Values {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the text around the error, which holds secrets.
    throw new Error(`${path} is not valid JSON`);
  }
  const record = (each: unknown): each is Record<string, unknown> => typeof each === "object" && each !== null && !Array.isArray(each);
  if (!record(value) || !Object.values(value).every((plugin) => record(plugin) && Object.values(plugin).every((each) => typeof each === "string"))) {
    throw new Error(`${path} is not a map of plugin names to secret values`);
  }
  return value as Values;
}
