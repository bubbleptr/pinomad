#!/usr/bin/env node
// The headless host: owns the Harness, its SQLite store, and the lock; every UI
// is a gateway client. Run on Node, not Bun (node:sqlite, pi-durable's engines).
//
//   node apps/host/src/main.ts [--data-dir DIR] [--port 7420] [--project DIR]...
//   node apps/host/src/main.ts --faux "scripted answer" [--faux-tps 40]   # no real model, for tests
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DATA_DIR } from "./cli/host-address.ts";
import { approval } from "./extensions/approval.ts";
import { coding } from "./extensions/coding.ts";
import { createContext } from "./extensions/context.ts";
import { todo } from "./extensions/todo.ts";
import { type OpenHostOptions, openHost } from "./host.ts";
import { configureHarnessHttp, createHarnessSettings, defaultModel, modelSummaries } from "./pi-setup.ts";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "7420" },
    project: { type: "string", multiple: true },
    faux: { type: "string" },
    "faux-tps": { type: "string", default: "40" },
    "lock-stale-ms": { type: "string" },
    "browser-origin": { type: "string", multiple: true },
  },
});

const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
const common = {
  dataDir,
  projects: values.project ?? [],
  port: Number(values.port),
  extensions: [createContext({ agentsHome: join(homedir(), ".agents") }), coding, todo, approval],
  browserOrigins: values["browser-origin"] ?? ["http://127.0.0.1:5199"],
  ...(values["lock-stale-ms"] === undefined ? {} : { lockStaleMs: Number(values["lock-stale-ms"]) }),
};

function fauxOptions(responses: () => FauxResponseStep): OpenHostOptions {
  const faux = fauxProvider({ tokensPerSecond: Number(values["faux-tps"]), tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  // Every request gets a fresh step, so a request rerun after a crash streams it again.
  faux.setResponses(Array.from({ length: 1000 }, responses));
  const model = faux.getModel();
  const summary = { provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow };
  return {
    ...common,
    models,
    modelSummaries: () => [summary],
    initialModel: { provider: model.provider, modelId: model.id },
  };
}

async function piOptions(): Promise<OpenHostOptions> {
  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(process.cwd());
  configureHarnessHttp(settingsManager);
  const initialModel = defaultModel(settingsManager, modelRuntime);
  return {
    ...common,
    models: modelRuntime,
    modelSummaries: () => modelSummaries(modelRuntime),
    settings: createHarnessSettings(settingsManager),
    ...(initialModel === undefined ? {} : { initialModel }),
  };
}

const options = values.faux !== undefined ? fauxOptions(() => () => fauxAssistantMessage(values.faux!)) : await piOptions();
const host = await openHost(options);
const model = options.initialModel === undefined ? null : `${options.initialModel.provider}/${options.initialModel.modelId}`;
// Credentials stay in the local token file; generating a browser link is an explicit CLI action.
const web = "http://127.0.0.1:5199/";
console.log(JSON.stringify({ event: "ready", url: host.url, tokenFile: join(dataDir, "token"), dataDir, model, web }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
