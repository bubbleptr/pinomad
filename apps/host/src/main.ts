#!/usr/bin/env node
// The headless host: owns the Harness, its SQLite store, and the lock; every UI
// is a gateway client. Run on Node, not Bun (node:sqlite, pi-durable's engines).
// Usage rows live in the pinomad.ts table — `pinomad host --help`.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ReadToolOptions } from "@earendil-works/pi-durable/tools";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "./agent-roles.ts";
import { DEFAULT_DATA_DIR } from "./cli/host-address.ts";
import { packagedVersion, webRoot } from "./distribution.ts";
import type { BuiltinExtension } from "./builtin-extension.ts";
import { question } from "./extensions/question.ts";
import { createCoding } from "./extensions/coding.ts";
import { createCodemode } from "./extensions/codemode.ts";
import { createContext } from "./extensions/context.ts";
import { createSubagent } from "./extensions/subagent.ts";
import { todo } from "./extensions/todo.ts";
import { validatePublicUrl, validateRelayOrigin } from "./gateway.ts";
import { type OpenHostOptions, openHost } from "./host.ts";
import { checkoutInfo } from "./organization.ts";
import { readServerConfig, resolveRelayOrigin } from "./server-config.ts";
import { startHostLogRotation } from "./service/log-rotation.ts";
import { openModelAuth } from "./model-auth.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { configureHarnessHttp, createHarnessSettings, defaultModel } from "./pi-setup.ts";
import type { Harness } from "@earendil-works/pi-durable";

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "data-dir": { type: "string" },
      port: { type: "string", default: "7420" },
      project: { type: "string", multiple: true },
      faux: { type: "string" },
      "faux-tps": { type: "string", default: "40" },
      "lock-stale-ms": { type: "string" },
      "browser-origin": { type: "string", multiple: true },
      "remote-port": { type: "string" },
      "public-url": { type: "string" },
      relay: { type: "string" },
    },
  });

  // Validate an explicit advertisement before anything persistent opens:
  // piOptions() creates the data dir for install-id, so a bad config must not
  // reach it.
  if (values["public-url"] !== undefined) validatePublicUrl(values["public-url"]);

  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  // The joined server's origin lives in server.json (pinomad join writes it);
  // an explicit --relay must agree with it or the host refuses to start.
  let relayOrigin: string | undefined;
  try {
    relayOrigin = resolveRelayOrigin(values.relay, await readServerConfig(dataDir));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  // The same early guard for a bad relay origin: the full target still waits
  // for the relay key in openHost / startGateway.
  if (relayOrigin !== undefined) validateRelayOrigin(relayOrigin);
  // One agentsHome for prompts and `listSkills` — the user-skills entry must
  // be the same dir both ways (ADR-0006, issue #143).
  const agentsHome = join(homedir(), ".agents");
  // Extensions are built per options source: `subagent` validates `model` against
  // the same Models and advertised summaries the gateway serves.
  const extensionsFor =
    (models: Models, summaries: () => readonly ModelSummary[], options?: ReadToolOptions) =>
    (host: {
      readonly harness: () => Harness;
      readonly agentRoles: AgentRoleStore;
    }): readonly BuiltinExtension[] => [
      createContext({
        agentsHome,
        checkout: (input, context) => checkoutInfo(host.harness(), input, context),
      }),
      createCoding(options),
      todo,
      question,
      createSubagent({
        models,
        modelSummaries: summaries,
        exclude: [question.extension],
        roles: () => host.agentRoles.value.roles,
      }),
      createCodemode(),
    ];
  const common = {
    dataDir,
    agentsHome,
    projects: values.project ?? [],
    port: Number(values.port),
    mcpConfig: join(agentsHome, "mcp.json"),
    browserOrigins: values["browser-origin"] ?? ["http://127.0.0.1:5199"],
    // Both gateway ports serve the built client; in service mode the loopback
    // port is the only web server around (ADR-0009 §7).
    webRoot,
    ...(values["lock-stale-ms"] === undefined ? {} : { lockStaleMs: Number(values["lock-stale-ms"]) }),
    ...(values["remote-port"] === undefined
      ? {}
      : {
          remote: {
            port: Number(values["remote-port"]),
            ...(values["public-url"] === undefined ? {} : { publicUrl: values["public-url"] }),
          },
        }),
    ...(relayOrigin === undefined ? {} : { relay: { origin: relayOrigin } }),
  };

  function fauxOptions(responses: () => FauxResponseStep): OpenHostOptions {
    const faux = fauxProvider({ tokensPerSecond: Number(values["faux-tps"]), tokenSize: { min: 1, max: 1 } });
    const models = createModels();
    models.setProvider(faux.provider);
    // Every request gets a fresh step, so a request rerun after a crash streams it again.
    faux.setResponses(Array.from({ length: 1000 }, responses));
    const model = faux.getModel();
    const summaries = () => [
      {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        thinkingLevels: getSupportedThinkingLevels(model),
        images: model.input.includes("image"),
      },
    ];
    return {
      ...common,
      models,
      modelSummaries: summaries,
      extensions: extensionsFor(models, summaries),
      // The scripted answers are the runs' — a title call must not eat them.
      autoTitle: false,
      settingsFallback: {
        defaultModel: () => ({ provider: model.provider, modelId: model.id }),
        defaultThinkingLevel: () => null,
        steeringMode: () => "one-at-a-time",
        followUpMode: () => "one-at-a-time",
      },
    };
  }

  async function piOptions(): Promise<OpenHostOptions> {
    // Only the data directory's files are read (ADR-0031): credentials,
    // custom endpoints and pi's model cache live beside settings.json, never
    // in ~/.pi/agent.
    const modelsPath = join(dataDir, "models.json");
    const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath });
    const modelAuth = await openModelAuth(modelRuntime, { modelsPath, installId: await installId(dataDir) });
    // pi's built-in defaults, with the harness keys (proxy, retry,
    // compaction, timeouts) a user put under "pi" in PiNomad's settings.json.
    const settingsManager = SettingsManager.inMemory(await piSettings(join(dataDir, "settings.json")));
    configureHarnessHttp(settingsManager);
    // One source for hello.models, extension model lists, and the `models` stream.
    const summaries = () => modelAuth.models.value;
    // Photon resizes oversized images `read` returns, off the event loop.
    const images = await createNodePhotonImages();
    return {
      ...common,
      models: modelRuntime,
      modelSummaries: summaries,
      modelAuth,
      images,
      extensions: extensionsFor(modelRuntime, summaries, { images }),
      settings: (store) => createHarnessSettings(settingsManager, store),
      // Push notifications go over the account control connection to the
      // server's APNs (ADR-0025); the faux path leaves the sender off —
      // scripted answers only exist for tests.
      push: {},
      // Unset keys fall back to pi's built-in defaults (ADR-0031).
      settingsFallback: {
        defaultModel: () => {
          const model = defaultModel(settingsManager, modelRuntime);
          return model === undefined ? null : { provider: model.provider, modelId: model.modelId };
        },
        defaultThinkingLevel: () => settingsManager.getDefaultThinkingLevel() ?? null,
        steeringMode: () => settingsManager.getSteeringMode(),
        followUpMode: () => settingsManager.getFollowUpMode(),
      },
    };
  }

  const options = values.faux !== undefined ? fauxOptions(() => () => fauxAssistantMessage(values.faux!)) : await piOptions();
  const host = await openHost(options);
  // Only the host that won the data-dir lock may rotate the shared log; a
  // second host has already exited above, so its timer never runs.
  // launchd appends both streams to <dataDir>/logs/host.log; Linux uses
  // journald and foreground runs never create that file, so this is a no-op.
  const stopLogRotation = startHostLogRotation(dataDir);
  const { defaultModel: effectiveModel } = host.settings.value;
  const model = effectiveModel === null ? null : `${effectiveModel.provider}/${effectiveModel.modelId}`;
  // Credentials stay in the local token file; generating a browser link is an explicit CLI action.
  // Source checkouts have the vite dev server on 5199; a packaged install
  // serves the bundled client on the host's own loopback port instead.
  const web =
    packagedVersion === undefined ? "http://127.0.0.1:5199/" : new URL(host.url.replace(/^ws/, "http")).href;
  console.log(
    JSON.stringify({
      event: "ready",
      url: host.url,
      tokenFile: join(dataDir, "token"),
      dataDir,
      model,
      web,
      ...(host.remote === undefined ? {} : { remote: host.remote.advertiseUrl }),
      ...(host.relay === undefined ? {} : { relay: { origin: host.relay.origin, hostId: host.relay.hostId } }),
    }),
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    stopLogRotation();
    void host.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A failed Storage call closes the session; exit nonzero so the service
  // manager restarts a working host instead of leaving a zombie (ADR-0009).
  void host.closed.then((end) => {
    if (end.reason !== "failed" || stopping) return;
    stopping = true;
    stopLogRotation();
    const error = end.error instanceof Error ? end.error.message : String(end.error);
    process.stderr.write(`${JSON.stringify({ event: "fatal", error })}\n`);
    void host.close().finally(() => process.exit(1));
  });
}

/** The `"pi"` object in PiNomad's settings.json: pi harness settings, hand-edited only. */
async function piSettings(path: string): Promise<Parameters<typeof SettingsManager.inMemory>[0]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let block: unknown;
  try {
    block = (JSON.parse(text) as { pi?: unknown }).pi;
  } catch {
    // A malformed file is openHostSettings' error to report; here it only means no overrides.
    return {};
  }
  return typeof block === "object" && block !== null && !Array.isArray(block) ? block : {};
}

/** This installation's stable UUID (ChatGPT sign-in names the host by it), created on first use. */
async function installId(dataDir: string): Promise<() => string> {
  const path = join(dataDir, "install-id");
  let id = (await readFile(path, "utf8").catch(() => "")).trim();
  if (id === "") {
    id = randomUUID();
    await mkdir(dataDir, { recursive: true });
    await writeFile(path, `${id}\n`, { mode: 0o600 });
  }
  return () => id;
}

if (import.meta.main) await main(process.argv.slice(2));
