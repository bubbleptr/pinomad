// Fake host state for widget stories: one host with two projects and a chat,
// a remote whose controller answers with plausible data, and decorators that
// install the account, paired-host and desktop-bridge contexts App provides.
// Story-only: nothing in the app imports this.
import type { Decorator } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import { fn } from "storybook/test";
import type { ConversationId, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { AccountDevice, AccountHost, AccountHostMatch, AccountInvite, HostLinkRequest } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import type { HostProviders, LoginFlow, LoginMethod, ProviderInfo } from "@pinomad/protocol/auth.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { organize, type ConversationNode, type HostIndex, type Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable, RemoteTerminals, TerminalOutputSink, TerminalsState } from "@pinomad/protocol/remote-durable.ts";
import type { TerminalInfo, TerminalList } from "@pinomad/protocol/terminals.ts";
import type { ConversationSummary, DurableController, DurableView, ModelSummary } from "@pinomad/protocol/view.ts";
import { AccountContext } from "../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../entities/account/account-model.ts";
import type { UpdateStatus } from "../entities/app-update/update-protocol.ts";
import type { DesktopBridge } from "../entities/host/desktop-bridge.ts";
import type {
  LocalHostResult,
  LocalHostSetupResult,
  LocalHostState,
  LocalHostStopResult,
} from "../entities/local-host/local-host-protocol.ts";
import { HostsContext, type HostsState } from "../entities/host/host-store.ts";

const MINUTE = 60_000;
const now = Date.now();
const id = (value: number) => value as ConversationId;

// --- Organization ----------------------------------------------------------

export const PINOMAD: Project = { path: "/Users/kieran/code/pinomad", name: "pinomad", addedAt: now - 30 * 24 * 60 * MINUTE };
export const WEBSITE: Project = { path: "/Users/kieran/code/website", name: "website", addedAt: now - 7 * 24 * 60 * MINUTE };

/** The conversation most stories show: a project conversation with a fork and a running subagent. */
export const PARSER_ID = id(1);
export const FORK_ID = id(4);
export const SUBAGENT_ID = id(5);
export const BACKGROUND_SUBAGENT_ID = id(8);
export const FORK_BACKGROUND_SUBAGENT_ID = id(9);
/** Two more forks used by the sidebar's legacy and multi-fork stories. */
export const SECOND_FORK_ID = id(10);
export const NESTED_FORK_ID = id(11);
/** A conversation of another family, with no forks or subagents. */
export const DARK_MODE_ID = id(2);

const summaries: ConversationSummary[] = [
  { id: PARSER_ID, kind: "conversation", title: "Fix the parser's trailing-comma bug", updatedAt: now - 3 * MINUTE },
  { id: DARK_MODE_ID, kind: "conversation", title: "Add a dark mode toggle", status: "running", updatedAt: now - MINUTE, activity: { tool: "edit", target: "src/theme.ts" } },
  { id: id(3), kind: "conversation", title: "Explain Rust's borrow checker", status: "needs-answer", updatedAt: now - 40 * MINUTE },
  { id: FORK_ID, kind: "fork", parent: PARSER_ID, forkedAt: "4", title: "Try a recursive-descent rewrite", updatedAt: now - 10 * MINUTE },
  {
    id: SUBAGENT_ID,
    kind: "subagent",
    parent: PARSER_ID,
    title: "Write regression tests for parseList",
    label: "Write regression tests",
    role: "tester",
    status: "running",
    updatedAt: now - MINUTE,
    activity: { tool: "bash", target: "bun test" },
  },
  { id: id(6), kind: "conversation", title: "Draft the 0.9 release notes", status: "failed", updatedAt: now - 2 * 60 * MINUTE },
  { id: id(7), kind: "conversation", title: "Compare SQLite WAL modes", updatedAt: now - 9 * 24 * 60 * MINUTE },
];

const index: HostIndex = {
  projects: [PINOMAD, WEBSITE],
  conversations: [
    { id: PARSER_ID, home: { kind: "project", path: PINOMAD.path }, createdAt: now - 60 * MINUTE },
    { id: DARK_MODE_ID, home: { kind: "project", path: WEBSITE.path }, createdAt: now - 20 * MINUTE },
    { id: id(3), home: { kind: "chat" }, createdAt: now - 50 * MINUTE },
    { id: id(6), home: { kind: "project", path: PINOMAD.path }, createdAt: now - 3 * 60 * MINUTE },
    { id: id(7), home: { kind: "chat" }, createdAt: now - 10 * 24 * 60 * MINUTE, archived: true },
  ],
};

export const organized = organize(index, summaries);
export const summaryOf = (target: ConversationId) => summaries.find((summary) => summary.id === target);

/**
 * Add a second root-level fork and a legacy fork-of-a-fork. Depth-first
 * `threadsOf` order puts the nested fork directly after its parent, then the
 * second root fork.
 */
export function withForks(view: DurableView): DurableView {
  const secondFork: ConversationNode = {
    summary: {
      id: SECOND_FORK_ID,
      kind: "fork",
      parent: PARSER_ID,
      forkedAt: "5",
      title: "Compare a table-driven parser",
      status: "running",
      updatedAt: now - 20 * MINUTE,
    },
    children: [],
  };
  const nestedFork: ConversationNode = {
    summary: {
      id: NESTED_FORK_ID,
      kind: "fork",
      parent: FORK_ID,
      forkedAt: "6",
      title: "Revisit the frame cost",
      updatedAt: now - 30 * MINUTE,
    },
    children: [],
  };
  const attach = (node: ConversationNode): ConversationNode => {
    const children = node.children.map(attach);
    if (node.summary.id === PARSER_ID) return { ...node, children: [...children, secondFork] };
    if (node.summary.id === FORK_ID) return { ...node, children: [...children, nestedFork] };
    return { ...node, children };
  };
  return {
    ...view,
    organized: {
      ...view.organized,
      chats: view.organized.chats.map(attach),
      projects: view.organized.projects.map((project) => ({ ...project, conversations: project.conversations.map(attach) })),
      archived: view.organized.archived.map((entry) => ({ ...entry, node: attach(entry.node) })),
    },
  };
}

/** Add background work at both the root and its fork without changing real parents. */
export function withBackgroundSubagents(
  view: DurableView,
  options: { longTitles?: boolean; includeForkChild?: boolean } = {},
): DurableView {
  const { longTitles = false, includeForkChild = true } = options;
  const rootBackground: ConversationNode = {
    summary: {
      id: BACKGROUND_SUBAGENT_ID,
      kind: "subagent",
      parent: PARSER_ID,
      lifecycle: "background",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      title: longTitles ? "Trace the owning task and child conversation through every reconnect attempt" : "Inspect socket owner",
      status: "running",
      updatedAt: now - MINUTE,
      activity: { tool: "read", target: "apps/host/src/gateway.ts" },
    },
    children: [],
  };
  const forkBackground: ConversationNode = {
    summary: {
      id: FORK_BACKGROUND_SUBAGENT_ID,
      kind: "subagent",
      parent: FORK_ID,
      lifecycle: "background",
      model: { provider: "openai", modelId: "gpt-5.2" },
      title: longTitles ? "Verify the final retry behavior on a real device" : "Verify retry on device",
      ...(longTitles ? { status: "failed" as const } : {}),
      updatedAt: now - 2 * MINUTE,
    },
    children: [],
  };
  const attach = (node: ConversationNode): ConversationNode => {
    const children = node.children.map(attach);
    if (node.summary.id === PARSER_ID) return { ...node, children: [...children, rootBackground] };
    if (includeForkChild && node.summary.id === FORK_ID) return { ...node, children: [...children, forkBackground] };
    return { ...node, children };
  };
  return {
    ...view,
    organized: {
      ...view.organized,
      chats: view.organized.chats.map(attach),
      projects: view.organized.projects.map((project) => ({ ...project, conversations: project.conversations.map(attach) })),
      archived: view.organized.archived.map((entry) => ({ ...entry, node: attach(entry.node) })),
    },
  };
}

// --- Conversation entries (shapes as packages/client/test/cot-view-cases.ts) ---

let nextEntryId = 1;
const entry = (kind: string, message: unknown, conversationId: ConversationId): EntryRecord =>
  ({ id: nextEntryId++, conversationId, kind, model: [message] }) as unknown as EntryRecord;
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const call = (callId: string, name: string, args: unknown) => ({ type: "toolCall", id: callId, name, arguments: args });
const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: input * 3e-6, output: output * 15e-6, cacheRead: 0, cacheWrite: 0, total: input * 3e-6 + output * 15e-6 },
});

function transcript(conversationId: ConversationId) {
  const user = (content: string) => entry("pi.user", { role: "user", content, timestamp: now }, conversationId);
  const assistant = (content: unknown[], stopReason = "stop", extra: object = {}) =>
    entry("pi.assistant", { role: "assistant", content, stopReason, timestamp: now, ...extra }, conversationId);
  const result = (callId: string, name: string, output: string) =>
    entry(
      "pi.tool-result",
      { role: "toolResult", toolCallId: callId, toolName: name, content: [text(output)], isError: false, timestamp: now },
      conversationId,
    );
  return { user, assistant, result };
}

const PATCH = [
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -10,4 +10,5 @@ export function parseList(tokens: Token[]) {",
  "   while (peek(tokens)) {",
  "-    items.push(parseItem(tokens));",
  "+    if (peek(tokens)?.kind === \"comma\") next(tokens);",
  "+    else items.push(parseItem(tokens));",
  "   }",
  "   return items;",
].join("\n");

function settledEntries(conversationId: ConversationId): EntryRecord[] {
  const { user, assistant, result } = transcript(conversationId);
  return [
    user("$review trailing commas still break `parseList` — find out why"),
    assistant(
      [thinking("The trailing comma case is probably in parseList."), call("c1", "bash", { command: "ls src" }), call("c2", "read", { path: "src/parser.ts" })],
      "toolUse",
    ),
    result("c1", "bash", "lexer.ts\nparser.ts\ntokens.ts"),
    result("c2", "read", "export function parseList(tokens: Token[]) { … }"),
    assistant(
      [text("Found it: a trailing comma is parsed as an empty item."), call("c3", "edit", { path: "src/parser.ts" }), call("c4", "bash", { command: "bun test" })],
      "toolUse",
    ),
    result("c3", "edit", "Applied 1 edit"),
    result("c4", "bash", "42 pass, 0 fail"),
    assistant([text("Fixed. `parseList` now skips a trailing comma instead of parsing it as an empty item, and `bun test` passes.")], "stop", {
      usage: usage(48_200, 1_900),
    }),
  ];
}

const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };

const agentDoc = { model: MODEL, thinkingLevel: "high", cwd: PINOMAD.path };
const usageDoc = {
  models: { "anthropic/claude-opus-5-5": usage(96_400, 3_800) },
  tools: {},
};

/** The shown conversation, settled: a run with thinking, tools, an edit and a final answer. */
export function settledConversation(conversationId: ConversationId = PARSER_ID): ConversationView {
  return {
    conversation: { id: conversationId, kind: "conversation" },
    entries: settledEntries(conversationId),
    docs: { "pi.agent": agentDoc, "pi.usage": usageDoc, "pi.live": {}, "pi.inbox": { items: [] } },
  } as unknown as ConversationView;
}

/** The same conversation mid-run on a follow-up, with a steer and a follow-up queued behind it. */
export function busyConversation(conversationId: ConversationId = PARSER_ID): ConversationView {
  const { user, assistant } = transcript(conversationId);
  return {
    conversation: { id: conversationId, kind: "conversation" },
    entries: [
      ...settledEntries(conversationId),
      user("Now add a regression test for it"),
      assistant([call("c5", "bash", { command: "bun test parser" })], "toolUse"),
    ],
    docs: {
      "pi.agent": agentDoc,
      "pi.usage": usageDoc,
      "pi.live": { run: { taskId: 9, inputs: [] }, tools: [{ callId: "c5", name: "bash", status: "running" }] },
      "pi.inbox": {
        items: [
          { id: 11, mode: "steer", content: "Use the existing fixtures in test/fixtures" },
          { id: 12, mode: "followUp", content: [text("Then update the changelog")] },
        ],
      },
    },
  } as unknown as ConversationView;
}

/** A fork's own entries after the inherited prefix. */
export function forkConversation(): ConversationView {
  const { user, assistant } = transcript(FORK_ID);
  return {
    conversation: { id: FORK_ID, kind: "fork", parent: PARSER_ID },
    entries: [
      user("Try rewriting parseList as recursive descent instead"),
      assistant([text("A recursive-descent `parseList` reads cleaner but costs a frame per element; I'd keep the loop.")]),
    ],
    docs: { "pi.agent": agentDoc, "pi.live": {}, "pi.inbox": { items: [] } },
  } as unknown as ConversationView;
}

/** The running subagent's transcript: its task, one finished tool and one in flight. */
export function subagentConversation(conversationId: ConversationId = SUBAGENT_ID, parent: ConversationId = PARSER_ID): ConversationView {
  const { user, assistant, result } = transcript(conversationId);
  return {
    conversation: { id: conversationId, kind: "subagent", parent },
    entries: [
      user("Write regression tests for parseList: a trailing comma, two commas, and an empty list."),
      assistant([call("s1", "read", { path: "test/parser.test.ts" })], "toolUse"),
      result("s1", "read", "describe(\"parseList\", () => { … })"),
      assistant([text("Adding three cases next to the existing ones."), call("s2", "bash", { command: "bun test parser" })], "toolUse"),
    ],
    docs: {
      "pi.agent": { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "medium", cwd: PINOMAD.path },
      "pi.live": { run: { taskId: 12, inputs: [] }, tools: [{ callId: "s2", name: "bash", status: "running" }] },
      "pi.inbox": { items: [] },
    },
  } as unknown as ConversationView;
}

// --- Host view ---------------------------------------------------------------

export const MODELS: readonly ModelSummary[] = [
  { ...MODEL, name: "Claude Opus 5.5", contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "max"], images: true },
  { provider: "anthropic", modelId: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high"], images: true },
  { provider: "openai", modelId: "gpt-5", name: "GPT-5", contextWindow: 400_000, thinkingLevels: ["off", "minimal", "low", "medium", "high"], images: true },
];

const key = (fill: string) => fill.repeat(43);

// --- Providers -------------------------------------------------------------------

const keyed = (id: string, name: string): ProviderInfo => ({ id, name, apiKey: { name: `${name} API key` } });

/**
 * pi-ai 1.2.0's catalog as the 5.21 `providers` stream sends it: built-ins by
 * name, then custom endpoints. Connected: Anthropic by subscription, OpenAI
 * and Cloudflare AI Gateway by key, Google only through the host's
 * environment, plus two custom endpoints.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "amazon-bedrock", name: "Amazon Bedrock", apiKey: { name: "AWS credentials or bearer token" } },
  keyed("ant-ling", "Ant Ling"),
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true },
    apiKey: { name: "Anthropic API key" },
    stored: { kind: "oauth", subscription: true },
  },
  keyed("azure", "Azure"),
  keyed("baseten", "Baseten"),
  keyed("cerebras", "Cerebras"),
  { ...keyed("cloudflare-ai-gateway", "Cloudflare AI Gateway"), stored: { kind: "api_key", subscription: false } },
  keyed("cloudflare-workers-ai", "Cloudflare Workers AI"),
  keyed("deepseek", "DeepSeek"),
  keyed("fireworks", "Fireworks"),
  { id: "github-copilot", name: "GitHub Copilot", oauth: { name: "GitHub Copilot", subscription: true }, apiKey: { name: "GitHub Copilot" } },
  { ...keyed("google", "Google"), ambient: "GEMINI_API_KEY" },
  { id: "google-vertex", name: "Google Vertex AI", apiKey: { name: "Google Cloud credentials" } },
  keyed("groq", "Groq"),
  keyed("huggingface", "Hugging Face"),
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    oauth: { name: "Kimi Code (subscription)", subscription: true, loginLabel: "Sign in with Kimi Code" },
    apiKey: { name: "Kimi For Coding API key" },
  },
  {
    id: "meta",
    name: "Meta",
    oauth: { name: "Meta (Muse subscription)", subscription: true, loginLabel: "Sign in with Meta" },
    apiKey: { name: "Meta API key" },
  },
  keyed("minimax", "MiniMax"),
  keyed("minimax-cn", "MiniMax CN"),
  keyed("mistral", "Mistral"),
  keyed("moonshotai", "Moonshot AI"),
  keyed("moonshotai-cn", "Moonshot AI CN"),
  keyed("nvidia", "NVIDIA"),
  {
    id: "openai",
    name: "OpenAI",
    oauth: { name: "OpenAI (ChatGPT subscription)", subscription: true, loginLabel: "Sign in with ChatGPT" },
    apiKey: { name: "OpenAI API key" },
    stored: { kind: "api_key", subscription: false },
  },
  { id: "openai-codex", name: "OpenAI Codex (legacy)", oauth: { name: "OpenAI (ChatGPT Plus/Pro)", subscription: true } },
  keyed("opencode-go", "OpenCode Go"),
  keyed("opencode", "OpenCode Zen"),
  {
    id: "openrouter",
    name: "OpenRouter",
    oauth: { name: "OpenRouter OAuth", subscription: false, loginLabel: "Sign in with OpenRouter" },
    apiKey: { name: "OpenRouter API key" },
  },
  keyed("qwen-token-plan", "Qwen Token Plan"),
  keyed("qwen-token-plan-cn", "Qwen Token Plan CN"),
  keyed("qwen-token-plan-individual", "Qwen Token Plan Individual"),
  { id: "radius", name: "Radius", oauth: { name: "Radius", subscription: false }, apiKey: { name: "Radius API key" } },
  keyed("together", "Together"),
  keyed("typesafe", "TypeSafe"),
  keyed("vercel-ai-gateway", "Vercel AI Gateway"),
  {
    id: "xai",
    name: "xAI",
    oauth: { name: "xAI (Grok/X subscription)", subscription: true, loginLabel: "Sign in with SuperGrok or X Premium" },
    apiKey: { name: "xAI API key" },
  },
  keyed("xiaomi", "Xiaomi"),
  keyed("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS"),
  keyed("xiaomi-token-plan-cn", "Xiaomi Token Plan CN"),
  keyed("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP"),
  keyed("zai", "Z.AI"),
  keyed("zai-coding-cn", "Z.AI Coding CN"),
  {
    id: "company-llm-gateway-eu",
    name: "Company LLM gateway (EU region, shared team quota)",
    apiKey: { name: "API key" },
    stored: { kind: "api_key", subscription: false },
    custom: {
      api: "anthropic-messages",
      baseUrl: "https://llm-gateway.internal.example-company.com/anthropic/v1",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    },
  },
  {
    id: "ollama-on-studio",
    name: "Ollama on studio",
    apiKey: { name: "API key" },
    custom: {
      api: "openai-completions",
      baseUrl: "http://studio.local:11434/v1",
      models: ["qwen3-coder:30b-a3b-q4_K_M", "gpt-oss:120b", "gpt-oss:20b", "deepseek-r1:70b-llama-distill-q4_K_M", "devstral:24b"],
    },
  },
];

/** GitHub Copilot's device-code sign-in, waiting for the user to approve. */
export const DEVICE_CODE_LOGIN: LoginFlow = {
  id: "login-copilot",
  providerId: "github-copilot",
  method: "oauth",
  events: [{ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: now + 15 * MINUTE }],
  state: "running",
};

/** Anthropic's browser sign-in, waiting for the pasted code. */
export const PASTE_CODE_LOGIN: LoginFlow = {
  id: "login-anthropic",
  providerId: "anthropic",
  method: "oauth",
  events: [
    {
      type: "auth_url",
      url: "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code",
      instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
    },
  ],
  prompt: { id: 2, type: "manual_code", message: "Paste the code Anthropic shows after you sign in:", placeholder: "code#state" },
  state: "running",
};

/** Cloudflare Workers AI's key login; pi asks for the account ID next. */
export const KEY_LOGIN: LoginFlow = {
  id: "login-cloudflare",
  providerId: "cloudflare-workers-ai",
  method: "api_key",
  events: [],
  prompt: { id: 1, type: "secret", message: "Enter Cloudflare API key" },
  state: "running",
};

export const HOST_PROVIDERS: HostProviders = { providers: PROVIDERS, logins: [DEVICE_CODE_LOGIN, PASTE_CODE_LOGIN, KEY_LOGIN] };

/** This client's device key; the Devices section marks the matching entry as "This device". */
export const SELF: KeyPair = { publicKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(32).fill(9) };
const SELF_PUBLIC = toBase64Url(SELF.publicKey);

/**
 * A fully connected 5.13 host showing the parser conversation, so every
 * feature gate is open; pass `host: { protocol: { major: 5, minor: n } }` to
 * see an older host's fallback.
 */
export function fakeView(overrides: Partial<DurableView> = {}): DurableView {
  const conversation = settledConversation();
  return {
    session: { id: "session-1", directory: "/Users/kieran/.pinomad" },
    conversation,
    organized,
    home: { kind: "project", path: PINOMAD.path },
    checkout: {
      conversationId: PARSER_ID,
      path: "/Users/kieran/.pinomad/worktrees/1",
      repo: PINOMAD.path,
      subdir: "",
      branch: "pinomad/1-parser",
      base: "c0ffee0",
    },
    models: MODELS,
    defaults: { model: MODEL, thinkingLevel: "high" },
    notices: [],
    connection: "connected",
    docs: [
      {
        kind: "todo",
        presentation: "pinomad.todo",
        value: {
          items: [
            { text: "Find the bug", status: "completed" },
            { text: "Fix it", status: "completed" },
            { text: "Add a regression test", status: "in_progress" },
          ],
        },
      },
    ],
    toolPresentations: {},
    devices: [
      { publicKey: SELF_PUBLIC, name: "Mac Desktop (kieran-mbp)", pairedAt: now - 30 * 24 * 60 * MINUTE, source: "local" },
      { publicKey: key("B"), name: "iPhone 18 Pro", pairedAt: now - 5 * 24 * 60 * MINUTE, source: "qr" },
      { publicKey: key("C"), name: "Safari on iPad", pairedAt: now - 2 * 60 * MINUTE, source: "account" },
    ],
    mcp: {
      configPath: "/Users/kieran/.pi/mcp.json",
      errors: [],
      servers: [
        { name: "github", state: "connected", tools: 24 },
        { name: "linear", state: "failed", error: "401 Unauthorized", tools: 0 },
      ],
    },
    auth: {
      logins: [
        { providerId: "anthropic", name: "Anthropic", kind: "oauth", subscription: true },
        { providerId: "openai", name: "OpenAI", kind: "api_key", subscription: false },
      ],
    },
    providers: HOST_PROVIDERS,
    settings: {
      defaultModel: MODEL,
      defaultThinkingLevel: "high",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      acceptAccountDevices: true,
      rtcStun: ["stun:stun.cloudflare.com:3478"],
      hostName: "kieran-mbp",
      custom: ["defaultModel", "hostName"],
    },
    agents: {
      roles: [
        { name: "tester", description: "Writes focused regression tests", model: "anthropic/claude-sonnet-5-5", thinkingLevel: "medium", prompt: "You write tests." },
        { name: "reviewer", description: "Reviews diffs for correctness", prompt: "You review changes." },
      ],
      problems: [{ file: "Broken.md", reason: "name must be lowercase kebab-case" }],
    },
    host: { version: "0.9.0", protocol: PROTOCOL },
    ...overrides,
  };
}

// --- Remote --------------------------------------------------------------------

/** A remote whose every call is a logged `fn()` resolving with plausible data. */
export function fakeRemote(view: DurableView = fakeView(), overrides: Partial<DurableController> = {}): RemoteDurable {
  const controller: DurableController = {
    addProject: fn(async (path: string) => ({ path, name: path.split("/").pop() ?? path, addedAt: now })),
    listFolders: fn(async () => ({
      path: "/Users/kieran",
      home: "/Users/kieran",
      folders: ["code", "Documents", "Downloads"].map((name) => ({ name, path: `/Users/kieran/${name}` })),
    })),
    removeProject: fn(async () => {}),
    createConversation: fn(async () => {}),
    archive: fn(async () => {}),
    renameConversation: fn(async () => {}),
    submit: fn(async () => {}),
    retrySubmission: fn(async () => {}),
    takeBackSubmission: fn(async () => undefined),
    withdrawQueued: fn(async () => "withdrawn" as const),
    steerQueued: fn(async () => "steered" as const),
    compact: fn(async () => {}),
    runCommand: fn(async () => {}),
    abort: fn(async () => {}),
    setThinkingLevel: fn(async () => {}),
    setModel: fn(async () => {}),
    setAgent: fn(async () => {}),
    toggleTasks: fn(async () => {}),
    switchConversation: fn(async () => {}),
    showSide: fn(async () => {}),
    clearConversation: fn(async () => {}),
    fork: fn(async () => {}),
    answer: fn(async () => {}),
    changes: fn(async () => ({ available: true as const, base: "c0ffee0", patch: PATCH, truncated: false, branch: "pinomad/1-parser" })),
    listFiles: fn(async () => ({ files: ["src/parser.ts", "src/lexer.ts", "test/parser.test.ts"], truncated: false })),
    image: fn(async () => ({ data: "aGVsbG8=", mimeType: "image/png" as const })),
    beginAttachment: fn(async () => key("A")),
    appendAttachment: fn(async (_id: string, offset: number, data: string) => ({
      received: offset + Math.floor((data.length * 3) / 4),
      complete: true,
    })),
    listSkills: fn(async () => ({
      skills: [
        { name: "review", description: "Review a diff against repo standards", source: "project" as const },
        { name: "ship", description: "Commit, open a PR, and merge", source: "user" as const },
      ],
    })),
    listCommands: fn(async () => ({
      commands: [
        { name: "compact", description: "Summarize older context to free up space", argumentHint: "[instructions]", source: "builtin" as const },
      ],
    })),
    createPairing: fn(async () => ({ url: `pinomad://pair#${key("P")}`, expiresAt: Date.now() + 5 * MINUTE })),
    revokeDevice: fn(async () => {}),
    logout: fn(async () => {}),
    // Resolves to the flow the view already lists for this provider, so a
    // story can show a login in progress without a live stream.
    beginLogin: fn(
      async (providerId: string, method: LoginMethod) =>
        view.providers?.logins.find((flow) => flow.providerId === providerId && flow.method === method)?.id ?? "login-new",
    ),
    answerLogin: fn(async () => {}),
    cancelLogin: fn(async () => {}),
    saveCustomProvider: fn(async () => {}),
    removeCustomProvider: fn(async () => {}),
    listEndpointModels: fn(async () => ["llama-4-maverick-17b-128e-instruct", "gpt-oss-120b", "qwen3-235b-a22b-instruct-2507"]),
    updateSettings: fn(async () => {}),
    createAgent: fn(async () => {}),
    updateAgent: fn(async () => {}),
    deleteAgent: fn(async () => {}),
    setPushToken: fn(async () => {}),
    ...overrides,
  };
  return { view: { current: () => view, subscribe: () => () => {} }, controller, terminals: fakeTerminals() } as unknown as RemoteDurable;
}

// --- Terminals -------------------------------------------------------------------

/** A shell's first screen, written on every attach. */
export const TERMINAL_SCREEN = "\x1b[32mkieran@mbp\x1b[0m \x1b[34m~/code/parser\x1b[0m $ ";

export const TERMINALS: readonly TerminalInfo[] = [
  { id: "t-dev", name: "dev server", renamed: true, cols: 80, rows: 24 },
  { id: "t-shell", name: "Terminal 2", renamed: false, cols: 80, rows: 24 },
  { id: "t-tests", name: "Terminal 3", renamed: false, cols: 80, rows: 24, exit: { code: 1 } },
];

/**
 * Terminals in memory, as the host would keep them: `owners` maps a
 * conversation to the owner whose list it shows (itself when absent), and
 * calls change the list and tell its watchers.
 */
export function fakeTerminals({
  lists = {},
  owners = {},
  unavailable,
  limit = 8,
}: {
  lists?: Partial<Record<number, readonly TerminalInfo[]>>;
  owners?: Partial<Record<number, ConversationId>>;
  unavailable?: string;
  limit?: number;
} = {}): RemoteTerminals {
  const terminals = new Map<ConversationId, TerminalInfo[]>(
    Object.entries(lists).map(([owner, list]) => [id(Number(owner)), [...(list ?? [])]]),
  );
  const watchers = new Map<ConversationId, Set<(state: TerminalsState) => void>>();
  const ownerOf = (conversationId: ConversationId): ConversationId => owners[conversationId] ?? conversationId;
  const listOf = (owner: ConversationId): TerminalList => ({ owner, limit, terminals: [...(terminals.get(owner) ?? [])] });
  const changed = (owner: ConversationId): void => {
    for (const watcher of watchers.get(owner) ?? []) watcher({ kind: "ready", list: listOf(owner) });
  };
  const update = (terminalId: string, change: (terminal: TerminalInfo) => TerminalInfo | undefined): void => {
    for (const [owner, list] of terminals) {
      const index = list.findIndex((terminal) => terminal.id === terminalId);
      if (index === -1) continue;
      const next = change(list[index]!);
      if (next === undefined) list.splice(index, 1);
      else list[index] = next;
      changed(owner);
    }
  };
  let opened = 0;
  return {
    watch: fn((conversationId: ConversationId, listener: (state: TerminalsState) => void) => {
      if (unavailable !== undefined) {
        listener({ kind: "unavailable", reason: unavailable });
        return () => {};
      }
      const owner = ownerOf(conversationId);
      const set = watchers.get(owner) ?? new Set();
      watchers.set(owner, set);
      set.add(listener);
      // Like the client: a fresh stream is loading until the host's snapshot lands.
      listener({ kind: "loading" });
      queueMicrotask(() => {
        if (set.has(listener)) listener({ kind: "ready", list: listOf(owner) });
      });
      return () => void set.delete(listener);
    }),
    attach: fn((_terminalId: string, sink: TerminalOutputSink) => {
      sink.output(TERMINAL_SCREEN, true);
      return () => {};
    }),
    open: fn(async (conversationId: ConversationId) => {
      const owner = ownerOf(conversationId);
      const list = terminals.get(owner) ?? [];
      terminals.set(owner, list);
      if (list.length >= limit) throw new Error(`Terminal limit reached (${limit})`);
      const terminalId = `t-new-${++opened}`;
      // The call answers before the list does, as it can on the wire.
      queueMicrotask(() => {
        list.push({ id: terminalId, name: `Terminal ${list.length + 1}`, renamed: false, cols: 80, rows: 24 });
        changed(owner);
      });
      return terminalId;
    }),
    input: fn(),
    resize: fn(),
    rename: fn(async (terminalId: string, name: string | null) =>
      update(terminalId, (terminal) => ({ ...terminal, name: name ?? "Terminal", renamed: name !== null })),
    ),
    restart: fn(async (terminalId: string) =>
      update(terminalId, ({ exit: _exit, ...terminal }) => terminal),
    ),
    close: fn(async (terminalId: string) => update(terminalId, () => undefined)),
  };
}

// --- Paired hosts ----------------------------------------------------------------

export const HOME_HOST: StoredHost = { url: "wss://kieran-mbp.tailf76614.ts.net:8787", hostKey: key("H"), privateKey: key("p"), name: "kieran-mbp" };
export const DEVBOX_HOST: StoredHost = { url: "wss://omarchy.tailf76614.ts.net:8787", hostKey: key("D"), privateKey: key("q"), name: "omarchy" };

export const NAS_HOST: StoredHost = { url: "wss://nas.tailf76614.ts.net:8787", hostKey: key("N"), privateKey: key("r"), name: "nas" };

/** A second machine's smaller tree: one project, no plain chats. */
export function devboxView(overrides: Partial<DurableView> = {}): DurableView {
  const base = fakeView();
  const [first] = base.organized.projects;
  return fakeView({
    conversation: undefined,
    organized: {
      ...base.organized,
      chats: [],
      projects: first === undefined ? [] : [{ ...first, project: { ...first.project, path: "/home/kieran/code/harness", name: "harness" } }],
    },
    ...overrides,
  });
}

/**
 * Three paired machines as the frame sees them: the focused Mac with the full
 * tree, a connected Linux box, and a NAS that has not connected yet.
 */
export function fakeMachines(
  overrides: { home?: DurableView; devbox?: DurableView } = {},
): { key: string; hostKey: string; label: string; view?: DurableView; remote?: RemoteDurable; device?: KeyPair }[] {
  const home = overrides.home ?? fakeView();
  const devbox = overrides.devbox ?? devboxView();
  return [
    { key: HOME_HOST.hostKey, hostKey: HOME_HOST.hostKey, label: "kieran-mbp", view: home, remote: fakeRemote(home), device: SELF },
    { key: DEVBOX_HOST.hostKey, hostKey: DEVBOX_HOST.hostKey, label: "omarchy", view: devbox, remote: fakeRemote(devbox), device: SELF },
    { key: NAS_HOST.hostKey, hostKey: NAS_HOST.hostKey, label: "nas" },
  ];
}

export function fakeHosts(hosts: readonly StoredHost[] = [HOME_HOST, DEVBOX_HOST], focusedHostKey: string | null = HOME_HOST.hostKey): HostsState {
  return {
    store: {
      list: fn(async () => [...hosts]),
      save: fn(async () => {}),
      remove: fn(async () => {}),
      setName: fn(async () => {}),
      updateEndpoints: fn(async () => {}),
      updateConnection: fn(async () => {}),
    },
    hosts,
    focus: focusedHostKey === null ? null : { hostKey: focusedHostKey },
    paired: fn(async () => {}),
    setName: fn(async () => {}),
    endpoints: fn(async () => {}),
    setConnection: fn(async () => {}),
    focusHost: fn(),
    focusConversation: fn(),
    rememberConversation: fn(),
    focusDraft: fn(),
    forget: fn(async () => {}),
    dropHost: fn(async () => {}),
  };
}

/** Provides the paired-host list App loads at startup. Never writes localStorage, which the jsdom story run shares. */
export function withHosts(state: HostsState = fakeHosts()): Decorator {
  return (Story) => (
    <HostsContext.Provider value={state}>
      <Story />
    </HostsContext.Provider>
  );
}

// --- Account ---------------------------------------------------------------------

function accountHost(overrides: Partial<AccountHost>): AccountHost {
  return { hostId: "h".repeat(43), name: "kieran-mbp", noisePublicKey: HOME_HOST.hostKey, online: true, lastSeenAt: now, pairing: "available", ...overrides };
}

export const ACCOUNT_HOSTS: readonly AccountHostMatch[] = [
  { host: accountHost({}), status: "paired", stored: HOME_HOST, linkable: false, autoRegister: false },
  { host: accountHost({ hostId: "o".repeat(43), name: "omarchy", noisePublicKey: key("E"), lastSeenAt: now - 3 * MINUTE }), status: "unpaired", linkable: false, autoRegister: true },
  {
    host: accountHost({ hostId: "s".repeat(43), name: "studio", noisePublicKey: key("F"), online: false, lastSeenAt: now - 2 * 24 * 60 * MINUTE, pairing: "offline" }),
    status: "unpaired",
    linkable: false,
    autoRegister: true,
  },
];

/**
 * The account's devices (#452): this browser, a phone and a desktop in use, a
 * lost phone removed an hour ago that the offline studio hasn't revoked yet,
 * and an unnamed sign-in from an older app.
 */
export const ACCOUNT_DEVICES: readonly AccountDevice[] = [
  {
    id: 5,
    name: "Mac Chrome",
    createdAt: now - 30 * 24 * 60 * MINUTE,
    lastSeenAt: now - 2 * MINUTE,
    current: true,
    hosts: [
      { hostId: "h".repeat(43), name: "kieran-mbp", state: "registered" },
      { hostId: "o".repeat(43), name: "omarchy", state: "registered" },
    ],
  },
  {
    id: 4,
    name: "iPhone",
    createdAt: now - 20 * 24 * 60 * MINUTE,
    lastSeenAt: now - 3 * 60 * MINUTE,
    current: false,
    hosts: [
      { hostId: "h".repeat(43), name: "kieran-mbp", state: "registered" },
      { hostId: "o".repeat(43), name: "omarchy", state: "registered" },
    ],
  },
  {
    id: 3,
    name: "Mac Desktop",
    createdAt: now - 12 * 24 * 60 * MINUTE,
    lastSeenAt: now - 5 * 24 * 60 * MINUTE,
    current: false,
    hosts: [{ hostId: "h".repeat(43), name: "kieran-mbp", state: "registered" }],
  },
  {
    id: 2,
    name: "iPhone",
    createdAt: now - 90 * 24 * 60 * MINUTE,
    lastSeenAt: now - 9 * 24 * 60 * MINUTE,
    current: false,
    kickedAt: now - 60 * MINUTE,
    hosts: [
      { hostId: "h".repeat(43), name: "kieran-mbp", state: "revoked" },
      { hostId: "s".repeat(43), name: "studio", state: "revoking" },
    ],
  },
  { id: 1, createdAt: now - 40 * 24 * 60 * MINUTE, lastSeenAt: now - 40 * 24 * 60 * MINUTE, current: false, hosts: [] },
];

export const ACCOUNT_INVITES: readonly AccountInvite[] = [
  { id: 3, createdAt: now - 5 * MINUTE, expiresAt: now + 7 * 24 * 60 * MINUTE - 5 * MINUTE },
  { id: 2, createdAt: now - 3 * 24 * 60 * MINUTE, expiresAt: now + 4 * 24 * 60 * MINUTE, usedAt: now - 2 * 24 * 60 * MINUTE, usedBy: "alex" },
  { id: 1, createdAt: now - 9 * 24 * 60 * MINUTE, expiresAt: now - 2 * 24 * 60 * MINUTE },
];

/** A host that ran `pinomad join` without a token, as the confirm page sees it (#496). */
export const HOST_LINK_REQUEST: HostLinkRequest = {
  hostId: "Or-983sVxD715Pir-F61GmSkh4kPJVn1RvqZkt9MnSA",
  name: "omarchy",
  os: "Linux (x64)",
  sourceIp: "203.0.113.7",
  ipDiffers: false,
  expiresAt: now + 9 * MINUTE,
};

export const signedIn = (overrides: Partial<Extract<AccountState, { status: "signed-in" }>> = {}): AccountState => ({
  status: "signed-in",
  mode: "cookie",
  user: "kieran",
  admin: false,
  serverOrigin: "https://pinomad.si",
  hosts: ACCOUNT_HOSTS,
  rejectedHostKeys: [],
  unsavedHosts: [],
  ...overrides,
});

/** A static account model (as account-panel.test.tsx's): every action is a logged `fn()` that succeeds. */
export function fakeAccount(state: AccountState): AccountModel {
  return {
    state,
    subscribe: () => () => {},
    login: fn(async () => ({ ok: true as const, value: undefined })),
    register: fn(async () => ({ ok: true as const, value: undefined })),
    logout: fn(async () => ({ ok: true as const, value: undefined })),
    revokeAll: fn(async () => ({ ok: true as const, value: undefined })),
    changePassword: fn(async () => ({ ok: true as const, value: undefined })),
    deleteAccount: fn(async () => ({ ok: true as const, value: undefined })),
    refreshHosts: fn(async () => ({ ok: true as const, value: [] })),
    listDevices: fn(async () => ({ ok: true as const, value: ACCOUNT_DEVICES })),
    kickDevice: fn(async () => ({ ok: true as const, value: undefined })),
    removeHost: fn(async () => ({ ok: true as const, value: undefined })),
    createJoinToken: fn(async () => ({
      ok: true as const,
      value: { token: "join-7f3a9c", expiresAt: Date.now() + 10 * MINUTE, command: "pinomad join https://pinomad.si join-7f3a9c" },
    })),
    lookupHostLink: fn(async () => ({ ok: true as const, value: HOST_LINK_REQUEST })),
    confirmHostLink: fn(async () => ({ ok: true as const, value: undefined })),
    denyHostLink: fn(async () => ({ ok: true as const, value: undefined })),
    lookupHostLinkRequest: fn(async () => ({ ok: true as const, value: HOST_LINK_REQUEST })),
    confirmHostLinkRequest: fn(async () => ({ ok: true as const, value: "http://127.0.0.1:54321/callback?code=c&state=s" })),
    denyHostLinkRequest: fn(async () => ({ ok: true as const, value: "http://127.0.0.1:54321/callback?error=access_denied&state=s" })),
    watchForHost: fn(),
    listInvites: fn(async () => ({ ok: true as const, value: ACCOUNT_INVITES })),
    createInvite: fn(async () => ({ ok: true as const, value: { code: "Qm3xV8rT2kLp9wYz4nHc1A", expiresAt: Date.now() + 7 * 24 * 60 * MINUTE } })),
    revokeInvite: fn(async () => ({ ok: true as const, value: undefined })),
    // A successful pair focuses the new host; keep the story on the busy state instead.
    pairHost: fn(() => new Promise<never>(() => {})),
    retryUnsavedHost: fn(() => new Promise<never>(() => {})),
    hostRejected: fn(),
  };
}

/** Provides the account model App creates once; outside one, account entry points hide. */
export function withAccount(state: AccountState = signedIn(), actions?: Partial<AccountModel>): Decorator {
  const model = { ...fakeAccount(state), ...actions };
  return (Story) => (
    <AccountContext.Provider value={model}>
      <Story />
    </AccountContext.Provider>
  );
}

// --- Desktop bridge ------------------------------------------------------------------

function DesktopBridgeFixture({ parts, children }: { parts: () => Partial<DesktopBridge>; children: ReactNode }) {
  const [bridge] = useState(() => ({ ...window.pinomadDesktop, ...parts() }) as DesktopBridge);
  // useAppUpdate and the Settings dialog read the bridge during render, so it
  // goes in before the children render; the effect puts the old one back.
  const previous = useState(() => window.pinomadDesktop)[0];
  window.pinomadDesktop = bridge;
  useEffect(() => {
    window.pinomadDesktop = bridge;
    return () => {
      window.pinomadDesktop = previous;
    };
  }, [bridge, previous]);
  return <>{children}</>;
}

/** Stands in for the desktop preload's updater; without it the widgets render their browser variant. */
export function withDesktopUpdates(status: UpdateStatus): Decorator {
  const updates = (): NonNullable<DesktopBridge["updates"]> => ({
    status: async () => status,
    check: fn(async () => status),
    install: fn(async () => status),
    onStatus: () => () => {},
  });
  return (Story) => (
    <DesktopBridgeFixture parts={() => ({ updates: updates() })}>
      <Story />
    </DesktopBridgeFixture>
  );
}

export type FakeLocalHostOptions = {
  /** What state() reports first; start and stop move it like the real service. */
  state: LocalHostState;
  /** Printed by stop() while it waits, one per tick. */
  stopLines?: readonly string[];
  /** stop() keeps waiting until cancelStop(), like a host with running tasks. */
  stopWaits?: boolean;
  /** A stop is already running, as when Settings closed while it waited; followStop() joins it. */
  stopInFlight?: boolean;
  startResult?: LocalHostResult;
  /** Printed by install() before it finishes, one per tick. */
  installLines?: readonly string[];
  /** install() keeps running until cancelInstall(), like a slow download. */
  installWaits?: boolean;
  installResult?: LocalHostSetupResult;
  /** On ok, state() reports the host installed and running, as `pinomad up` leaves it. */
  joinResult?: LocalHostResult;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A desktop main process over a host installed on this Mac. state() follows
 * start and stop; stop() prints its lines and then finishes, or waits for
 * cancelStop() with `stopWaits`, as `service stop` does with running tasks.
 * Like main, it keeps a running stop's lines for followStop().
 */
export function fakeLocalHost(options: FakeLocalHostOptions): NonNullable<DesktopBridge["localHost"]> {
  let state = options.state;
  const listeners = new Set<(lines: readonly string[]) => void>();
  const setupListeners = new Set<(lines: readonly string[]) => void>();
  let installing: Promise<LocalHostSetupResult> | undefined;
  let cancelInstall: (() => void) | undefined;
  const runInstall = async (): Promise<LocalHostSetupResult> => {
    let printed: readonly string[] = [];
    for (const line of options.installLines ?? []) {
      await tick();
      printed = [...printed, line];
      for (const listener of setupListeners) listener(printed);
    }
    if (options.installWaits) {
      await new Promise<void>((resolve) => {
        cancelInstall = resolve;
      });
      return { outcome: "cancelled" };
    }
    await tick();
    return options.installResult ?? { outcome: "done" };
  };
  let lines: readonly string[] = [];
  let inFlight: Promise<LocalHostStopResult> | undefined;
  let cancel: (() => void) | undefined;
  const set = (running: boolean): void => {
    if (state.kind === "installed") {
      state = { kind: "installed", running, stopped: !running, stopping: false, detail: running ? "running (pid 4242)" : "stopped" };
    }
  };
  const push = (): void => {
    for (const listener of listeners) listener(lines);
  };
  const runStop = async (): Promise<LocalHostStopResult> => {
    for (const line of options.stopLines ?? []) {
      await tick();
      lines = [...lines, line];
      push();
    }
    if (options.stopWaits) {
      await new Promise<void>((resolve) => {
        cancel = resolve;
      });
      return { outcome: "cancelled" };
    }
    set(false);
    return { outcome: "stopped" };
  };
  const begin = (): Promise<LocalHostStopResult> =>
    (inFlight = runStop().finally(() => {
      inFlight = undefined;
      lines = [];
    }));
  if (options.stopInFlight) void begin();
  return {
    state: fn(async (): Promise<LocalHostState> =>
      inFlight !== undefined && state.kind === "installed" ? { ...state, stopping: true, detail: "stopping" } : state,
    ),
    start: fn(async () => {
      const result = options.startResult ?? { ok: true as const };
      if (result.ok) set(true);
      return result;
    }),
    stop: fn(async () => inFlight ?? begin()),
    followStop: fn(async () => {
      if (inFlight !== undefined && lines.length > 0) push();
      return inFlight;
    }),
    cancelStop: fn(async () => {
      cancel?.();
      cancel = undefined;
    }),
    install: fn(async () => (installing ??= runInstall().finally(() => (installing = undefined)))),
    cancelInstall: fn(async () => {
      cancelInstall?.();
      cancelInstall = undefined;
    }),
    join: fn(async (_serverOrigin: string, _token: string): Promise<LocalHostResult> => {
      await tick();
      const result = options.joinResult ?? { ok: true as const };
      if (result.ok) state = { kind: "installed", running: true, stopped: false, stopping: false, detail: "running (pid 4242)" };
      return result;
    }),
    onStopLines: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSetupLines: (listener) => {
      setupListeners.add(listener);
      return () => setupListeners.delete(listener);
    },
  };
}

/** Stands in for the desktop preload's local-host switch (macOS); without it Settings has no This Mac. */
export function withDesktopLocalHost(options: FakeLocalHostOptions): Decorator {
  return (Story) => (
    <DesktopBridgeFixture parts={() => ({ localHost: fakeLocalHost(options) })}>
      <Story />
    </DesktopBridgeFixture>
  );
}
