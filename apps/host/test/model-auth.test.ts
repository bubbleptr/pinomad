import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { LoginFlow } from "@pinomad/protocol/auth.ts";
import { PROTOCOL, type ServerFrame } from "@pinomad/protocol/frames.ts";
import { openModelAuth, type ModelAuth } from "../src/model-auth.ts";
import { startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

const ANTHROPIC_KEY = { anthropic: { type: "api_key", key: "sk-ant-test" } };
const INSTALL_ID = "0b6f2b8e-6a0c-4a43-9d1b-3f0c8a4f7e21";

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(
  files: { auth?: Record<string, unknown>; models?: Record<string, unknown> } = {},
  options: { loginTimeoutMs?: number; finishedLoginTtlMs?: number } = {},
): Promise<{ dir: string; authPath: string; modelsPath: string; modelAuth: ModelAuth }> {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-model-auth-"));
  defer(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const modelsPath = join(dir, "models.json");
  if (files.auth !== undefined) await writeFile(authPath, JSON.stringify(files.auth));
  if (files.models !== undefined) await writeFile(modelsPath, JSON.stringify(files.models));
  // Offline: no catalog refresh over the network.
  const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
  const modelAuth = await openModelAuth(runtime, { modelsPath, installId: () => INSTALL_ID, ...options });
  defer(() => modelAuth.close());
  return { dir, authPath, modelsPath, modelAuth };
}

const flowOf = (modelAuth: ModelAuth, id: string): LoginFlow => modelAuth.providers.value.logins.find((flow) => flow.id === id)!;
const providerOf = (modelAuth: ModelAuth, id: string) => modelAuth.providers.value.providers.find((p) => p.id === id);

const OLLAMA = {
  id: "ollama-studio",
  name: "Ollama on studio",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  models: ["qwen3-coder:30b", "gpt-oss:20b"],
} as const;

describe("openModelAuth", () => {
  // pi also takes provider keys from the environment; a developer's exported
  // key would make providers look configured and hide what these tests
  // assert about the files.
  const AMBIENT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY"];
  beforeEach(() => {
    for (const name of AMBIENT) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists every built-in provider with its methods, the stored credential, and ambient auth", async () => {
    vi.stubEnv("GEMINI_API_KEY", "from-env");
    const { modelAuth } = await fixture({ auth: ANTHROPIC_KEY });
    expect(modelAuth.providers.value.providers.filter((p) => p.custom === undefined)).toHaveLength(42);
    expect(providerOf(modelAuth, "anthropic")).toMatchObject({
      name: "Anthropic",
      oauth: { subscription: true },
      apiKey: {},
      stored: { kind: "api_key", subscription: false },
    });
    expect(providerOf(modelAuth, "anthropic")!.ambient).toBeUndefined();
    // OAuth-only: no key login offered.
    expect(providerOf(modelAuth, "openai-codex")!.apiKey).toBeUndefined();
    // A sign-in that isn't a paid plan.
    expect(providerOf(modelAuth, "openrouter")!.oauth).toMatchObject({ subscription: false });
    expect(providerOf(modelAuth, "google")).toMatchObject({ ambient: "GEMINI_API_KEY" });
    expect(providerOf(modelAuth, "google")!.stored).toBeUndefined();
  });

  it("drives a key login through pi's prompt into auth.json and the streams", async () => {
    const { authPath, modelAuth } = await fixture();
    const loginId = modelAuth.beginLogin("anthropic", "api_key");
    await until(() => flowOf(modelAuth, loginId).prompt !== undefined);
    const prompt = flowOf(modelAuth, loginId).prompt!;
    expect(prompt.type).toBe("secret");

    // An answer for a prompt that has moved on is refused, never applied.
    expect(() => modelAuth.answerLogin(loginId, prompt.id + 1, "sk-wrong")).toThrow();
    modelAuth.answerLogin(loginId, prompt.id, "sk-ant-new");
    await until(() => flowOf(modelAuth, loginId).state !== "running");

    expect(flowOf(modelAuth, loginId)).toMatchObject({ state: "succeeded" });
    expect(flowOf(modelAuth, loginId).prompt).toBeUndefined();
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "sk-ant-new" } });
    expect(modelAuth.auth.value.logins.map((login) => login.providerId)).toEqual(["anthropic"]);
    expect(providerOf(modelAuth, "anthropic")!.stored).toEqual({ kind: "api_key", subscription: false });
    expect(modelAuth.models.value.some((model) => model.provider === "anthropic")).toBe(true);
  });

  it("refuses a method the provider lacks and a second login for the same provider", async () => {
    const { modelAuth } = await fixture();
    expect(() => modelAuth.beginLogin("openai-codex", "api_key")).toThrow();
    expect(() => modelAuth.beginLogin("no-such-provider", "api_key")).toThrow();
    const first = modelAuth.beginLogin("anthropic", "api_key");
    expect(() => modelAuth.beginLogin("anthropic", "api_key")).toThrow();
    modelAuth.cancelLogin(first);
  });

  it("cancels a waiting login without storing anything", async () => {
    const { modelAuth } = await fixture();
    const loginId = modelAuth.beginLogin("anthropic", "api_key");
    await until(() => flowOf(modelAuth, loginId).prompt !== undefined);
    modelAuth.cancelLogin(loginId);
    await until(() => flowOf(modelAuth, loginId).state !== "running");
    expect(flowOf(modelAuth, loginId)).toMatchObject({ state: "cancelled" });
    expect(flowOf(modelAuth, loginId).prompt).toBeUndefined();
    expect(modelAuth.auth.value.logins).toEqual([]);
    // Ended or unknown ids are a no-op.
    modelAuth.cancelLogin(loginId);
    modelAuth.cancelLogin("unknown");
  });

  it("gives up on a login nobody answers, then drops the ended flow", async () => {
    const { modelAuth } = await fixture({}, { loginTimeoutMs: 50, finishedLoginTtlMs: 50 });
    const loginId = modelAuth.beginLogin("anthropic", "api_key");
    await until(() => flowOf(modelAuth, loginId)?.state !== "running");
    expect(flowOf(modelAuth, loginId)).toMatchObject({ state: "failed" });
    await until(() => modelAuth.providers.value.logins.length === 0);
  });

  it("saves a custom endpoint into models.json with its key in auth.json, and removes both", async () => {
    // A hand-edited override of a built-in rides along untouched.
    const handEdited = { providers: { anthropic: { modelOverrides: { "claude-x": { name: "X" } } } } };
    const { authPath, modelsPath, modelAuth } = await fixture({ models: handEdited });

    await modelAuth.saveCustomProvider(OLLAMA, "sk-local");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    expect(models.providers.anthropic).toEqual(handEdited.providers.anthropic);
    expect(models.providers["ollama-studio"]).toMatchObject({
      name: "Ollama on studio",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "qwen3-coder:30b" }, { id: "gpt-oss:20b" }],
    });
    expect(JSON.stringify(models)).not.toContain("sk-local");
    expect(JSON.parse(await readFile(authPath, "utf8"))["ollama-studio"]).toEqual({ type: "api_key", key: "sk-local" });
    expect(providerOf(modelAuth, "ollama-studio")).toMatchObject({
      name: "Ollama on studio",
      custom: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: ["qwen3-coder:30b", "gpt-oss:20b"] },
      stored: { kind: "api_key" },
    });
    expect(modelAuth.models.value.filter((m) => m.provider === "ollama-studio").map((m) => m.modelId)).toEqual([
      "qwen3-coder:30b",
      "gpt-oss:20b",
    ]);

    // Absent key keeps the stored one; null removes it.
    await modelAuth.saveCustomProvider({ ...OLLAMA, models: ["gpt-oss:20b"] });
    expect(JSON.parse(await readFile(authPath, "utf8"))["ollama-studio"]).toBeDefined();
    await modelAuth.saveCustomProvider(OLLAMA, null);
    expect(JSON.parse(await readFile(authPath, "utf8"))["ollama-studio"]).toBeUndefined();

    await modelAuth.removeCustomProvider("ollama-studio");
    expect(JSON.parse(await readFile(modelsPath, "utf8")).providers["ollama-studio"]).toBeUndefined();
    expect(providerOf(modelAuth, "ollama-studio")).toBeUndefined();
    expect(modelAuth.models.value.some((m) => m.provider === "ollama-studio")).toBe(false);
  });

  it("refuses custom endpoints that clash with a built-in or are malformed", async () => {
    const { modelAuth } = await fixture();
    await expect(modelAuth.saveCustomProvider({ ...OLLAMA, id: "anthropic" })).rejects.toThrow();
    await expect(modelAuth.saveCustomProvider({ ...OLLAMA, id: "Bad Id" })).rejects.toThrow();
    await expect(modelAuth.saveCustomProvider({ ...OLLAMA, baseUrl: "studio:11434" })).rejects.toThrow();
    await expect(modelAuth.saveCustomProvider({ ...OLLAMA, models: [] })).rejects.toThrow();
    await expect(modelAuth.removeCustomProvider("anthropic")).rejects.toThrow();
  });

  it("asks an endpoint for its models, reusing a custom endpoint's stored key", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: "llama-4" }, { id: "qwen3" }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    defer(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const { modelAuth } = await fixture();

    expect(await modelAuth.listEndpointModels({ api: "openai-completions", baseUrl })).toEqual(["llama-4", "qwen3"]);
    expect(seen[0]!.authorization).toBeUndefined();

    await modelAuth.saveCustomProvider({ ...OLLAMA, baseUrl }, "sk-stored");
    await modelAuth.listEndpointModels({ api: "openai-completions", baseUrl, providerId: OLLAMA.id });
    expect(seen[1]!.authorization).toBe("Bearer sk-stored");
  });

  it("logout drops the credential from auth.json and republishes", async () => {
    const { authPath, modelAuth } = await fixture({ auth: ANTHROPIC_KEY });
    expect(modelAuth.auth.value.logins.map((login) => login.providerId)).toEqual(["anthropic"]);
    await modelAuth.logout("anthropic");
    expect(modelAuth.auth.value.logins).toEqual([]);
    expect(providerOf(modelAuth, "anthropic")!.stored).toBeUndefined();
    expect(modelAuth.models.value.some((model) => model.provider === "anthropic")).toBe(false);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({});
    await expect(modelAuth.logout("anthropic")).rejects.toThrow('No stored credential for provider "anthropic"');
  });

  it("serves static values and refuses provider calls when the gateway has no modelAuth", async () => {
    const host = await startFauxHost(defer);
    const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => socket.terminate());
    const frames: ServerFrame[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    await once(socket, "open");
    for (const stream of ["models", "auth", "providers"]) socket.send(JSON.stringify({ type: "subscribe", stream }));
    socket.send(JSON.stringify({ type: "call", id: 1, method: "logout", args: { providerId: "anthropic" } }));
    socket.send(JSON.stringify({ type: "call", id: 2, method: "beginLogin", args: { providerId: "anthropic", method: "oauth" } }));
    await until(() =>
      ["models", "auth", "providers"].every((stream) => frames.some((frame) => frame.type === "snapshot" && frame.stream === stream))
      && [1, 2].every((id) => frames.some((frame) => frame.type === "result" && frame.id === id)),
    );
    expect(frames.find((frame) => frame.type === "hello")).toMatchObject({ protocol: PROTOCOL });
    expect(frames.find((frame) => frame.type === "snapshot" && frame.stream === "auth")).toMatchObject({ value: { logins: [] } });
    expect(frames.find((frame) => frame.type === "snapshot" && frame.stream === "providers")).toMatchObject({
      value: { providers: [], logins: [] },
    });
    const models = frames.find((frame) => frame.type === "snapshot" && frame.stream === "models")!;
    expect((models as { value: readonly unknown[] }).value.length).toBeGreaterThan(0);
    expect(frames.find((frame) => frame.type === "result" && frame.id === 1)).toMatchObject({
      ok: false,
      error: "Logging out is not available on this host",
    });
    expect(frames.find((frame) => frame.type === "result" && frame.id === 2)).toMatchObject({ ok: false });
  });
});
