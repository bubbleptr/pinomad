// The joined server's origin at `<dataDir>/server.json` (ADR-0022 §3):
// `pinomad join` writes it, `pinomad leave` removes it, and `pinomad host`
// reads it at startup as the relay to dial. A `--relay` flag and this file
// must agree when both are present, or startup refuses — silently preferring
// one could dial a different server than the operator meant.
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SERVER_CONFIG_FILE = "server.json";

export interface ServerConfig {
  readonly origin: string;
}

/** Trailing slashes never distinguish a server; every comparison normalizes them away. */
export const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

export async function readServerConfig(dataDir: string): Promise<ServerConfig | undefined> {
  let text: string;
  try {
    text = await readFile(join(dataDir, SERVER_CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${join(dataDir, SERVER_CONFIG_FILE)} is not valid JSON — delete it or run \`pinomad leave\``);
  }
  const origin = (value as { origin?: unknown } | null)?.origin;
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new Error(`${join(dataDir, SERVER_CONFIG_FILE)} is missing a string "origin"`);
  }
  return { origin };
}

/** Tmp-then-rename like settings.json: a crash must not leave a truncated file. */
export async function writeServerConfig(dataDir: string, config: ServerConfig): Promise<void> {
  const path = join(dataDir, SERVER_CONFIG_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ origin: normalizeOrigin(config.origin) })}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export const removeServerConfig = (dataDir: string): Promise<void> =>
  rm(join(dataDir, SERVER_CONFIG_FILE), { force: true });

/**
 * The binding identity of the current server.json: origin plus the file's
 * inode and birth time. writeServerConfig's tmp+rename and leave's
 * rm+recreate both produce a new file, so every join/leave — even back to the
 * same origin — yields a new binding, and account offers minted under an old
 * one can never revive (ADR-0022 §6).
 */
export async function readServerBinding(dataDir: string): Promise<string | undefined> {
  const path = join(dataDir, SERVER_CONFIG_FILE);
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  const config = await readServerConfig(dataDir);
  if (config === undefined) return undefined;
  return `${normalizeOrigin(config.origin)}@${file.ino}:${file.birthtimeMs}`;
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
