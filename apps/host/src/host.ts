import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type HarnessSettings, type SessionEnd, type Storage } from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { addProject, ensureIndex, IndexDoc } from "./organization.ts";
import { checkoutAt, ensureWorktree, worktreeRoot } from "./checkout.ts";
import { ensureDevices, loadHostKey, loadRelayKey, pairingOffers } from "./devices.ts";
import type { RelayLinkState } from "./relay-link.ts";
import { type McpBridge, startMcp } from "./mcp.ts";
import type { ModelAuth } from "./model-auth.ts";
import { type AgentRoleStore, openAgentRoles } from "./agent-roles.ts";
import { type HostSettingsStore, openHostSettings, type SettingsFallback } from "./host-settings.ts";
import { constantValue } from "./host-value.ts";
import type { PushTimers, PushTransport } from "./push.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { readServerBinding } from "./server-config.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { BuiltinExtension } from "./builtin-extension.ts";
import { startGateway } from "./gateway.ts";
import { AttachmentStore } from "./attachments.ts";

const context = BACKGROUND_CONTEXT;

export interface OpenHostOptions {
  /** Holds `session.sqlite`, the token, the lock, and Chat checkouts; one host process at a time. */
  readonly dataDir: string;
  /** The agent config home (ADR-0006): `<agentsHome>/skills` is the user-skills entry — the context extension and `listSkills` read the same dir. */
  readonly agentsHome: string;
  readonly models: Models;
  readonly modelSummaries: () => readonly ModelSummary[];
  /** Shared with read-tool resizing; absent makes derived image requests return original. */
  readonly images?: ImageProcessor;
  /**
   * Built-in extensions installed before the Harness opens; their docs reach the gateway.
   * The function form is resolved once before MCP starts, and `harness()`
   * resolves only when an extension's wiring runs after open (prompt renderers).
   */
  readonly extensions?:
    | readonly BuiltinExtension[]
    | ((host: {
        readonly harness: () => Harness;
        /** Named-agent files under `<dataDir>/agents` (ADR-0023); open before this runs so extensions can render it. */
        readonly agentRoles: AgentRoleStore;
      }) => readonly BuiltinExtension[]);
  /** MCP config file (mcpServers format, ADR-0012); absent → no bridge and the `mcp` stream sends null. */
  readonly mcpConfig?: string;
  /** Live `models`/`auth`/`providers` sources and the provider calls (ADR-0031); absent → the streams serve static snapshots and the calls fail. */
  readonly modelAuth?: ModelAuth;
  /**
   * Harness settings (pi-derived); the function form receives the settings
   * store so queue-mode getters read the live effective value (ADR-0021).
   */
  readonly settings?: HarnessSettings | ((settings: HostSettingsStore) => HarnessSettings);
  /** Where each host setting goes when settings.json does not set it (ADR-0021 §2). */
  readonly settingsFallback: SettingsFallback;
  /** Directories registered as projects at open; a bad path fails startup. */
  readonly projects?: readonly string[];
  /** 0 picks a free port. A fixed port lets clients reconnect to a restarted host. */
  readonly port: number;
  /** Exact browser origins allowed to use the gateway; native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  /** Built web client served over HTTP on the gateway ports (ADR-0009 §7). */
  readonly webRoot?: string;
  /**
   * Name conversations after their first successful run; default on. Faux
   * test hosts turn it off so the scripted answers go only to agent runs.
   */
  readonly autoTitle?: boolean;
  /**
   * APNs push sender (ADR-0025): absent → `setPushToken` registers but nothing
   * is sent (faux test hosts). `{}` sends through the relay link when the
   * host is joined; tests inject `transport`/`timers` fakes.
   */
  readonly push?: { readonly transport?: PushTransport; readonly timers?: PushTimers };
  /** How long a lock left by a killed host blocks the next one. proper-lockfile's minimum is 2000. */
  readonly lockStaleMs?: number;
  /** Test seam: the session.sqlite opener; defaults to the node-sqlite storage. */
  readonly openStorage?: (path: string) => Promise<Storage>;
  /**
   * Listen on all interfaces for secure-channel clients. Off by default: tunnels
   * forward to loopback, and remote access is the caller's explicit choice.
   */
  readonly remote?: {
    /** 0 picks a free port. */
    readonly port: number;
    /** Advertised direct address; unset re-probes the LAN for every invite and hello. */
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
  /** Settles when the Harness session ends — `failed` means a Storage error closed it. */
  readonly closed: Promise<SessionEnd>;
  /** Present when remote access is on. `hostKey` is the public half. */
  readonly remote?: { readonly url: string; readonly advertiseUrl: string; readonly hostKey: Uint8Array };
  /** Present when a relay link is up. `hostId` is the relay-side identity. */
  readonly relay?: { readonly origin: string; readonly hostId: string; state(): RelayLinkState };
  /** The effective host settings backing the `settings` stream and `updateSettings`. */
  readonly settings: HostSettingsStore;
  /**
   * Mint a one-time pairing offer bound to the joined server — the server's
   * entry point for vouching a new device (ADR-0022 §4). Undefined while the
   * host is not joined.
   */
  createAccountOffer(): Promise<{ secret: string; expiresAt: number } | undefined>;
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
  let agentRoles: AgentRoleStore | undefined;
  let attachments: AttachmentStore | undefined;
  let extensions: readonly BuiltinExtension[] = [];
  try {
    const token = await hostToken(options.dataDir);
    attachments = new AttachmentStore({ dir: join(options.dataDir, "attachments") });
    await attachments.open();
    const reports: unknown[] = [];
    let report = (error: unknown): void => void reports.push(error);
    const registry = createRegistry();
    // Opened before `extensions` resolves: the callback sees the live store,
    // and `subagent` renders its section per request off it.
    agentRoles = await openAgentRoles({ dir: join(options.dataDir, "agents") });
    extensions =
      typeof options.extensions === "function"
        ? options.extensions({
            harness: () => {
              // Resolves after openHost assigns it — render-time wiring only.
              if (harness === undefined) throw new Error("harness is not open yet");
              return harness;
            },
            agentRoles,
          })
        : (options.extensions ?? []);
    for (const { extension } of extensions) registry.install(extension);
    // Connections run in the background; the `mcp` extension (re)installs as tools arrive.
    // Namespace changes rebuild the extensions that opt in (codemode's section).
    mcp =
      options.mcpConfig === undefined
        ? undefined
        : startMcp({
            configPath: options.mcpConfig,
            registry,
            onNamespaces: (namespaces) => {
              for (const each of extensions) {
                const rebuilt = each.namespaced?.(namespaces);
                if (rebuilt !== undefined) registry.install(rebuilt);
              }
            },
          });
    // Opened before the harness: `settings` may be a function reading its value.
    const hostSettings = await openHostSettings({
      path: join(options.dataDir, "settings.json"),
      fallback: options.settingsFallback,
      // Login/logout moves models in and out of the runnable list; the store
      // re-evaluates a file-set default and the fallback against it (ADR-0021).
      models: options.modelAuth?.models ?? constantValue(options.modelSummaries()),
    });
    // One environment per working directory; conversations sharing a cwd share it.
    const environments = new Map<string, NodeExecutionEnv>();
    const chatsDir = join(options.dataDir, "chats");
    harness = await Harness.open(
      await (options.openStorage ?? openNodeSqliteStorage)(join(options.dataDir, "session.sqlite")),
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
        ...(options.settings === undefined
          ? {}
          : {
              settings:
                typeof options.settings === "function" ? options.settings(hostSettings) : options.settings,
            }),
        onReport: (error) => report(error),
      },
      context,
    );
    await ensureIndex(harness, context);
    await ensureDevices(harness, context);
    for (const path of options.projects ?? []) await addProject(harness, path, context);
    // The host identity exists on every start (ADR-0020 §3): the loopback
    // listener's /secure path also speaks the Noise channel, so a same-machine
    // paired device never needs the token. The key file is created on first run.
    const hostKey = await loadHostKey(options.dataDir);
    const offers = pairingOffers(options.remote?.pairingTtlMs);
    const relayKey = options.relay === undefined ? undefined : await loadRelayKey(options.dataDir);
    const gateway = await startGateway({
      harness,
      models: options.models,
      modelSummaries: options.modelSummaries,
      ...(options.images === undefined ? {} : { images: options.images }),
      session: { id: basename(options.dataDir), directory: options.dataDir },
      dataDir: options.dataDir,
      attachments,
      agentsHome: options.agentsHome,
      settings: hostSettings,
      token,
      port: options.port,
      agents: agentRoles,
      ...(options.browserOrigins === undefined ? {} : { browserOrigins: options.browserOrigins }),
      docs: extensions.flatMap((extension) => extension.docs ?? []),
      toolPresentations: Object.assign({}, ...extensions.map((extension) => extension.tools ?? {})),
      ...(mcp === undefined ? {} : { mcp: mcp.status }),
      ...(options.modelAuth === undefined ? {} : { modelAuth: options.modelAuth }),
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
      ...(options.autoTitle === undefined ? {} : { autoTitle: options.autoTitle }),
      ...(options.push === undefined
        ? {}
        : {
            push: {
              hostKey: toBase64Url(hostKey.publicKey),
              ...(options.push.transport === undefined ? {} : { transport: options.push.transport }),
              ...(options.push.timers === undefined ? {} : { timers: options.push.timers }),
            },
          }),
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
      closed: opened.closed,
      settings: hostSettings,
      // The binding is read at mint time; admission re-reads it again (a
      // join/leave between the two must not let the old binding through).
      // A server.json without `binding` — written before the field existed —
      // mints nothing; a fresh join stamps one.
      createAccountOffer: async () => {
        const binding = await readServerBinding(options.dataDir).catch(() => undefined);
        return binding === undefined ? undefined : offers.createAccount(binding);
      },
      ...(gateway.remote === undefined || hostKey === undefined
        ? {}
        : {
            remote: {
              url: gateway.remote.url,
              // The gateway re-probes the LAN on each read; keep the getter so
              // callers never hold a startup address as "current".
              get advertiseUrl(): string {
                return gateway.remote!.advertiseUrl;
              },
              hostKey: hostKey.publicKey,
            },
          }),
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
            attachments?.close();
            agentRoles?.close();
            // Process-wide extension resources (the codemode sandbox pool).
            for (const each of extensions) await each.close?.();
            options.modelAuth?.close();
            await Promise.all([...environments.values()].map((env) => env.cleanup(context)));
          } finally {
            await release();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    options.modelAuth?.close();
    attachments?.close();
    agentRoles?.close();
    for (const each of extensions) await each.close?.().catch(() => {});
    await mcp?.close().catch(() => {});
    await harness?.close(context).catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}
