// Shared inputs for the conversation-family derivations: the vitest suite and
// packages/client/test/rust-vectors.ts both consume these tables, so the Rust
// comparison vectors replay the same cases the tests pin. A "family" input is
// a raw {index, summaries} pair — tests and vectors run organize() over it
// and pick nodes by conversation id.

/** A ConversationSummary-shaped value; ids are plain numbers on the wire. */
export const sum = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "conversation",
  ...over,
});

export const chatEntry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  home: { kind: "chat" },
  createdAt: id * 10,
  ...over,
});

export const projectEntry = (id: number, path: string, over: Record<string, unknown> = {}) => ({
  id,
  home: { kind: "project", path },
  createdAt: id * 10,
  ...over,
});

/** `{projects, conversations}` — the HostIndex the host's index doc carries. */
export const indexOf = (conversations: Record<string, unknown>[], projects: Record<string, unknown>[] = []) => ({
  projects,
  conversations,
});

export interface FamilyInput {
  readonly name: string;
  readonly index: Record<string, unknown>;
  readonly summaries: Record<string, unknown>[];
}

/** The `idle` family — a plain conversation plus an unlisted subagent child. */
export const IDLE: FamilyInput = {
  name: "idle",
  index: indexOf([chatEntry(1)]),
  summaries: [sum(1), sum(2, { parent: 1 }), sum(3, { kind: "subagent", parent: 1 })],
};

/** A needs-answer in a grandchild beats a failed root. */
export const GRANDCHILD_NEEDS_ANSWER: FamilyInput = {
  name: "grandchild-needs-answer",
  index: indexOf([chatEntry(1)]),
  summaries: [
    sum(1, { status: "failed" }),
    sum(2, { parent: 1, status: "running" }),
    sum(3, { kind: "fork", parent: 2, status: "needs-answer" }),
  ],
};

/** A failed anywhere in the family beats a running root. */
export const FAILED_BEATS_RUNNING: FamilyInput = {
  name: "failed-beats-running",
  index: indexOf([chatEntry(1)]),
  summaries: [sum(1, { status: "running" }), sum(2, { kind: "subagent", parent: 1, status: "failed" })],
};

/** An unknown status can only win an otherwise-statusless family — RANK
    lookup yields undefined for it, so it loses every `>` comparison after. */
export const UNKNOWN_STATUS_WINS: FamilyInput = {
  name: "unknown-status-wins",
  index: indexOf([chatEntry(1)]),
  summaries: [sum(1), sum(2, { kind: "subagent", parent: 1, status: "weird-status" })],
};

/** The freshest updatedAt across the family, skipping conversations without one. */
export const UPDATED_AT: FamilyInput = {
  name: "updated-at",
  index: indexOf([chatEntry(1)]),
  summaries: [
    sum(1, { updatedAt: 100 }),
    sum(2, { kind: "fork", parent: 1, updatedAt: 300 }),
    sum(3, { kind: "subagent", parent: 1 }),
    sum(4, { parent: 1, updatedAt: 200 }),
  ],
};

/** Root with a subagent, an idle fork, and a busy fork holding a subagent. */
export const FAMILY_TREE: FamilyInput = {
  name: "family-tree",
  index: indexOf([chatEntry(1), chatEntry(9)]),
  summaries: [
    sum(1),
    sum(4, { kind: "subagent", parent: 1, label: "Audit" }),
    sum(2, { kind: "fork", parent: 1 }),
    sum(5, { kind: "fork", parent: 1, title: "worktree fork" }),
    sum(6, { kind: "subagent", parent: 5 }),
    sum(9),
  ],
};

/** Pre-ADR-0019 data: several forks per message and forks nested in forks. */
export const LEGACY_FORKS: FamilyInput = {
  name: "legacy-nested-forks",
  index: indexOf([chatEntry(7)]),
  summaries: [
    sum(7),
    sum(8, { kind: "fork", parent: 7, title: "first" }),
    sum(9, { kind: "fork", parent: 8, title: "nested" }),
    sum(10, { kind: "subagent", parent: 9, label: "Deep task" }),
    sum(11, { kind: "fork", parent: 7, title: "second" }),
  ],
};

/** A fork nested inside a fork for the forksAt anchoring checks. */
export const FORK_ANCHORS: FamilyInput = {
  name: "fork-anchors",
  index: indexOf([chatEntry(1)]),
  summaries: [
    sum(1),
    sum(2, { kind: "fork", parent: 1, forkedAt: "10" }),
    sum(3, { kind: "fork", parent: 2, forkedAt: "11" }),
    sum(4, { kind: "subagent", parent: 1 }),
  ],
};

/** A subagent inside a fork for the rootOf parent walk. */
export const SUB_IN_FORK: FamilyInput = {
  name: "sub-in-fork",
  index: indexOf([chatEntry(1), chatEntry(9)]),
  summaries: [sum(1), sum(2, { kind: "fork", parent: 1 }), sum(3, { kind: "subagent", parent: 2 }), sum(9)],
};

export const FAMILY_CASES: FamilyInput[] = [
  IDLE,
  GRANDCHILD_NEEDS_ANSWER,
  FAILED_BEATS_RUNNING,
  UNKNOWN_STATUS_WINS,
  UPDATED_AT,
  FAMILY_TREE,
  LEGACY_FORKS,
  FORK_ANCHORS,
  SUB_IN_FORK,
];

const byName = (name: string): FamilyInput => FAMILY_CASES.find((c) => c.name === name)!;

/** {family, conversationId} pairs the vector generator resolves to a node. */
export const NODE_QUERIES = [
  { name: "idle", family: "idle", id: 1 },
  { name: "grandchild-needs-answer", family: "grandchild-needs-answer", id: 1 },
  { name: "failed-beats-running", family: "failed-beats-running", id: 1 },
  { name: "running-alone", family: "failed-beats-running", id: 1 },
  { name: "unknown-status-wins", family: "unknown-status-wins", id: 1 },
  { name: "updated-at", family: "updated-at", id: 1 },
  { name: "updated-at-none", family: "idle", id: 1 },
  { name: "family-tree", family: "family-tree", id: 1 },
  { name: "legacy-nested-forks", family: "legacy-nested-forks", id: 7 },
  { name: "fork-anchors", family: "fork-anchors", id: 2 },
];

export const ROOT_OF_CASES = [
  { name: "root", family: "sub-in-fork", id: 1 },
  { name: "fork", family: "sub-in-fork", id: 2 },
  { name: "sub-in-fork", family: "sub-in-fork", id: 3 },
  { name: "other-root", family: "sub-in-fork", id: 9 },
  { name: "missing", family: "sub-in-fork", id: 42 },
];

export const FORKS_AT_CASES = [
  { name: "direct", family: "fork-anchors", conversationId: 1, entryId: "10" },
  { name: "nested", family: "fork-anchors", conversationId: 2, entryId: "11" },
  { name: "not-own", family: "fork-anchors", conversationId: 1, entryId: "11" },
  { name: "missing", family: "fork-anchors", conversationId: 42, entryId: "10" },
];

export const familyByName = byName;

/** displayName cases — the summary the UI names a conversation with. */
export const DISPLAY_NAME_CASES: { name: string; summary: Record<string, unknown> | undefined }[] = [
  { name: "subagent-label", summary: sum(1, { kind: "subagent", label: "Audit auth", title: "In the working directory /tmp/x, do things" }) },
  { name: "subagent-strips-prefix", summary: sum(1, { kind: "subagent", title: "  in the working directory /tmp/x, audit the auth flow" }) },
  { name: "subagent-fallback", summary: sum(1, { kind: "subagent" }) },
  { name: "subagent-empty-title", summary: sum(1, { kind: "subagent", title: "In the working directory /tmp/x," }) },
  { name: "subagent-prefix-caps", summary: sum(1, { kind: "subagent", title: "IN THE WORKING DIRECTORY /w, task" }) },
  { name: "subagent-prefix-no-comma", summary: sum(1, { kind: "subagent", title: "in the working directory /tmp/x do things" }) },
  // The `,` must sit inside the \S+ run: a space before it breaks the match
  // and the title survives whole.
  { name: "subagent-prefix-spaced-comma", summary: sum(1, { kind: "subagent", title: "in the working directory /tmp/x , task" }) },
  // A comma inside the run: the greedy \S+ backtracks to the rightmost comma.
  { name: "subagent-prefix-inner-comma", summary: sum(1, { kind: "subagent", title: "in the working directory /x,y task" }) },
  // \S+ needs at least one unit before the comma.
  { name: "subagent-prefix-comma-first", summary: sum(1, { kind: "subagent", title: "in the working directory , task" }) },
  { name: "title", summary: sum(1, { title: "what broke?" }) },
  { name: "null-title", summary: sum(1, { title: null }) },
  { name: "fork-untitled", summary: sum(1, { kind: "fork" }) },
  { name: "non-bmp", summary: sum(1, { title: "rocket \u{1F680} talk" }) },
  { name: "lone-surrogate", summary: sum(1, { title: "phone \uD83D" }) },
  { name: "absent", summary: undefined },
];

const NOW = 1_800_000_000_000;

export const RELATIVE_TIME_CASES: { name: string; at: number; now: number }[] = [
  { name: "now-59s", at: NOW - 59_000, now: NOW },
  { name: "1m", at: NOW - 60_000, now: NOW },
  { name: "5m", at: NOW - 5 * 60_000, now: NOW },
  { name: "59m", at: NOW - 59 * 60_000, now: NOW },
  { name: "1h", at: NOW - 60 * 60_000, now: NOW },
  { name: "3h", at: NOW - 3 * 60 * 60_000, now: NOW },
  { name: "1d", at: NOW - 24 * 60 * 60_000, now: NOW },
  { name: "2d", at: NOW - 2 * 24 * 60 * 60_000, now: NOW },
  { name: "future", at: NOW + 60_000, now: NOW },
  { name: "boundary-24h-minus", at: NOW - (24 * 60 * 60_000 - 1), now: NOW },
  { name: "sub-second", at: NOW - 999, now: NOW },
];

export const family_case = (name: string): FamilyInput => byName(name);

/** organize / homeOf / checkoutOf / findConversation inputs — raw
    {index, summaries} pairs like the host's index doc produces. */
export const ORGANIZE_CASES: { name: string; index: Record<string, unknown>; summaries: Record<string, unknown>[] }[] = [
  { name: "empty", index: indexOf([]), summaries: [] },
  {
    name: "chats-newest-first",
    index: indexOf([chatEntry(1), chatEntry(2), chatEntry(3)]),
    summaries: [sum(1), sum(2), sum(3)],
  },
  {
    name: "projects",
    index: indexOf(
      [projectEntry(1, "/a"), chatEntry(2), projectEntry(3, "/b")],
      [
        { path: "/a", name: "A", addedAt: 2 },
        { path: "/b", name: "B", addedAt: 5 },
      ],
    ),
    summaries: [sum(1), sum(2), sum(3)],
  },
  {
    name: "nested",
    index: indexOf([chatEntry(1)]),
    summaries: [sum(1), sum(2, { kind: "fork", parent: 1 }), sum(3, { kind: "subagent", parent: 2 }), sum(4, { kind: "subagent", parent: 1 })],
  },
  {
    name: "orphans-never-surface",
    index: indexOf([chatEntry(1)]),
    summaries: [sum(1), sum(2, { parent: 99 }), sum(3, { parent: 2 })],
  },
  {
    name: "archived",
    index: indexOf([chatEntry(1, { archived: true }), projectEntry(2, "/a", { archived: true }), chatEntry(3)], [
      { path: "/a", name: "A", addedAt: 1 },
    ]),
    summaries: [sum(1), sum(2), sum(3)],
  },
  {
    name: "removed-project",
    index: indexOf([projectEntry(1, "/gone")]),
    summaries: [sum(1)],
  },
  {
    name: "entry-without-summary",
    index: indexOf([chatEntry(1)]),
    summaries: [],
  },
  {
    name: "parent-cycle",
    index: indexOf([chatEntry(1)]),
    summaries: [sum(1), sum(2, { parent: 3 }), sum(3, { parent: 2 })],
  },
  {
    name: "checkouts",
    index: {
      ...indexOf([chatEntry(1), chatEntry(2)]),
      checkouts: [
        { conversationId: 1, path: "/wt/1", repo: "/repo", subdir: "", branch: "b1", base: "deadbeef" },
        { conversationId: 2, path: "/wt/2", repo: "/repo", subdir: "", branch: "b2", base: "deadbeef", snapshot: "cafe" },
      ],
    },
    summaries: [sum(1), sum(2)],
  },
];

export const HOME_OF_CASES = [
  { name: "own-chat", index: indexOf([chatEntry(1), chatEntry(2)]), summaries: [sum(1), sum(2)], id: 2 },
  {
    name: "ancestor",
    index: indexOf([projectEntry(1, "/a")], [{ path: "/a", name: "A", addedAt: 1 }]),
    summaries: [sum(1), sum(2, { kind: "subagent", parent: 1 })],
    id: 2,
  },
  { name: "missing", index: indexOf([chatEntry(1)]), summaries: [sum(1)], id: 42 },
  { name: "orphan", index: indexOf([chatEntry(1)]), summaries: [sum(1), sum(2, { parent: 99 })], id: 2 },
];

export const CHECKOUT_OF_CASES = [
  {
    name: "own",
    index: {
      ...indexOf([chatEntry(1), chatEntry(2)]),
      checkouts: [
        { conversationId: 1, path: "/wt/1", repo: "/repo", subdir: "", branch: "b1", base: "deadbeef" },
        { conversationId: 2, path: "/wt/2", repo: "/repo", subdir: "", branch: "b2", base: "deadbeef", snapshot: "cafe" },
      ],
    },
    summaries: [sum(1), sum(2)],
    id: 2,
  },
  {
    name: "ancestor",
    index: {
      ...indexOf([chatEntry(1)]),
      checkouts: [{ conversationId: 1, path: "/wt/1", repo: "/repo", subdir: "", branch: "b1", base: "deadbeef" }],
    },
    summaries: [sum(1), sum(2, { kind: "subagent", parent: 1 })],
    id: 2,
  },
  {
    name: "none",
    index: { ...indexOf([chatEntry(1)]), checkouts: [] },
    summaries: [sum(1)],
    id: 1,
  },
];

export const FIND_CONVERSATION_CASES = [
  { name: "root", family: "sub-in-fork", id: 1 },
  { name: "nested", family: "sub-in-fork", id: 3 },
  { name: "missing", family: "sub-in-fork", id: 42 },
];
