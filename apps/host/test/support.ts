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
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Home } from "@pinomad/protocol/organization.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableViewSource, ModelSummary } from "@pinomad/protocol/view.ts";
import type { BuiltinExtension } from "../src/builtin-extension.ts";
import type { ScriptTool } from "../src/script-tools.ts";

/** Cleanups registered during a test, run in reverse after it. */
export function useCleanups(): (cleanup: () => Promise<void> | void) => void {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    fauxModels,
    mcpConfig,
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
     * `models` and `modelSummaries`, for extensions configured from them, plus
     * the lazy script-tool catalog codemode reads (ADR-0013).
     */
    extensions?:
      | Exclude<OpenHostOptions["extensions"], undefined>
      | ((provided: {
          models: Models;
          modelSummaries: () => readonly ModelSummary[];
          scriptTools: () => readonly ScriptTool[];
        }) => readonly BuiltinExtension[]);
    /** Directories registered as projects at open. */
    projects?: readonly string[];
    /** Built web client served on the gateway ports. */
    webRoot?: string;
    /** The 0.0.0.0 secure-channel listener; off by default. */
    remote?: OpenHostOptions["remote"];
    /** The faux provider's model list instead of the default lone `faux-1` — include it to keep it. */
    fauxModels?: readonly FauxModelDefinition[];
    /** MCP config file for the host's bridge (ADR-0012). */
    mcpConfig?: string;
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
    }));
  const host = await openHost({
    dataDir: dir.path,
    models,
    modelSummaries,
    initialModel: { provider: model.provider, modelId: model.id },
    port,
    ...(browserOrigins === undefined ? {} : { browserOrigins }),
    ...(extensions === undefined
      ? {}
      : {
          extensions:
            typeof extensions === "function"
              ? (host: { scriptTools: () => readonly ScriptTool[] }) =>
                  extensions({ models, modelSummaries, scriptTools: host.scriptTools })
              : extensions,
        }),
    ...(projects === undefined ? {} : { projects }),
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(remote === undefined ? {} : { remote }),
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
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

export async function tempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "pinomad-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
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
