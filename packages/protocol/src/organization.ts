// The project → conversation model (ADR-0007): the host's session-scoped index
// document, and the pure client-side grouping of it with conversation summaries.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary } from "./view.ts";

/** A registered local directory that conversations can belong to. */
export type Project = {
  readonly path: string;
  readonly name: string;
  readonly addedAt: number;
};

/** One `listFolders` page: a host directory and its visible subfolders. */
export interface FolderListing {
  /** Absolute, symlink-free path of the listed folder. */
  readonly path: string;
  /** The host user's home directory, resolved like `path`: the picker's starting point. */
  readonly home: string;
  /** Subfolders whose names don't start with ".", sorted by name. */
  readonly folders: readonly { readonly name: string; readonly path: string }[];
}

/** Where a top-level conversation lives: inside a project, or a project-less Chat. */
export type Home = { readonly kind: "project"; readonly path: string } | { readonly kind: "chat" };

/**
 * What `listFiles` scans (5.10): a conversation's persisted working directory,
 * or a registered project's directory — `worktree` lists the committed HEAD
 * tree a fresh worktree would hold (ADR-0010), `project` the live directory.
 */
export type FileScope =
  | { readonly kind: "conversation"; readonly conversationId: ConversationId }
  | { readonly kind: "project"; readonly path: string; readonly checkout: "worktree" | "project" };

/** One `listFiles` answer: `/`-separated paths relative to the scope's root. */
export interface FileListing {
  readonly files: readonly string[];
  /** True when enumeration or result capping cut the answer short. */
  readonly truncated: boolean;
}

/** One top-level conversation in the index; forks and subagents nest under it instead. */
export type IndexEntry = {
  readonly id: ConversationId;
  readonly home: Home;
  readonly createdAt: number;
  readonly archived?: boolean;
  /** Client-generated idempotency key for the creation request. */
  readonly requestId?: string;
  /** The named agent the conversation was created with (ADR-0023, 5.10); its forks show the same name. */
  readonly role?: string;
};

/** A per-conversation git worktree (ADR-0010). Absent for project-dir, non-git, and Chat checkouts. */
export type WorktreeCheckout = {
  readonly conversationId: ConversationId;
  /** <dataDir>/worktrees/<conversationId> */
  readonly path: string;
  /** The project's repository top level (git -C target for worktree commands). */
  readonly repo: string;
  /** Project path relative to `repo` ("" when the project is the repo root); the agent cwd is join(path, subdir). */
  readonly subdir: string;
  readonly branch: string;
  /** Full commit sha the branch starts at. */
  readonly base: string;
  /** Forks only: commit capturing the parent checkout's working tree at fork time. */
  readonly snapshot?: string;
};

/** Shape of the host's session-scoped index document. Arrays are mutable: it is a Durable doc. */
export type HostIndex = {
  readonly projects: Project[];
  readonly conversations: IndexEntry[];
  /** Absent in documents stored before worktree checkouts existed. */
  readonly checkouts?: WorktreeCheckout[];
};

export type ConversationNode = {
  readonly summary: ConversationSummary;
  readonly children: readonly ConversationNode[];
};

export type Organized = {
  readonly chats: readonly ConversationNode[];
  readonly projects: readonly { readonly project: Project; readonly conversations: readonly ConversationNode[] }[];
  /** Archived roots, newest first; `project` is absent for a Chat. Kept out of `findConversation`: they are restored, not shown. */
  readonly archived: readonly { readonly node: ConversationNode; readonly project?: Project }[];
};

/**
 * Group index entries and summaries for display: projects newest-first, their
 * conversations newest-first, forks and subagents nested under their ancestor;
 * archived roots go to their own list. Entries in removed projects and orphans
 * never surface.
 */
export function organize(index: HostIndex, summaries: readonly ConversationSummary[]): Organized {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const nodes = new Map<ConversationId, ConversationNode & { children: ConversationNode[] }>();
  const topLevel = new Map<ConversationId, IndexEntry>();

  for (const entry of index.conversations) {
    const home = entry.home;
    if (home.kind === "project" && !index.projects.some((project) => project.path === home.path)) continue;
    const summary = summaryById.get(entry.id);
    if (summary === undefined) continue;
    topLevel.set(entry.id, entry);
    nodes.set(entry.id, { summary, children: [] });
  }

  // A nested summary joins once its ancestor chain reaches a top-level entry.
  for (const summary of summaries) {
    const chain: ConversationSummary[] = [summary];
    let current = summary;
    while (!topLevel.has(current.id)) {
      const parent = current.parent === undefined ? undefined : summaryById.get(current.parent);
      if (parent === undefined || chain.includes(parent)) break;
      chain.push(parent);
      current = parent;
    }
    if (!topLevel.has(current.id)) continue;
    // Oldest ancestor first: each node attaches under its immediate parent.
    for (let i = chain.length - 1; i >= 0; i--) {
      const member = chain[i]!;
      if (!nodes.has(member.id)) nodes.set(member.id, { summary: member, children: [] });
      if (i < chain.length - 1) {
        const parent = nodes.get(chain[i + 1]!.id)!;
        const child = nodes.get(member.id)!;
        if (!parent.children.includes(child)) parent.children.push(child);
      }
    }
  }

  const byIdAscending = (a: ConversationNode, b: ConversationNode) => a.summary.id - b.summary.id;
  const nodeList = (entry: IndexEntry) => sortChildren(nodes.get(entry.id)!);
  const sortChildren = (node: ConversationNode): ConversationNode => ({
    summary: node.summary,
    children: [...node.children].sort(byIdAscending).map(sortChildren),
  });

  const sorted = [...topLevel.values()].sort((a, b) => b.createdAt - a.createdAt);
  const entries = sorted.filter((entry) => entry.archived !== true);
  return {
    chats: entries.filter((entry) => entry.home.kind === "chat").map(nodeList),
    projects: [...index.projects]
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((project) => ({
        project,
        conversations: entries
          .filter((entry) => entry.home.kind === "project" && entry.home.path === project.path)
          .map(nodeList),
      })),
    archived: sorted
      .filter((entry) => entry.archived === true)
      .map((entry) => {
        const home = entry.home;
        const project = home.kind === "project" ? index.projects.find((each) => each.path === home.path) : undefined;
        return { node: nodeList(entry), ...(project === undefined ? {} : { project }) };
      }),
  };
}

/** The organized node for a conversation id, wherever it nests (forks and subagents live under their ancestor). */
export function findConversation(organized: Organized, id: ConversationId): ConversationNode | undefined {
  const visit = (nodes: readonly ConversationNode[]): ConversationNode | undefined => {
    for (const node of nodes) {
      if (node.summary.id === id) return node;
      const found = visit(node.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit([...organized.chats, ...organized.projects.flatMap((entry) => entry.conversations)]);
}

/**
 * The worktree a conversation works in: its own record, else the nearest
 * ancestor's — a subagent shares the checkout of the conversation owning it.
 */
export function checkoutOf(
  index: HostIndex,
  summaries: readonly ConversationSummary[],
  id: ConversationId,
): WorktreeCheckout | undefined {
  const record = index.checkouts?.find((checkout) => checkout.conversationId === id);
  if (record !== undefined) return record;
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const seen = new Set<ConversationId>();
  let current = summaryById.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const ancestor = index.checkouts?.find((checkout) => checkout.conversationId === current!.id);
    if (ancestor !== undefined) return ancestor;
    current = current.parent === undefined ? undefined : summaryById.get(current.parent);
  }
  return undefined;
}

/** The home a conversation belongs to, inherited from its top-level index ancestor. */
export function homeOf(index: HostIndex, summaries: readonly ConversationSummary[], id: ConversationId): Home | undefined {
  const entry = index.conversations.find((candidate) => candidate.id === id);
  if (entry !== undefined) return entry.home;
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const seen = new Set<ConversationId>();
  let current = summaryById.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const ancestor = index.conversations.find((candidate) => candidate.id === current!.id);
    if (ancestor !== undefined) return ancestor.home;
    current = current.parent === undefined ? undefined : summaryById.get(current.parent);
  }
  return undefined;
}
