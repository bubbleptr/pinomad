// The project → conversation index (ADR-0007): one session-scoped Durable document
// holds the project registry and every top-level conversation's home. This is core
// code, not an extension: the document's semantics are part of the host protocol.
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  defineDoc,
  type DocumentReader,
  type Harness,
  type ModelRef,
} from "@earendil-works/pi-durable";
import type { Home, HostIndex, Project, WorktreeCheckout } from "@pinomad/protocol/organization.ts";
import { branchSuffix, checkoutAt, gitBase, removeWorktree, worktreeBranch, worktreePath } from "./checkout.ts";

export const IndexDoc = defineDoc<HostIndex>({
  kind: "pinomad.index",
  version: 1,
  scope: "session",
  initial: () => ({ projects: [], conversations: [] }),
});

/** What a new conversation starts with; the host's configured defaults. Wire-level type lives in protocol. */
export type { ConversationDefaults } from "@pinomad/protocol/view.ts";
import type { ConversationDefaults } from "@pinomad/protocol/view.ts";

/** Materialize the index so watchers get a snapshot before the first write. */
export async function ensureIndex(harness: Harness, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    await tx.doc(IndexDoc);
  }, context);
}

/** A project's identity is its resolved, symlink-free absolute path. */
async function normalizePath(path: string): Promise<string> {
  return await realpath(resolve(path));
}

export async function addProject(harness: Harness, path: string, context: Context): Promise<Project> {
  const normalized = await normalizePath(path).catch(() => {
    throw new Error(`No such directory: ${path}`);
  });
  if (!(await stat(normalized)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  return await harness.commit(async (tx) => {
    const doc = await tx.doc(IndexDoc);
    const existing = doc.projects.find((project) => project.path === normalized);
    // Draft values settle with the commit; hand the caller a detached copy.
    if (existing !== undefined) return { ...existing };
    const project: Project = { path: normalized, name: basename(normalized), addedAt: Date.now() };
    doc.projects.push(project);
    return project;
  }, context);
}

/** Unregister only; the directory and its conversations stay on disk and in the index. */
export async function removeProject(harness: Harness, path: string, context: Context): Promise<void> {
  // Removed directories may no longer resolve; match on the best spelling available.
  const normalized = await normalizePath(path).catch(() => resolve(path));
  await harness.commit(async (tx) => {
    const doc = await tx.doc(IndexDoc);
    doc.projects = doc.projects.filter((project) => project.path !== normalized);
  }, context);
}

/** Abandons the creating commit when the request's idempotency key already exists. */
class DuplicateRequest extends Error {
  readonly conversationId: ConversationId;
  constructor(conversationId: ConversationId) {
    super("conversation already created");
    this.conversationId = conversationId;
  }
}

/**
 * Create a top-level conversation and its index entry in one commit, then submit
 * `text`. Retrying a lost reply with the same requestId returns the existing
 * conversation instead of creating a second one.
 */
export async function createConversation(
  harness: Harness,
  dataDir: string,
  input: {
    readonly home: Home;
    readonly text: string;
    readonly requestId: string;
    /** `"project"` works directly in the project directory; default is a worktree when the project is a git repo. */
    readonly checkout?: "worktree" | "project";
    /** Overrides the host default; an unknown ref rejects before the commit. */
    readonly model?: ModelRef;
    /** Overrides the host default; clamps to the effective model's levels. */
    readonly thinkingLevel?: ModelThinkingLevel;
  },
  defaults: ConversationDefaults,
  models: Models,
  context: Context,
): Promise<ConversationId> {
  // Retries can outlive the model list they were made against: the index
  // lookup runs before model validation so an already-created request still
  // resolves instead of rejecting on the stale model. The creating commit
  // landed but its submit may not have (process died between the two), so the
  // retry still submits — submit dedupes on requestId, making a fully-admitted
  // create's retry a no-op.
  const index = await harness.snapshot(IndexDoc, context);
  const prior = index?.conversations.find((entry) => entry.requestId === input.requestId);
  if (prior !== undefined) {
    const existing = await harness.conversation(prior.id, context);
    if (existing !== undefined) {
      await existing.submit(
        { type: "input", content: input.text, whenBusy: "followUp", requestId: input.requestId },
        context,
      );
    }
    return prior.id;
  }

  const modelRef = input.model ?? defaults.model;
  const model =
    modelRef === undefined ? undefined : models.getModel(modelRef.provider, modelRef.modelId);
  if (input.model !== undefined && model === undefined) {
    throw new Error(`Unknown model: ${input.model.provider}/${input.model.modelId}`);
  }
  const thinkingLevel =
    model === undefined
      ? input.thinkingLevel ?? defaults.thinkingLevel
      : clampThinkingLevel(model, input.thinkingLevel ?? defaults.thinkingLevel ?? "off");
  const home = input.home;
  // Best-effort normalization; the registry check inside the commit is authoritative.
  const projectPath = home.kind === "project" ? await normalizePath(home.path).catch(() => home.path) : undefined;
  // The checkout is decided before the commit so its record lands in the same
  // one (ADR-0010 §6); the directory itself is created lazily by the env builder.
  const repo =
    home.kind === "project" && input.checkout !== "project" && projectPath !== undefined
      ? await gitBase(projectPath)
      : undefined;
  const suffix = repo === undefined ? undefined : branchSuffix();
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          // A worktree's cwd is set in init once the record's path is known.
          ...(projectPath === undefined || repo !== undefined ? {} : { cwd: projectPath }),
          ...(modelRef === undefined ? {} : { model: modelRef }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        },
        init: async (tx, id) => {
          const doc = await tx.doc(IndexDoc);
          const existing = doc.conversations.find((entry) => entry.requestId === input.requestId);
          if (existing !== undefined) throw new DuplicateRequest(existing.id);
          if (home.kind === "project" && !doc.projects.some((project) => project.path === projectPath)) {
            throw new Error(`Unknown project: ${home.path}`);
          }
          const stored: Home = home.kind === "chat" ? { kind: "chat" } : { kind: "project", path: projectPath! };
          doc.conversations.push({ id, home: stored, createdAt: Date.now(), requestId: input.requestId });
          if (repo !== undefined && suffix !== undefined) {
            const path = worktreePath(dataDir, id);
            // Read-after-set: a fresh ??= array is a raw value, pushes to it would not persist.
            if (doc.checkouts === undefined) doc.checkouts = [];
            doc.checkouts.push({
              conversationId: id,
              path,
              repo: repo.repo,
              subdir: repo.subdir,
              branch: worktreeBranch(id, suffix),
              base: repo.base,
            });
            (await tx.doc(AgentDoc, id)).cwd = join(path, repo.subdir);
          } else if (home.kind === "chat") {
            // A Chat's checkout is a per-conversation directory under the data dir; its
            // id exists only inside this commit, so the cwd is set on the agent doc here.
            (await tx.doc(AgentDoc, id)).cwd = join(dataDir, "chats", String(id));
          }
        },
      },
      context,
    );
    if (home.kind === "chat") await mkdir(join(dataDir, "chats", String(conversation.id)), { recursive: true });
    await conversation.submit(
      { type: "input", content: input.text, whenBusy: "followUp", requestId: input.requestId },
      context,
    );
    return conversation.id;
  } catch (error) {
    if (!(error instanceof DuplicateRequest)) throw error;
    // The creating commit landed but the submit may not have (process died between
    // the two). Resubmit with the same requestId — submit dedupes it too, so a
    // retry of a fully-admitted create is still a no-op.
    const existing = await harness.conversation(error.conversationId, context);
    if (existing !== undefined) {
      await existing.submit(
        { type: "input", content: input.text, whenBusy: "followUp", requestId: input.requestId },
        context,
      );
    }
    return error.conversationId;
  }
}

export async function archive(harness: Harness, id: ConversationId, archived: boolean, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(IndexDoc);
    const entry = doc.conversations.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`Unknown conversation ${id}`);
    entry.archived = archived;
  }, context);
}

/** What prompt rendering needs to know about a worktree checkout. */
export interface CheckoutPromptInfo {
  readonly branch: string;
  readonly base: string;
  readonly projectPath: string;
  readonly repo: string;
  readonly worktreeRoot: string;
  /** False when the record belongs to another conversation sharing this cwd — a fork or a subagent (ADR-0019 §1). */
  readonly own: boolean;
}

// `parent` is fixed at creation: once a record is read, its fork flag never
// needs another trip onto the Session mutation line — prompt sections would
// otherwise take one commit per model request.
const forkFlags = new WeakMap<Harness, Map<ConversationId, boolean>>();

async function forkFlagOf(harness: Harness, id: ConversationId, context: Context): Promise<boolean> {
  const cached = forkFlags.get(harness)?.get(id);
  if (cached !== undefined) return cached;
  const record = await harness.commit((tx) => tx.conversation(id), context);
  // Unknown conversations may exist later; only a found record is safe to cache.
  if (record === undefined) return false;
  let flags = forkFlags.get(harness);
  if (flags === undefined) forkFlags.set(harness, (flags = new Map()));
  flags.set(id, record.parent !== undefined);
  return record.parent !== undefined;
}

/**
 * The checkout behind a conversation's agent cwd, plus whether the conversation
 * is a fork, for the context extension. Subagents and forks inherit the
 * parent's cwd, so matching the path against the records covers both without
 * walking the conversation graph; the fork flag needs the record itself, which
 * only the session's transaction surface exposes.
 */
export async function checkoutInfo(
  harness: Harness,
  input: { readonly conversationId: ConversationId; readonly read: DocumentReader },
  context: Context,
): Promise<{ readonly checkout?: CheckoutPromptInfo; readonly fork: boolean } | undefined> {
  const agent = await input.read.snapshot(AgentDoc, input.conversationId, context);
  const cwd = agent?.cwd;
  if (cwd === undefined) return undefined;
  const [index, fork] = await Promise.all([
    input.read.snapshot(IndexDoc, context),
    forkFlagOf(harness, input.conversationId, context),
  ]);
  const checkout = checkoutAt(index?.checkouts, cwd);
  return {
    fork,
    ...(checkout === undefined
      ? {}
      : {
          checkout: {
            branch: checkout.branch,
            base: checkout.base,
            projectPath: join(checkout.repo, checkout.subdir),
            repo: checkout.repo,
            worktreeRoot: checkout.path,
            own: checkout.conversationId === input.conversationId,
          },
        }),
  };
}

/**
 * After `archive(...)`: remove the worktree directories of the conversation and
 * everything nested under it (pre-ADR-0019 forks own worktrees; new forks and
 * subagents share the parent's and carry no record). Directories git refuses to
 * remove are kept and returned so the caller can warn — the branch is never deleted.
 */
export async function cleanupArchivedWorktrees(
  harness: Harness,
  rootId: ConversationId,
  context: Context,
): Promise<{ readonly record: WorktreeCheckout; readonly reason: string }[]> {
  const index = await harness.snapshot(IndexDoc, context);
  const checkouts = index?.checkouts ?? [];
  if (checkouts.length === 0) return [];
  const all: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const children = new Map<ConversationId, ConversationId[]>();
  for (const record of all) {
    const parent = record.parent?.conversationId ?? record.owner?.conversationId;
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(record.id);
    children.set(parent, list);
  }
  const subtree = new Set<ConversationId>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]!) ?? []) {
      if (!subtree.has(child)) {
        subtree.add(child);
        queue.push(child);
      }
    }
  }
  const kept: { record: WorktreeCheckout; reason: string }[] = [];
  for (const record of checkouts.filter((checkout) => subtree.has(checkout.conversationId))) {
    const reason = await removeWorktree(record);
    if (reason !== undefined) kept.push({ record, reason });
  }
  return kept;
}
