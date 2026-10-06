// The project → conversation index (ADR-0007): one session-scoped Durable document
// holds the project registry and every top-level conversation's home. This is core
// code, not an extension: the document's semantics are part of the host protocol.
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, defineDoc, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import type { Home, HostIndex, Project } from "@pinomad/protocol/organization.ts";

export const IndexDoc = defineDoc<HostIndex>({
  kind: "pinomad.index",
  version: 1,
  scope: "session",
  initial: () => ({ projects: [], conversations: [] }),
});

/** What a new conversation starts with; the host's configured defaults. */
export interface ConversationDefaults {
  readonly model?: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
}

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
  input: { readonly home: Home; readonly text: string; readonly requestId: string },
  defaults: ConversationDefaults,
  context: Context,
): Promise<ConversationId> {
  const home = input.home;
  // Best-effort normalization; the registry check inside the commit is authoritative.
  const projectPath = home.kind === "project" ? await normalizePath(home.path).catch(() => home.path) : undefined;
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          ...(projectPath === undefined ? {} : { cwd: projectPath }),
          ...(defaults.model === undefined ? {} : { model: defaults.model }),
          ...(defaults.thinkingLevel === undefined ? {} : { thinkingLevel: defaults.thinkingLevel }),
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
          if (home.kind === "chat") {
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
