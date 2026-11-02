// The joined server's origin at `<dataDir>/server.json` (ADR-0022 §3):
// `pinomad join` writes it, `pinomad leave` removes it, and `pinomad host`
// reads it at startup as the relay to dial. A `--relay` flag and this file
// must agree when both are present, or startup refuses — silently preferring
// one could dial a different server than the operator meant. Every write also
// stamps a fresh random `binding`: the incarnation account offers mint under,
// so a re-join — even to the same origin — retires outstanding ones.
// When the account removes the host (#512), server.json gives way to a
// removal notice that `pinomad status` shows until the next join.
import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SERVER_CONFIG_FILE = "server.json";
export const REMOVAL_NOTICE_FILE = "server-removed.json";

export interface ServerConfig {
  readonly origin: string;
  /**
   * Random incarnation minted by each `writeServerConfig`. Absent only on
   * files written before it existed (a dev checkout between the join PR and
   * admission): the host still joins and connects, but no account offer can
   * mint until a fresh `pinomad join` stamps one.
   */
  readonly binding?: string;
  /** The account the host joined, for `pinomad status`; files from before it existed lack it. */
  readonly username?: string;
}

/** The server and account that removed this host (#512). */
export interface RemovalNotice {
  readonly origin: string;
  readonly username?: string;
  readonly removedAt: number;
}

/** Trailing slashes never distinguish a server; every comparison normalizes them away. */
export const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

export const readServerConfig = (dataDir: string): Promise<ServerConfig | undefined> =>
  readServerConfigAt(join(dataDir, SERVER_CONFIG_FILE));

async function readServerConfigAt(path: string): Promise<ServerConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON — delete it or run \`pinomad leave\``);
  }
  const origin = (value as { origin?: unknown } | null)?.origin;
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new Error(`${path} is missing a string "origin"`);
  }
  const { binding, username } = value as { binding?: unknown; username?: unknown };
  return {
    origin,
    ...(typeof binding === "string" && binding !== "" ? { binding } : {}),
    ...(typeof username === "string" && username !== "" ? { username } : {}),
  };
}

/** Tmp-then-rename like settings.json: a crash must not leave a truncated file. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function writeServerConfig(dataDir: string, config: Omit<ServerConfig, "binding">): Promise<void> {
  await writeJsonFile(join(dataDir, SERVER_CONFIG_FILE), {
    origin: normalizeOrigin(config.origin),
    binding: randomBytes(16).toString("base64url"),
    ...(config.username === undefined ? {} : { username: config.username }),
  });
  await rm(join(dataDir, REMOVAL_NOTICE_FILE), { force: true });
}

/**
 * The account removed this host (#512): server.json gives way to a removal
 * notice, but only the server.json the removed link ran under — same origin
 * and binding. A re-join, even to the same server, writes a fresh binding
 * and must survive. The file is claimed by renaming it aside, so a join
 * writing a new one meanwhile is never deleted; a claimed file that turns
 * out newer goes back unless yet another write took its place. False when
 * nothing was forgotten.
 */
export async function forgetRemovedServer(
  dataDir: string,
  removed: { readonly origin: string; readonly binding?: string },
  removedAt = Date.now(),
): Promise<boolean> {
  const path = join(dataDir, SERVER_CONFIG_FILE);
  const claimed = `${path}.removed-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(path, claimed);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
  try {
    const config = await readServerConfigAt(claimed).catch(() => undefined);
    if (
      config === undefined ||
      normalizeOrigin(config.origin) !== normalizeOrigin(removed.origin) ||
      config.binding !== removed.binding
    ) {
      // link(), unlike rename(), never replaces a file a join wrote since.
      await link(claimed, path).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      });
      return false;
    }
    await writeJsonFile(join(dataDir, REMOVAL_NOTICE_FILE), {
      origin: normalizeOrigin(config.origin),
      ...(config.username === undefined ? {} : { username: config.username }),
      removedAt,
    });
    return true;
  } finally {
    await rm(claimed, { force: true });
  }
}

/** The notice `forgetRemovedServer` left, or undefined when there is none. */
export async function readRemovalNotice(dataDir: string): Promise<RemovalNotice | undefined> {
  const path = join(dataDir, REMOVAL_NOTICE_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON — delete it`);
  }
  const { origin, username, removedAt } = (value ?? {}) as { origin?: unknown; username?: unknown; removedAt?: unknown };
  if (typeof origin !== "string" || typeof removedAt !== "number") throw new Error(`${path} is missing "origin" or "removedAt" — delete it`);
  return { origin, ...(typeof username === "string" && username !== "" ? { username } : {}), removedAt };
}

export const removeServerConfig = (dataDir: string): Promise<void> =>
  rm(join(dataDir, SERVER_CONFIG_FILE), { force: true });

/**
 * The random incarnation in the current server.json (ADR-0022 §6): each
 * write stamps a fresh one, so every join/leave — even back to the same
 * origin — retires the account offers minted under the old binding.
 */
export async function readServerBinding(dataDir: string): Promise<string | undefined> {
  return (await readServerConfig(dataDir))?.binding;
}

/** `--relay` wins ties only when equal; a disagreement between it and server.json is an error. */
export function resolveRelayOrigin(flag: string | undefined, config: ServerConfig | undefined): string | undefined {
  if (
    flag !== undefined &&
    config !== undefined &&
    normalizeOrigin(flag) !== normalizeOrigin(config.origin)
  ) {
    throw new Error(`--relay ${flag} disagrees with ${SERVER_CONFIG_FILE} (${config.origin}) — remove one`);
  }
  return flag ?? config?.origin;
}
