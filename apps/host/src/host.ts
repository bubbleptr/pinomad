import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { addProject, type ConversationDefaults, ensureIndex } from "./organization.ts";
import { ensureDevices, loadHostKey, pairingOffers } from "./devices.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { BuiltinExtension } from "./builtin-extension.ts";
import { startGateway } from "./gateway.ts";

const context = BACKGROUND_CONTEXT;

export interface OpenHostOptions {
  /** Holds `session.sqlite`, the token, the lock, and Chat checkouts; one host process at a time. */
  readonly dataDir: string;
  readonly models: Models;
  readonly modelSummaries: () => readonly ModelSummary[];
  /** Built-in extensions installed before the Harness opens; their docs reach the gateway. */
  readonly extensions?: readonly BuiltinExtension[];
  readonly settings?: HarnessSettings;
  /** Defaults applied to every conversation created on this host. */
  readonly initialModel?: ModelRef & { readonly thinkingLevel?: ModelThinkingLevel };
  /** Directories registered as projects at open; a bad path fails startup. */
  readonly projects?: readonly string[];
  /** 0 picks a free port. A fixed port lets clients reconnect to a restarted host. */
  readonly port: number;
  /** Exact browser origins allowed to use the gateway; native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  /** How long a lock left by a killed host blocks the next one. proper-lockfile's minimum is 2000. */
  readonly lockStaleMs?: number;
  /**
   * Listen on all interfaces for secure-channel clients. Off by default: tunnels
   * forward to loopback, and remote access is the caller's explicit choice.
   */
  readonly remote?: {
    /** 0 picks a free port. */
    readonly port: number;
    /** Address advertised in pairing links; defaults to the detected LAN IP. */
    readonly publicUrl?: string;
    /** Built web client served over plain HTTP on the remote port. */
    readonly webRoot?: string;
    /** One-time pairing offer lifetime; default five minutes. */
    readonly pairingTtlMs?: number;
    /** How long a new socket may sit before handshake message 1; default 10 s. */
    readonly handshakeTimeoutMs?: number;
  };
}

export interface OpenedHost {
  readonly url: string;
  readonly token: string;
  readonly harness: Harness;
  /** Present when remote access is on. `hostKey` is the public half. */
  readonly remote?: { readonly url: string; readonly advertiseUrl: string; readonly hostKey: Uint8Array };
  close(): Promise<void>;
}

/** Persisted so a restarted host accepts the clients that were connected before it died. */
async function hostToken(dataDir: string): Promise<string> {
  const path = join(dataDir, "token");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(24).toString("base64url");
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

export async function openHost(options: OpenHostOptions): Promise<OpenedHost> {
  await mkdir(options.dataDir, { recursive: true });
  // Durable has no cross-process lock of its own; a second opener would corrupt the store.
  const stale = Math.max(2000, options.lockStaleMs ?? 10_000);
  const release = await lockfile
    .lock(options.dataDir, {
      realpath: false,
      stale,
      retries: { retries: Math.ceil(stale / 1000) + 2, minTimeout: 1000, maxTimeout: 1000 },
    })
    .catch((error: unknown) => {
      throw new Error(`Session is already open in another process: ${options.dataDir}`, { cause: error });
    });

  let harness: Harness | undefined;
  try {
    const token = await hostToken(options.dataDir);
    const reports: unknown[] = [];
    let report = (error: unknown): void => void reports.push(error);
    const registry = createRegistry();
    for (const { extension } of options.extensions ?? []) registry.install(extension);
    // One environment per working directory; conversations sharing a cwd share it.
    const environments = new Map<string, NodeExecutionEnv>();
    const chatsDir = join(options.dataDir, "chats");
    harness = await Harness.open(
      await openNodeSqliteStorage(join(options.dataDir, "session.sqlite")),
      {
        models: options.models,
        registry,
        env: async (target) => {
          const cwd = target.cwd;
          if (cwd === undefined) return undefined;
          // A crash between conversation creation and checkout creation leaves the
          // dir missing; the environment is the one place it is always needed.
          if (cwd.startsWith(`${chatsDir}/`)) await mkdir(cwd, { recursive: true });
          let env = environments.get(cwd);
          if (env === undefined) {
            env = new NodeExecutionEnv({ cwd });
            environments.set(cwd, env);
          }
          return env;
        },
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        onReport: (error) => report(error),
      },
      context,
    );
    const { initialModel } = options;
    await ensureIndex(harness, context);
    await ensureDevices(harness, context);
    for (const path of options.projects ?? []) await addProject(harness, path, context);
    // The host identity exists only while remote access is on.
    const hostKey = options.remote === undefined ? undefined : await loadHostKey(options.dataDir);
    const offers = options.remote === undefined ? undefined : pairingOffers(options.remote.pairingTtlMs);
    const defaults: ConversationDefaults =
      initialModel === undefined
        ? {}
        : {
            model: { provider: initialModel.provider, modelId: initialModel.modelId },
            ...(initialModel.thinkingLevel === undefined ? {} : { thinkingLevel: initialModel.thinkingLevel }),
          };
    const gateway = await startGateway({
      harness,
      models: options.models,
      modelSummaries: options.modelSummaries,
      session: { id: basename(options.dataDir), directory: options.dataDir },
      dataDir: options.dataDir,
      defaults,
      token,
      port: options.port,
      ...(options.browserOrigins === undefined ? {} : { browserOrigins: options.browserOrigins }),
      docs: (options.extensions ?? []).flatMap((extension) => extension.docs ?? []),
      ...(hostKey === undefined || offers === undefined || options.remote === undefined
        ? {}
        : {
            remote: {
              port: options.remote.port,
              hostKey,
              offers,
              ...(options.remote.publicUrl === undefined ? {} : { publicUrl: options.remote.publicUrl }),
              ...(options.remote.webRoot === undefined ? {} : { webRoot: options.remote.webRoot }),
              ...(options.remote.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.remote.handshakeTimeoutMs }),
            },
          }),
    });
    report = (error) => gateway.broadcast("warning", error instanceof Error ? error.message : String(error));
    for (const error of reports.splice(0)) report(error);
    // Recovered work from an interrupted turn continues now.
    harness.resume();

    const opened = harness;
    let closing: Promise<void> | undefined;
    return {
      url: gateway.url,
      token,
      harness,
      ...(gateway.remote === undefined || hostKey === undefined
        ? {}
        : { remote: { url: gateway.remote.url, advertiseUrl: gateway.remote.advertiseUrl, hostKey: hostKey.publicKey } }),
      close() {
        closing ??= (async () => {
          try {
            await gateway.close();
            // Close writes no outcome: a running turn resumes at the next open.
            await opened.close(context);
            await Promise.all([...environments.values()].map((env) => env.cleanup(context)));
          } finally {
            await release();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await harness?.close(context).catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}
