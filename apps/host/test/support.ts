import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  type FauxModelDefinition,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach } from "vitest";
import { openHost, type OpenedHost, type OpenHostOptions } from "../src/host.ts";
import { openAccounts, type Accounts } from "@pinomad/server/src/accounts.ts";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Home } from "@pinomad/protocol/organization.ts";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { secureWebSocketTransport } from "@pinomad/protocol/secure-channel.ts";
import type { DurableViewSource, ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "../src/agent-roles.ts";
import type { BuiltinExtension } from "../src/builtin-extension.ts";
import type { PushTimers } from "../src/push.ts";

/** Cleanups registered during a test, run in reverse after it. */
export function useCleanups(): (cleanup: () => Promise<void> | void) => void {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    const failures: unknown[] = [];
    // One failing cleanup must not strand the rest — the later ones remove temp dirs.
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
  });
  return (cleanup) => void cleanups.push(cleanup);
}

/** An in-process host on a temporary store whose faux model gives `answers` in order. */
export async function startFauxHost(
  defer: (cleanup: () => Promise<void> | void) => void,
  {
    answers = [LONG_ANSWER],
    tokensPerSecond = 200,
    dataDir,
    port = 0,
    browserOrigins,
    extensions,
    projects,
    webRoot,
    remote,
    relay,
    fauxModels,
    mcpConfig,
    modelAuth,
    autoTitle,
    openStorage,
    push,
    agentsHome,
  }: {
    /** Script of faux responses: plain strings become assistant text, messages and factories pass through. */
    answers?: readonly (string | FauxResponseStep)[];
    tokensPerSecond?: number;
    /** Reopen an earlier host's store. */
    dataDir?: string;
    /** Fixed, so clients reconnect to a restarted host. */
    port?: number;
    browserOrigins?: readonly string[];
    /**
     * Built-in extensions installed on the host. A function receives the host's
     * `models` and `modelSummaries`, for extensions configured from them.
     */
    extensions?:
      | Exclude<OpenHostOptions["extensions"], undefined>
      | ((provided: {
          models: Models;
          modelSummaries: () => readonly ModelSummary[];
          /** Resolves to the open harness — lazy because extensions out-preface it. */
          harness: () => Harness;
          /** The host's live named-agent store (`<dataDir>/agents`, ADR-0023). */
          agentRoles: AgentRoleStore;
        }) => readonly BuiltinExtension[]);
    /** Directories registered as projects at open. */
    projects?: readonly string[];
    /** The agent config home (`<agentsHome>/skills` is the user-skills entry); defaults to `<dataDir>/agents-home` so tests never read the real `~/.agents`. */
    agentsHome?: string;
    /** Built web client served on the gateway ports. */
    webRoot?: string;
    /** The 0.0.0.0 secure-channel listener; off by default. */
    remote?: OpenHostOptions["remote"];
    /** Dial a relay for inbound secure-channel devices; off by default. */
    relay?: OpenHostOptions["relay"];
    /** The faux provider's model list instead of the default lone `faux-1` — include it to keep it. */
    fauxModels?: readonly FauxModelDefinition[];
    /** MCP config file for the host's bridge (ADR-0012). */
    mcpConfig?: string;
    /** Live models/auth sources, e.g. `watchModelAuth` on a seeded auth.json. */
    modelAuth?: OpenHostOptions["modelAuth"];
    /**
     * Auto-title calls `completeSimple` on the same faux provider — it would
     * consume a queued `answers` step, so it stays off unless a test opts in.
     */
    autoTitle?: boolean;
    /** Wrap the real storage to inject failures (session-failure tests). */
    openStorage?: OpenHostOptions["openStorage"];
    /**
     * APNs push sender fakes (ADR-0025); absent → the sender stays off
     * (registrations still work), so tests never reach a real server.
     */
    push?: OpenHostOptions["push"];
  } = {},
): Promise<OpenedHost> {
  const dir = dataDir === undefined ? await tempDir() : { path: dataDir, remove: () => {} };
  defer(dir.remove);
  const faux = fauxProvider({
    tokensPerSecond,
    tokenSize: { min: 1, max: 1 },
    ...(fauxModels === undefined ? {} : { models: [...fauxModels] }),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(answers.map((answer) => (typeof answer === "string" ? fauxAssistantMessage(answer) : answer)));
  const model = faux.getModel();
  const modelSummaries = (): ModelSummary[] =>
    faux.models.map((each) => ({
      provider: each.provider,
      modelId: each.id,
      name: each.name,
      contextWindow: each.contextWindow,
      thinkingLevels: getSupportedThinkingLevels(each),
      images: each.input.includes("image"),
    }));
  const host = await openHost({
    dataDir: dir.path,
    // Inside the test dataDir by default — a test never lists the machine's real `~/.agents/skills`.
    agentsHome: agentsHome ?? join(dir.path, "agents-home"),
    models,
    modelSummaries,
    settingsFallback: {
      defaultModel: () => ({ provider: model.provider, modelId: model.id }),
      defaultThinkingLevel: () => null,
      steeringMode: () => "one-at-a-time",
      followUpMode: () => "one-at-a-time",
    },
    port,
    ...(browserOrigins === undefined ? {} : { browserOrigins }),
    ...(extensions === undefined
      ? {}
      : {
          extensions:
            typeof extensions === "function"
              ? (host: { harness: () => Harness; agentRoles: AgentRoleStore }) =>
                  extensions({ models, modelSummaries, harness: host.harness, agentRoles: host.agentRoles })
              : extensions,
        }),
    ...(projects === undefined ? {} : { projects }),
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(remote === undefined ? {} : { remote }),
    ...(relay === undefined ? {} : { relay }),
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    ...(modelAuth === undefined ? {} : { modelAuth }),
    autoTitle: autoTitle === true,
    ...(openStorage === undefined ? {} : { openStorage }),
    ...(push === undefined ? {} : { push }),
  });
  defer(() => host.close());
  return host;
}

/** Create a conversation at `home`, send `text` as its first prompt, and show it. */
export async function startConversation(client: RemoteDurable, home: Home, text: string): Promise<ConversationId> {
  await client.controller.createConversation(home, text);
  return client.view.current().conversation!.conversation.id;
}

/** The simplest conversation to drive: a Chat. */
export const startChat = (client: RemoteDurable, text: string): Promise<ConversationId> =>
  startConversation(client, { kind: "chat" }, text);

/** Switch to the first top-level conversation once the index holds one. */
export async function followFirst(client: RemoteDurable): Promise<ConversationId> {
  await waitForView(
    client.view,
    (view) =>
      view.organized.chats.length + view.organized.projects.flatMap((entry) => entry.conversations).length > 0,
  );
  const node =
    client.view.current().organized.chats[0] ?? client.view.current().organized.projects[0]!.conversations[0]!;
  await client.controller.switchConversation(node.summary.id);
  return node.summary.id;
}

export async function connectTo(
  defer: (cleanup: () => Promise<void> | void) => void,
  host: OpenedHost,
  token = host.token,
): Promise<RemoteDurable> {
  const client = await connectRemoteDurable({
    url: host.url,
    token,
    reconnectDelayMs: { min: 100, max: 500 },
  });
  defer(() => client.close());
  return client;
}

/**
 * Server accounts in `dataDir` with `hostId` bound to the bootstrap account —
 * a binding is the only way a host registers (ADR-0022). Idempotent, so a
 * restarted server reopens the same directory and finds the binding again.
 */
export async function openBoundAccounts(dataDir: string, hostId: string): Promise<Accounts> {
  const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: "correct horse battery" });
  if (!accounts.hasHost(hostId)) {
    // Registration never compares the stored Noise key; pairing would.
    const joined = accounts.joinHost({ token: accounts.createJoinToken(1).token, hostId, noisePublicKey: "A".repeat(43) });
    if (joined.status !== "joined") throw new Error(`binding ${hostId} failed: ${joined.reason}`);
  }
  return accounts;
}

/** Remove a test temp dir and the data-dir lock proper-lockfile puts beside it. */
export async function removeTempDir(path: string): Promise<void> {
  await Promise.all([
    rm(path, { recursive: true, force: true }),
    rm(`${path}.lock`, { recursive: true, force: true }),
  ]);
}

export async function tempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "pinomad-"));
  return { path, remove: () => removeTempDir(path) };
}

/**
 * Stop a spawned host and wait for its exit, so its close path releases the
 * data-dir lock. SIGKILL would leave `<dataDir>.lock` behind.
 */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

/** Resolve once `predicate` holds for the source's view, checked on every update. */
export function waitForView(
  source: DurableViewSource,
  predicate: (view: ReturnType<DurableViewSource["current"]>) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (!predicate(source.current())) return false;
      clearTimeout(timer);
      unsubscribe();
      resolve();
      return true;
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`view condition not met within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = source.subscribe(() => void check());
    check();
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** A reply long enough at the faux provider's pace to leave a window mid-stream. */
export const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `step-${i}`).join(" ");

/** Deterministic scheduler for the push sender's retries and title wait. */
export class ManualTimers implements PushTimers {
  #seq = 0;
  #now = 0;
  #queue: { id: number; at: number; fn: () => void }[] = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#queue.push({ id, at: this.#now + ms, fn });
    this.#queue.sort((a, b) => a.at - b.at);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#queue = this.#queue.filter((entry) => entry.id !== handle);
  };

  get pending(): number {
    return this.#queue.length;
  }

  /** Fire every timer due within `ms`, including ones they schedule. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const next = this.#queue.find((entry) => entry.at <= until);
      if (next === undefined) break;
      this.#queue.splice(this.#queue.indexOf(next), 1);
      this.#now = next.at;
      next.fn();
    }
    this.#now = until;
  }
}

/** Pair a fresh device over the remote listener; resolves to its client and key. */
export async function pairDevice(
  defer: (cleanup: () => Promise<void> | void) => void,
  host: OpenedHost,
  name: string,
): Promise<{ client: RemoteDurable; device: KeyPair }> {
  const tokenClient = await connectTo(defer, host);
  const { url } = await tokenClient.controller.createPairing();
  // The invite carries `pair=KEY.SECRET` plus params like `url=` when the host
  // rides a relay — parse the fragment, don't guess positions.
  const pair = new URLSearchParams(url.slice(url.indexOf("#") + 1)).get("pair")!;
  const secret = pair.split(".")[1]!;
  const device = generateKeyPair();
  const client = await connectRemoteDurable({
    transport: secureWebSocketTransport({
      url: host.remote!.url,
      hostKey: host.remote!.hostKey,
      device,
      pairing: { secret, name },
    }),
    reconnectDelayMs: { min: 100, max: 200 },
  });
  defer(() => client.close());
  return { client, device };
}
