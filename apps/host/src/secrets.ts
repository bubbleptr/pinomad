// The host's credential store (ADR-0052 §6): plugin secrets in one JSON file
// under the data dir that only the host's user can read (0600), by plugin and
// name. Only the host reads it; clients set values and learn whether one is
// set, never what it is. A file rather than the OS keychain: the host runs
// headless on Linux as often as on macOS, and a keychain would not keep the
// agent out either — it runs as the same user (§7's sandbox does that).
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";

/** Maps, not objects: a name like `__proto__` or `constructor` is a name like any other. */
type Values = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface SecretStore {
  get(plugin: string, name: string): string | undefined;
  /** `null` removes the value. Resolves once the file holds it. */
  set(plugin: string, name: string, value: string | null): Promise<void>;
}

export async function openSecretStore(path: string): Promise<SecretStore> {
  let values: Values = new Map();
  try {
    values = parse(await readFile(path, "utf8"), path);
    // A file copied in or restored from a backup may have come with looser bits.
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let writing: Promise<void> = Promise.resolve();
  return {
    get: (plugin, name) => values.get(plugin)?.get(name),
    set: (plugin, name, value) => {
      // In order, each from the last stored values; memory follows the file only once the file holds it.
      const write = async (): Promise<void> => {
        const names = new Map(values.get(plugin));
        if (value === null) names.delete(name);
        else names.set(name, value);
        const next = new Map(values);
        if (names.size === 0) next.delete(plugin);
        else next.set(plugin, names);
        // A new file is created 0600 and renamed over the old one, so no moment is readable to others.
        const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(temp, `${serialize(next)}\n`, { mode: 0o600 });
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
  return new Map(Object.entries(value).map(([plugin, names]) => [plugin, new Map(Object.entries(names as Record<string, string>))]));
}

/** `Object.fromEntries` defines own properties, so `__proto__` is written as a key like the others. */
function serialize(values: Values): string {
  return JSON.stringify(Object.fromEntries([...values].map(([plugin, names]) => [plugin, Object.fromEntries(names)])), null, 2);
}
