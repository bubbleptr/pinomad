// Fake host state for widget stories: one host with two projects and a chat,
// a remote whose controller answers with plausible data, and decorators that
// install the account, paired-host and desktop-updater contexts App provides.
// Story-only: nothing in the app imports this.
import type { Decorator } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import { fn } from "storybook/test";
import type { ConversationId, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { AccountHost, AccountHostMatch } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { organize, type HostIndex, type Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableController, DurableView, ModelSummary } from "@pinomad/protocol/view.ts";
import { AccountContext } from "../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../entities/account/account-model.ts";
import type { UpdateStatus } from "../entities/app-update/update-protocol.ts";
import type { DesktopBridge } from "../entities/host/desktop-bridge.ts";
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

const summaries: ConversationSummary[] = [
  { id: PARSER_ID, kind: "conversation", title: "Fix the parser's trailing-comma bug", updatedAt: now - 3 * MINUTE },
  { id: id(2), kind: "conversation", title: "Add a dark mode toggle", status: "running", updatedAt: now - MINUTE, activity: { tool: "edit", target: "src/theme.ts" } },
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
    { id: id(2), home: { kind: "project", path: WEBSITE.path }, createdAt: now - 20 * MINUTE },
    { id: id(3), home: { kind: "chat" }, createdAt: now - 50 * MINUTE },
    { id: id(6), home: { kind: "project", path: PINOMAD.path }, createdAt: now - 3 * 60 * MINUTE },
    { id: id(7), home: { kind: "chat" }, createdAt: now - 10 * 24 * 60 * MINUTE, archived: true },
  ],
};

export const organized = organize(index, summaries);
export const summaryOf = (target: ConversationId) => summaries.find((summary) => summary.id === target);

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
export function subagentConversation(): ConversationView {
  const { user, assistant, result } = transcript(SUBAGENT_ID);
  return {
    conversation: { id: SUBAGENT_ID, kind: "subagent", parent: PARSER_ID },
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
    settings: {
      defaultModel: MODEL,
      defaultThinkingLevel: "high",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      acceptAccountDevices: true,
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
    fork: fn(async () => {}),
    answer: fn(async () => {}),
    changes: fn(async () => ({ available: true as const, base: "c0ffee0", patch: PATCH, truncated: false, branch: "pinomad/1-parser" })),
    listFiles: fn(async () => ({ files: ["src/parser.ts", "src/lexer.ts", "test/parser.test.ts"], truncated: false })),
    image: fn(async () => ({ data: "aGVsbG8=", mimeType: "image/png" as const })),
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
    updateSettings: fn(async () => {}),
    createAgent: fn(async () => {}),
    updateAgent: fn(async () => {}),
    deleteAgent: fn(async () => {}),
    setPushToken: fn(async () => {}),
    ...overrides,
  };
  return { view: { current: () => view, subscribe: () => () => {} }, controller } as unknown as RemoteDurable;
}

// --- Paired hosts ----------------------------------------------------------------

export const HOME_HOST: StoredHost = { url: "wss://kieran-mbp.tailf76614.ts.net:8787", hostKey: key("H"), privateKey: key("p"), name: "kieran-mbp" };
export const DEVBOX_HOST: StoredHost = { url: "wss://omarchy.tailf76614.ts.net:8787", hostKey: key("D"), privateKey: key("q"), name: "omarchy" };

export function fakeHosts(hosts: readonly StoredHost[] = [HOME_HOST, DEVBOX_HOST], activeHostKey: string | null = HOME_HOST.hostKey): HostsState {
  return {
    store: { list: fn(async () => [...hosts]), save: fn(async () => {}), remove: fn(async () => {}), setName: fn(async () => {}) },
    hosts,
    activeHostKey,
    paired: fn(async () => {}),
    setName: fn(async () => {}),
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
  { host: accountHost({}), status: "paired", stored: HOME_HOST, linkable: false },
  { host: accountHost({ hostId: "o".repeat(43), name: "omarchy", noisePublicKey: key("E"), lastSeenAt: now - 3 * MINUTE }), status: "unpaired", linkable: false },
  {
    host: accountHost({ hostId: "s".repeat(43), name: "studio", noisePublicKey: key("F"), online: false, lastSeenAt: now - 2 * 24 * 60 * MINUTE, pairing: "offline" }),
    status: "unpaired",
    linkable: false,
  },
];

export const signedIn = (overrides: Partial<Extract<AccountState, { status: "signed-in" }>> = {}): AccountState => ({
  status: "signed-in",
  mode: "cookie",
  user: "kieran",
  serverOrigin: "https://pinomad.si",
  hosts: ACCOUNT_HOSTS,
  rejectedHostKeys: [],
  ...overrides,
});

/** A static account model (as account-panel.test.tsx's): every action is a logged `fn()` that succeeds. */
export function fakeAccount(state: AccountState): AccountModel {
  return {
    state,
    subscribe: () => () => {},
    login: fn(async () => ({ ok: true as const, value: undefined })),
    logout: fn(async () => ({ ok: true as const, value: undefined })),
    revokeAll: fn(async () => ({ ok: true as const, value: undefined })),
    refreshHosts: fn(async () => ({ ok: true as const, value: [] })),
    createJoinToken: fn(async () => ({
      ok: true as const,
      value: { token: "join-7f3a9c", expiresAt: Date.now() + 10 * MINUTE, command: "pinomad join https://pinomad.si join-7f3a9c" },
    })),
    // A successful pair switches host, which reloads the canvas: stay busy instead.
    pairHost: fn(() => new Promise<never>(() => {})),
    retryUnsavedHost: fn(() => new Promise<never>(() => {})),
    hostRejected: fn(),
  };
}

/** Provides the account model App creates once; outside one, account entry points hide. */
export function withAccount(state: AccountState = signedIn()): Decorator {
  const model = fakeAccount(state);
  return (Story) => (
    <AccountContext.Provider value={model}>
      <Story />
    </AccountContext.Provider>
  );
}

// --- Desktop updater -----------------------------------------------------------------

function DesktopBridgeFixture({ status, children }: { status: UpdateStatus; children: ReactNode }) {
  const [bridge] = useState(() => {
    const updates: NonNullable<DesktopBridge["updates"]> = {
      status: async () => status,
      check: fn(async () => status),
      install: fn(async () => status),
      onStatus: () => () => {},
    };
    return { ...window.pinomadDesktop, updates } as DesktopBridge;
  });
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
  return (Story) => (
    <DesktopBridgeFixture status={status}>
      <Story />
    </DesktopBridgeFixture>
  );
}
