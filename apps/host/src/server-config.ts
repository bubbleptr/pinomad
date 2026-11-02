// The joined server's origin at `<dataDir>/server.json` (ADR-0022 §3):
// `pinomad join` writes it, `pinomad leave` removes it, and `pinomad host`
// reads it at startup as the relay to dial. A `--relay` flag and this file
// must agree when both are present, or startup refuses — silently preferring
// one could dial a different server than the operator meant. Every write also
// stamps a fresh random `binding`: the incarnation account offers mint under,
// so a re-join — even to the same origin — retires outstanding ones.
// When the account removes the host (#512), the host writes a removal notice
// naming that server.json's origin and binding; from then on that server.json
// reads as "not joined" until a join writes a new binding and drops the
// notice. Nothing ever moves server.json, so a concurrent join or a crash
// can't lose one.
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** The server and account that removed this host (#512), and the join it ended. */
export interface RemovalNotice {
  readonly origin: string;
  /** The removed server.json's binding; absent when it had none, or there was none. */
  readonly binding?: string;
  readonly username?: string;
  readonly removedAt: number;
}

/** Trailing slashes never distinguish a server; every comparison normalizes them away. */
export const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

/**
 * The server this host is joined to, or undefined — also when the account
 * removed that very join (#512). A notice that doesn't read counts as none:
 * the host then dials once more and the server's 4611 writes it again.
 */
export async function readServerConfig(dataDir: string): Promise<ServerConfig | undefined> {
  const config = await readServerConfigAt(join(dataDir, SERVER_CONFIG_FILE));
  if (config === undefined) return undefined;
  const notice = await readRemovalNotice(dataDir).catch(() => undefined);
  return notice !== undefined && endsJoin(notice, config) ? undefined : config;
}

const endsJoin = (notice: RemovalNotice, config: ServerConfig): boolean =>
  normalizeOrigin(notice.origin) === normalizeOrigin(config.origin) && notice.binding === config.binding;

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
 * The account at `removed.origin` removed this host (#512): records the
 * notice that makes the server.json with that binding read as not joined.
 * A join since then wrote a different binding, which the notice leaves alone.
 */
export async function markRemoved(
  dataDir: string,
  removed: { readonly origin: string; readonly binding?: string; readonly username?: string },
  removedAt = Date.now(),
): Promise<void> {
  await writeJsonFile(join(dataDir, REMOVAL_NOTICE_FILE), {
    origin: normalizeOrigin(removed.origin),
    ...(removed.binding === undefined ? {} : { binding: removed.binding }),
    ...(removed.username === undefined ? {} : { username: removed.username }),
    removedAt,
  });
}

/** The notice `markRemoved` left, or undefined when there is none. */
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
  const { origin, binding, username, removedAt } = (value ?? {}) as {
    origin?: unknown;
    binding?: unknown;
    username?: unknown;
    removedAt?: unknown;
  };
  if (typeof origin !== "string" || typeof removedAt !== "number") throw new Error(`${path} is missing "origin" or "removedAt" — delete it`);
  return {
    origin,
    ...(typeof binding === "string" && binding !== "" ? { binding } : {}),
    ...(typeof username === "string" && username !== "" ? { username } : {}),
    removedAt,
  };
}

export async function removeServerConfig(dataDir: string): Promise<void> {
  await rm(join(dataDir, SERVER_CONFIG_FILE), { force: true });
  await rm(join(dataDir, REMOVAL_NOTICE_FILE), { force: true });
}

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
