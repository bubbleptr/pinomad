#!/usr/bin/env node
// The headless host: owns the Harness, its SQLite store, and the lock; every UI
// is a gateway client. Run on Node, not Bun (node:sqlite, pi-durable's engines).
//
//   pinomad host [--data-dir DIR] [--port 7420] [--project DIR]...
//   pinomad host --remote-port 7422 [--public-url URL]      # remote access, LAN (ADR-0008)
//   pinomad host --relay https://relay.example.com          # remote access via relay (ADR-0015)
//   pinomad host --faux "scripted answer" [--faux-tps 40]   # no real model, for tests
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "./agent-roles.ts";
import { DEFAULT_DATA_DIR } from "./cli/host-address.ts";
import { packagedVersion, webRoot } from "./distribution.ts";
import type { BuiltinExtension } from "./builtin-extension.ts";
import { question } from "./extensions/question.ts";
import { coding } from "./extensions/coding.ts";
import { createCodemode } from "./extensions/codemode.ts";
import { createContext } from "./extensions/context.ts";
import { createSubagent } from "./extensions/subagent.ts";
import { todo } from "./extensions/todo.ts";
import { type OpenHostOptions, openHost } from "./host.ts";
import { checkoutInfo } from "./organization.ts";
import { watchModelAuth } from "./model-auth.ts";
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

  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  // Extensions are built per options source: `subagent` validates `model` against
  // the same Models and advertised summaries the gateway serves.
  const extensionsFor =
    (models: Models, summaries: () => readonly ModelSummary[]) =>
    (host: {
      readonly harness: () => Harness;
      readonly agentRoles: AgentRoleStore;
    }): readonly BuiltinExtension[] => [
      createContext({
        agentsHome: join(homedir(), ".agents"),
        checkout: (input, context) => checkoutInfo(host.harness(), input, context),
      }),
      coding,
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
    projects: values.project ?? [],
    port: Number(values.port),
    mcpConfig: join(homedir(), ".agents", "mcp.json"),
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
    ...(values.relay === undefined ? {} : { relay: { origin: values.relay } }),
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
    const modelRuntime = await ModelRuntime.create();
    // Watches pi's auth.json — a Pi CLI login/logout republishes `models`/`auth`
    // to every connected device (ADR-0021 §5-6).
    const modelAuth = await watchModelAuth(modelRuntime, { authPath: join(getAgentDir(), "auth.json") });
    const settingsManager = SettingsManager.create(process.cwd());
    configureHarnessHttp(settingsManager);
    // One source for hello.models, extension model lists, and the `models` stream.
    const summaries = () => modelAuth.models.value;
    return {
      ...common,
      models: modelRuntime,
      modelSummaries: summaries,
      modelAuth,
      extensions: extensionsFor(modelRuntime, summaries),
      settings: (store) => createHarnessSettings(settingsManager, store),
      // Unset keys fall back to pi's settings (ADR-0021 §2).
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
    void host.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A failed Storage call closes the session; exit nonzero so the service
  // manager restarts a working host instead of leaving a zombie (ADR-0009).
  void host.closed.then((end) => {
    if (end.reason !== "failed" || stopping) return;
    stopping = true;
    const error = end.error instanceof Error ? end.error.message : String(end.error);
    process.stderr.write(`${JSON.stringify({ event: "fatal", error })}\n`);
    void host.close().finally(() => process.exit(1));
  });
}

if (import.meta.main) await main(process.argv.slice(2));
