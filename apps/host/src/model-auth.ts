// The `models`, `auth` and `providers` host streams plus the provider calls,
// backed by the host's own credential and model files (ADR-0031): pi's
// ModelRuntime pointed at `<dataDir>/auth.json` and `<dataDir>/models.json`.
// PiNomad is the only writer, so every value is republished after the call
// that changed it; nothing watches the files.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  CustomProvider,
  CustomProviderApi,
  CustomProviderInput,
  HostAuth,
  HostProviders,
  LoginEvent,
  LoginFlow,
  LoginMethod,
  LoginPrompt,
  ProviderInfo,
  StoredLogin,
} from "@pinomad/protocol/auth.ts";
import { isCustomProviderApi } from "@pinomad/protocol/auth.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { Published, sameList, type HostValue } from "./host-value.ts";
import { modelSummaries } from "./pi-setup.ts";

/** Live sources behind the `models`/`auth`/`providers` streams and the provider calls. */
export interface ModelAuth {
  readonly models: HostValue<readonly ModelSummary[]>;
  readonly auth: HostValue<HostAuth>;
  readonly providers: HostValue<HostProviders>;
  logout(providerId: string): Promise<void>;
  /** Starts a login and returns its id; the flow's prompts and outcome land in `providers.logins`. */
  beginLogin(providerId: string, method: LoginMethod): string;
  answerLogin(loginId: string, promptId: number, value: string): void;
  cancelLogin(loginId: string): void;
  saveCustomProvider(input: CustomProviderInput, apiKey?: string | null): Promise<void>;
  removeCustomProvider(providerId: string): Promise<void>;
  listEndpointModels(input: {
    api: CustomProviderApi;
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
  }): Promise<readonly string[]>;
  close(): void;
}

const BUILTIN = new Set<string>(getBuiltinProviders());
const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A login nobody finishes — the phone that started it went away — must not hold pi's callback port forever. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** An ended flow stays listed this long so its outcome reaches the device that started it. */
const FINISHED_LOGIN_TTL_MS = 60_000;
const ENDPOINT_TIMEOUT_MS = 10_000;

const sameModel = (a: ModelSummary, b: ModelSummary): boolean =>
  a.provider === b.provider
  && a.modelId === b.modelId
  && a.name === b.name
  && a.contextWindow === b.contextWindow
  && a.images === b.images
  && sameList(a.thinkingLevels, b.thinkingLevels, (x, y) => x === y);

const sameLogin = (a: StoredLogin, b: StoredLogin): boolean =>
  a.providerId === b.providerId && a.name === b.name && a.kind === b.kind && a.subscription === b.subscription;

type ModelsFile = { providers: Record<string, Record<string, unknown>>; [key: string]: unknown };

async function readModelsFile(path: string): Promise<ModelsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<ModelsFile>;
  return { ...parsed, providers: parsed.providers ?? {} };
}

/** The custom endpoints `models.json` defines — full provider entries whose id is not a built-in. */
function customProviders(file: ModelsFile): Map<string, CustomProvider & { readonly name: string }> {
  const custom = new Map<string, CustomProvider & { readonly name: string }>();
  for (const [id, entry] of Object.entries(file.providers)) {
    if (BUILTIN.has(id) || !isCustomProviderApi(entry.api) || typeof entry.baseUrl !== "string") continue;
    const models = Array.isArray(entry.models)
      ? entry.models.flatMap((model) => (typeof model?.id === "string" ? [model.id as string] : []))
      : [];
    custom.set(id, {
      name: typeof entry.name === "string" ? entry.name : id,
      api: entry.api,
      baseUrl: entry.baseUrl,
      models,
    });
  }
  return custom;
}

const toLoginEvent = (event: AuthEvent): LoginEvent => {
  switch (event.type) {
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds === undefined ? {} : { expiresAt: Date.now() + event.expiresInSeconds * 1000 }),
      };
    case "info":
      return { type: "info", message: event.message, ...(event.links === undefined ? {} : { links: event.links }) };
    case "auth_url":
      return { type: "auth_url", url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) };
    case "progress":
      return { type: "progress", message: event.message };
  }
};

const toLoginPrompt = (id: number, prompt: AuthPrompt): LoginPrompt => {
  const placeholder = "placeholder" in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {};
  if (prompt.type === "select") {
    return {
      id,
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }
  return { id, type: prompt.type, message: prompt.message, ...placeholder };
};

/** A running login: the published flow plus the pi interaction behind it. */
interface Login {
  flow: LoginFlow;
  readonly controller: AbortController;
  pending?: { readonly id: number; resolve(value: string): void; reject(error: Error): void };
  nextPromptId: number;
  timer?: NodeJS.Timeout;
}

export async function openModelAuth(
  runtime: ModelRuntime,
  options: {
    /** The `models.json` the runtime was created with; custom endpoints are written here. */
    modelsPath: string;
    /** A stable UUID for this installation — ChatGPT sign-in identifies the host by it. */
    installId: () => string;
    loginTimeoutMs?: number;
    finishedLoginTtlMs?: number;
  },
): Promise<ModelAuth> {
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const finishedLoginTtlMs = options.finishedLoginTtlMs ?? FINISHED_LOGIN_TTL_MS;
  let custom = customProviders(await readModelsFile(options.modelsPath));
  const logins = new Map<string, Login>();
  const dropTimers = new Set<NodeJS.Timeout>();
  let closed = false;

  const storedLogins = async (): Promise<HostAuth> => {
    const credentials = await runtime.listCredentials();
    const list: StoredLogin[] = credentials.map((credential) => ({
      providerId: credential.providerId,
      name: runtime.getProvider(credential.providerId)?.name ?? credential.providerId,
      kind: credential.type,
      subscription: runtime.isUsingSubscription(credential.providerId),
    }));
    list.sort((a, b) => a.providerId.localeCompare(b.providerId));
    return { logins: list };
  };

  const catalog = (stored: HostAuth): ProviderInfo[] => {
    const byId = new Map(stored.logins.map((login) => [login.providerId, login]));
    const infos = runtime.getProviders().map((provider): ProviderInfo => {
      const login = byId.get(provider.id);
      const status = runtime.getProviderAuthStatus(provider.id);
      const oauth = provider.auth.oauth;
      // Ambient-only key auth (no `login`) can't be set up from a client.
      const apiKey = provider.auth.apiKey?.login === undefined ? undefined : provider.auth.apiKey;
      const endpoint = custom.get(provider.id);
      return {
        id: provider.id,
        name: endpoint?.name ?? provider.name,
        ...(oauth === undefined
          ? {}
          : {
              oauth: {
                name: oauth.name,
                subscription: oauth.isSubscription === true,
                ...(oauth.loginLabel === undefined ? {} : { loginLabel: oauth.loginLabel }),
              },
            }),
        ...(apiKey === undefined ? {} : { apiKey: { name: apiKey.name } }),
        ...(login === undefined ? {} : { stored: { kind: login.kind, subscription: login.subscription } }),
        ...(login === undefined && status.configured && status.source === "environment" && status.label !== undefined
          ? { ambient: status.label }
          : {}),
        ...(endpoint === undefined ? {} : { custom: { api: endpoint.api, baseUrl: endpoint.baseUrl, models: endpoint.models } }),
      };
    });
    // Built-ins by name, then the user's endpoints by name.
    return infos.sort(
      (a, b) => Number(a.custom !== undefined) - Number(b.custom !== undefined) || a.name.localeCompare(b.name),
    );
  };

  const flows = (): LoginFlow[] => [...logins.values()].map((login) => login.flow);
  const initialAuth = await storedLogins();
  const models = new Published(modelSummaries(runtime), (a, b) => sameList(a, b, sameModel));
  const auth = new Published(initialAuth, (a, b) => sameList(a.logins, b.logins, sameLogin));
  // Flows change on every prompt and event; the value is small and pushed whole.
  const providers = new Published<HostProviders>({ providers: catalog(initialAuth), logins: [] }, () => false);

  const publishFlows = (): void => {
    if (!closed) providers.set({ providers: providers.value.providers, logins: flows() });
  };

  /** After any credential or models.json change: the runtime's snapshot is current, the streams follow it. */
  const republish = async (): Promise<void> => {
    const stored = await storedLogins();
    models.set(modelSummaries(runtime));
    auth.set(stored);
    if (!closed) providers.set({ providers: catalog(stored), logins: flows() });
  };

  const end = (login: Login, state: LoginFlow["state"], error?: string): void => {
    if (login.flow.state !== "running") return;
    clearTimeout(login.timer);
    login.pending?.reject(new Error("Login ended"));
    login.pending = undefined;
    const { prompt: _, ...rest } = login.flow;
    login.flow = { ...rest, state, ...(error === undefined ? {} : { error }) };
    const drop = setTimeout(() => {
      dropTimers.delete(drop);
      logins.delete(login.flow.id);
      publishFlows();
    }, finishedLoginTtlMs);
    dropTimers.add(drop);
    publishFlows();
  };

  /** Write models.json from its latest contents; hand-edited entries and keys ride along. */
  const updateModelsFile = async (change: (file: ModelsFile) => void): Promise<void> => {
    const file = await readModelsFile(options.modelsPath);
    change(file);
    const tmp = `${options.modelsPath}.tmp`;
    await mkdir(dirname(options.modelsPath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, options.modelsPath);
    custom = customProviders(file);
  };

  /** Store a key through the provider's own api-key login, answering its prompt. */
  const storeKey = async (providerId: string, key: string): Promise<void> => {
    await runtime.login(providerId, "api_key", {
      prompt: async () => key,
      notify: () => {},
    });
  };

  // Serialized: two saves racing would each write models.json from a stale read.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => {});
    return next;
  };

  return {
    models,
    auth,
    providers,

    async logout(providerId) {
      if (!auth.value.logins.some((login) => login.providerId === providerId)) {
        throw new Error(`No stored credential for provider "${providerId}"`);
      }
      await runtime.logout(providerId);
      // logout() already synchronized the runtime snapshot.
      await republish();
    },

    beginLogin(providerId, method) {
      const provider = runtime.getProvider(providerId);
      if (provider === undefined) throw new Error(`Unknown provider "${providerId}"`);
      const offered = method === "oauth" ? provider.auth.oauth !== undefined : provider.auth.apiKey?.login !== undefined;
      if (!offered) throw new Error(`${provider.name} has no ${method === "oauth" ? "sign-in" : "API key"} login`);
      if ([...logins.values()].some((login) => login.flow.providerId === providerId && login.flow.state === "running")) {
        throw new Error(`A login for ${provider.name} is already in progress`);
      }
      const id = randomUUID();
      const login: Login = {
        flow: { id, providerId, method, events: [], state: "running" },
        controller: new AbortController(),
        nextPromptId: 1,
      };
      logins.set(id, login);
      login.timer = setTimeout(() => {
        login.controller.abort();
        end(login, "failed", "The login timed out");
      }, loginTimeoutMs);

      void runtime
        .login(
          providerId,
          method,
          {
            signal: login.controller.signal,
            notify(event) {
              if (login.flow.state !== "running") return;
              login.flow = { ...login.flow, events: [...login.flow.events, toLoginEvent(event)] };
              publishFlows();
            },
            prompt(prompt) {
              return new Promise<string>((resolve, reject) => {
                if (login.flow.state !== "running") {
                  reject(new Error("Login ended"));
                  return;
                }
                const promptId = login.nextPromptId++;
                login.pending = { id: promptId, resolve, reject };
                login.flow = { ...login.flow, prompt: toLoginPrompt(promptId, prompt) };
                publishFlows();
                // pi withdraws a prompt when something else settles the step,
                // e.g. the browser callback beating a pasted code.
                prompt.signal?.addEventListener(
                  "abort",
                  () => {
                    if (login.pending?.id !== promptId) return;
                    login.pending = undefined;
                    const { prompt: _, ...rest } = login.flow;
                    login.flow = rest;
                    reject(new Error("Prompt withdrawn"));
                    publishFlows();
                  },
                  { once: true },
                );
              });
            },
          },
          { agentName: "PiNomad", getDeviceId: options.installId },
        )
        .then(
          async () => {
            await republish();
            end(login, "succeeded");
          },
          (error: unknown) => {
            if (login.controller.signal.aborted) return;
            end(login, "failed", error instanceof Error ? error.message : String(error));
          },
        );
      publishFlows();
      return id;
    },

    answerLogin(loginId, promptId, value) {
      const login = logins.get(loginId);
      if (login === undefined || login.flow.state !== "running") throw new Error("This login has ended");
      const pending = login.pending;
      if (pending === undefined || pending.id !== promptId) throw new Error("This prompt has moved on");
      login.pending = undefined;
      const { prompt: _, ...rest } = login.flow;
      login.flow = rest;
      publishFlows();
      pending.resolve(value);
    },

    cancelLogin(loginId) {
      const login = logins.get(loginId);
      if (login === undefined || login.flow.state !== "running") return;
      login.controller.abort();
      end(login, "cancelled");
    },

    saveCustomProvider: (input, apiKey) =>
      serial(async () => {
        if (!CUSTOM_ID.test(input.id)) throw new Error("Use lowercase letters, digits and - for the endpoint id");
        if (BUILTIN.has(input.id)) throw new Error(`"${input.id}" is a built-in provider; pick another id`);
        const name = input.name.trim();
        if (name === "") throw new Error("Name the endpoint");
        let url: URL;
        try {
          url = new URL(input.baseUrl);
        } catch {
          throw new Error("Enter a full base URL, like http://localhost:11434/v1");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http:// or https:// base URL");
        const ids = [...new Set(input.models.map((model) => model.trim()).filter((model) => model !== ""))];
        if (ids.length === 0) throw new Error("Add at least one model");
        const key =
          typeof apiKey === "string" && apiKey !== ""
            ? apiKey
            : apiKey !== null && custom.has(input.id)
              ? (await runtime.getAuth(input.id))?.auth.apiKey
              : undefined;
        // An endpoint whose /models can't be read still saves; its models get pi's defaults.
        const reported = new Map(
          (await fetchEndpointModels(input.api, input.baseUrl, key).catch(() => [])).map((model) => [model.id, model]),
        );

        await updateModelsFile((file) => {
          const previous = file.providers[input.id] ?? {};
          const previousModels = new Map(
            (Array.isArray(previous.models) ? (previous.models as Record<string, unknown>[]) : []).map((model) => [model.id, model]),
          );
          file.providers[input.id] = {
            ...previous,
            name,
            api: input.api,
            baseUrl: input.baseUrl,
            // A field the user tuned by hand beats what the endpoint reports.
            models: ids.map((id) => ({ ...reported.get(id), ...(previousModels.get(id) ?? { id }) })),
          };
        });
        await runtime.refresh({ providers: [input.id], allowNetwork: false });
        if (typeof apiKey === "string" && apiKey !== "") await storeKey(input.id, apiKey);
        else if (apiKey === null && (await runtime.listCredentials()).some((c) => c.providerId === input.id)) {
          await runtime.logout(input.id);
        }
        await republish();
      }),

    removeCustomProvider: (providerId) =>
      serial(async () => {
        if (!custom.has(providerId)) throw new Error(`No custom endpoint "${providerId}"`);
        if ((await runtime.listCredentials()).some((c) => c.providerId === providerId)) await runtime.logout(providerId);
        await updateModelsFile((file) => {
          delete file.providers[providerId];
        });
        await runtime.refresh({ providers: [providerId], allowNetwork: false });
        await republish();
      }),

    async listEndpointModels(input) {
      let key = input.apiKey;
      if (key === undefined && input.providerId !== undefined && custom.has(input.providerId)) {
        key = (await runtime.getAuth(input.providerId))?.auth.apiKey;
      }
      return (await fetchEndpointModels(input.api, input.baseUrl, key)).map((model) => model.id);
    },

    close() {
      closed = true;
      for (const login of logins.values()) {
        clearTimeout(login.timer);
        if (login.flow.state === "running") login.controller.abort();
      }
      for (const timer of dropTimers) clearTimeout(timer);
    },
  };
}

/**
 * The endpoint's model list in its own dialect: `GET {baseUrl}/models`,
 * except Anthropic, whose base URL is the root its SDK adds `/v1/…` to.
 */
async function fetchEndpointModels(
  api: CustomProviderApi,
  baseUrl: string,
  key: string | undefined,
): Promise<EndpointModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(api === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (key !== undefined) headers["x-api-key"] = key;
  } else if (api === "google-generative-ai") {
    if (key !== undefined) url.searchParams.set("key", key);
  } else if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  }
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    throw new Error(`Couldn't reach ${url.host} from the host: ${reason}`);
  }
  if (!response.ok) throw new Error(`${url.host} answered ${response.status} for /models`);
  const body = (await response.json()) as { data?: Listed[]; models?: Listed[] };
  const models =
    api === "google-generative-ai"
      ? (body.models ?? []).flatMap((model) =>
          typeof model.name === "string"
            ? [
                endpointModel(model.name.replace(/^models\//, ""), {
                  contextWindow: positive(model.inputTokenLimit),
                  maxTokens: positive(model.outputTokenLimit),
                  reasoning: model.thinking === true,
                  image: false,
                }),
              ]
            : [],
        )
      : (body.data ?? []).flatMap((model) =>
          typeof model.id === "string"
            ? [
                endpointModel(model.id, {
                  contextWindow:
                    positive(model.context_window) ?? positive(model.context_length) ?? positive(model.max_input_tokens),
                  maxTokens: positive(model.max_output_tokens),
                  reasoning: model.reasoning === true,
                  image: Array.isArray(model.modalities?.input) && model.modalities.input.includes("image"),
                }),
              ]
            : [],
        );
  if (models.length === 0) throw new Error(`${url.host} listed no models`);
  return models;
}

/** One entry of a /models answer; fields beyond the id are each gateway's own. */
type Listed = Record<string, unknown> & { readonly modalities?: { readonly input?: unknown } };

/** A `models.json` model entry: the id, plus what the endpoint reported where pi would otherwise default. */
type EndpointModel = { readonly id: string } & Record<string, unknown>;

/** pi rejects a non-positive `contextWindow` or `maxTokens`, and a rejected entry fails the whole save. */
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** pi's defaults for a bare id are a 128k window, 16k output, no reasoning and text only. */
function endpointModel(
  id: string,
  reported: { contextWindow?: number; maxTokens?: number; reasoning: boolean; image: boolean },
): EndpointModel {
  return {
    id,
    ...(reported.contextWindow === undefined ? {} : { contextWindow: reported.contextWindow }),
    ...(reported.maxTokens === undefined ? {} : { maxTokens: reported.maxTokens }),
    ...(reported.reasoning ? { reasoning: true } : {}),
    ...(reported.image ? { input: ["text", "image"] } : {}),
  };
}
