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

/** Where a top-level conversation lives: inside a project, or a project-less Chat. */
export type Home = { readonly kind: "project"; readonly path: string } | { readonly kind: "chat" };

/** One top-level conversation in the index; forks and subagents nest under it instead. */
export type IndexEntry = {
  readonly id: ConversationId;
  readonly home: Home;
  readonly createdAt: number;
  readonly archived?: boolean;
  /** Client-generated idempotency key for the creation request. */
  readonly requestId?: string;
};

/** Shape of the host's session-scoped index document. Arrays are mutable: it is a Durable doc. */
export type HostIndex = {
  readonly projects: Project[];
  readonly conversations: IndexEntry[];
};

export type ConversationNode = {
  readonly summary: ConversationSummary;
  readonly children: readonly ConversationNode[];
};

export type Organized = {
  readonly chats: readonly ConversationNode[];
  readonly projects: readonly { readonly project: Project; readonly conversations: readonly ConversationNode[] }[];
};

/**
 * Group index entries and summaries for display: projects newest-first, their
 * conversations newest-first, forks and subagents nested under their ancestor.
 * Entries in removed projects, archived entries, and orphans never surface.
 */
export function organize(index: HostIndex, summaries: readonly ConversationSummary[]): Organized {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const nodes = new Map<ConversationId, ConversationNode & { children: ConversationNode[] }>();
  const topLevel = new Map<ConversationId, IndexEntry>();

  for (const entry of index.conversations) {
    if (entry.archived === true) continue;
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

  const entries = [...topLevel.values()].sort((a, b) => b.createdAt - a.createdAt);
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
  };
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
