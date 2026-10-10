import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
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
import { addProject, type ConversationDefaults, ensureIndex, IndexDoc } from "./organization.ts";
import { checkoutAt, ensureWorktree, worktreeRoot } from "./checkout.ts";
import { ensureDevices, loadHostKey, loadRelayKey, pairingOffers } from "./devices.ts";
import type { RelayLinkState } from "./relay-link.ts";
import { type McpBridge, startMcp } from "./mcp.ts";
import type { ScriptTool } from "./script-tools.ts";
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
  /**
   * Built-in extensions installed before the Harness opens; their docs reach the gateway.
   * The function form is resolved once before MCP starts — `scriptTools()` stays
   * lazy so codemode sees servers that connect later (ADR-0013 §2).
   */
  readonly extensions?:
    | readonly BuiltinExtension[]
    | ((host: { readonly scriptTools: () => readonly ScriptTool[] }) => readonly BuiltinExtension[]);
  /** MCP config file (mcpServers format, ADR-0012); absent → no bridge and the `mcp` stream sends null. */
  readonly mcpConfig?: string;
  readonly settings?: HarnessSettings;
  /** Defaults applied to every conversation created on this host. */
  readonly initialModel?: ModelRef & { readonly thinkingLevel?: ModelThinkingLevel };
  /** Directories registered as projects at open; a bad path fails startup. */
  readonly projects?: readonly string[];
  /** 0 picks a free port. A fixed port lets clients reconnect to a restarted host. */
  readonly port: number;
  /** Exact browser origins allowed to use the gateway; native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  /** Built web client served over HTTP on the gateway ports (ADR-0009 §7). */
  readonly webRoot?: string;
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
    /** One-time pairing offer lifetime; default five minutes. */
    readonly pairingTtlMs?: number;
    /** How long a new socket may sit before handshake message 1; default 10 s. */
    readonly handshakeTimeoutMs?: number;
  };
  /**
   * Dial a self-hosted relay for secure-channel devices (ADR-0008 phase 2).
   * Independent of `remote` — the relay alone works from any network.
   */
  readonly relay?: {
    /** The relay's public origin, e.g. https://relay.example.com. */
    readonly origin: string;
    readonly reconnectDelayMs?: { readonly min: number; readonly max: number };
    readonly pingIntervalMs?: number;
  };
}

export interface OpenedHost {
  readonly url: string;
  readonly token: string;
  readonly harness: Harness;
  /** Present when remote access is on. `hostKey` is the public half. */
  readonly remote?: { readonly url: string; readonly advertiseUrl: string; readonly hostKey: Uint8Array };
  /** Present when a relay link is up. `hostId` is the relay-side identity. */
  readonly relay?: { readonly origin: string; readonly hostId: string; state(): RelayLinkState };
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
  let mcp: McpBridge | undefined;
  try {
    const token = await hostToken(options.dataDir);
    const reports: unknown[] = [];
    let report = (error: unknown): void => void reports.push(error);
    const registry = createRegistry();
    const extensions =
      typeof options.extensions === "function"
        ? options.extensions({ scriptTools: () => mcp?.scriptTools() ?? [] })
        : (options.extensions ?? []);
    for (const { extension } of extensions) registry.install(extension);
    // Connections run in the background; the `mcp` extension (re)installs as tools arrive.
    mcp = options.mcpConfig === undefined ? undefined : startMcp({ configPath: options.mcpConfig, registry });
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
          // The one place worktrees materialize (ADR-0010 §6): first use, a crash
          // between commit and creation, a manual rm -rf, and reuse after unarchive
          // all funnel here. A missing record means the path was never registered.
          const worktrees = worktreeRoot(options.dataDir);
          if (cwd === worktrees || cwd.startsWith(worktrees + sep)) {
            const index = await target.read.snapshot(IndexDoc, context);
            const record = checkoutAt(index?.checkouts, cwd);
            if (record !== undefined) {
              await ensureWorktree(record);
              // The record's subdir is part of the checkout, but a defensive
              // mkdir keeps a vanished one from failing the environment.
              await mkdir(cwd, { recursive: true });
            }
          }
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
    // The host identity exists on every start (ADR-0020 §3): the loopback
    // listener's /secure path also speaks the Noise channel, so a same-machine
    // paired device never needs the token. The key file is created on first run.
    const hostKey = await loadHostKey(options.dataDir);
    const offers = pairingOffers(options.remote?.pairingTtlMs);
    const relayKey = options.relay === undefined ? undefined : await loadRelayKey(options.dataDir);
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
      docs: extensions.flatMap((extension) => extension.docs ?? []),
      toolPresentations: Object.assign({}, ...extensions.map((extension) => extension.tools ?? {})),
      ...(mcp === undefined ? {} : { mcp: mcp.status }),
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
      secure: {
        hostKey,
        offers,
        ...(options.remote?.handshakeTimeoutMs === undefined
          ? {}
          : { handshakeTimeoutMs: options.remote.handshakeTimeoutMs }),
        ...(options.remote === undefined
          ? {}
          : {
              lan: {
                port: options.remote.port,
                ...(options.remote.publicUrl === undefined ? {} : { publicUrl: options.remote.publicUrl }),
              },
            }),
        ...(options.relay === undefined || relayKey === undefined
          ? {}
          : {
              relay: {
                origin: options.relay.origin,
                signingKey: relayKey,
                ...(options.relay.reconnectDelayMs === undefined
                  ? {}
                  : { reconnectDelayMs: options.relay.reconnectDelayMs }),
                ...(options.relay.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.relay.pingIntervalMs }),
              },
            }),
      },
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
      ...(gateway.relay === undefined
        ? {}
        : { relay: { origin: gateway.relay.origin, hostId: gateway.relay.hostId, state: () => gateway.relay!.state() } }),
      close() {
        closing ??= (async () => {
          try {
            await gateway.close();
            // Close writes no outcome: a running turn resumes at the next open.
            await opened.close(context);
            // MCP servers go down with the host (stdio children get the spec shutdown).
            await mcp?.close();
            await Promise.all([...environments.values()].map((env) => env.cleanup(context)));
          } finally {
            await release();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await mcp?.close().catch(() => {});
    await harness?.close(context).catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}
