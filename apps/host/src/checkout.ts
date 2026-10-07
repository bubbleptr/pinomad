// Per-conversation git worktree checkouts (ADR-0010). Records live in IndexDoc
// next to the conversation that created them; this module is only the git
// primitives — the worktree directory is materialized lazily by the host's env
// builder, which is also the recreate path after crashes and manual deletes.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { WorktreeCheckout } from "@pinomad/protocol/organization.ts";

const run = promisify(execFile);

const git = (dir: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
  run("git", ["-C", dir, ...args], env === undefined ? {} : { env: { ...process.env, ...env } });

/** <dataDir>/worktrees/ — under the data dir so repos stay untouched by pinomad bookkeeping. */
export const worktreeRoot = (dataDir: string): string => join(dataDir, "worktrees");

/** <dataDir>/worktrees/<conversationId> */
export const worktreePath = (dataDir: string, id: ConversationId): string => join(worktreeRoot(dataDir), String(id));

/** pinomad/<id>-<suffix>; the suffix keeps two data dirs on one repo from colliding on branch names. */
export const worktreeBranch = (id: ConversationId, suffix: string): string => `pinomad/${id}-${suffix}`;
export const branchSuffix = (): string => randomBytes(2).toString("hex");

/** A `cwd` matches the worktree record it sits under. */
export const checkoutAt = (
  checkouts: readonly WorktreeCheckout[] | undefined,
  cwd: string,
): WorktreeCheckout | undefined =>
  checkouts?.find((checkout) => cwd === checkout.path || cwd.startsWith(checkout.path + sep));

export interface RepoBase {
  /** Repository top level. */
  readonly repo: string;
  /** `projectPath` relative to `repo`, "" at the root. */
  readonly subdir: string;
  /** HEAD commit the conversation starts at. */
  readonly base: string;
}

/**
 * The repository a project dir belongs to, or undefined when it is not a git
 * work tree or has no commits yet — those conversations keep working in the
 * project dir itself.
 */
export async function gitBase(projectPath: string): Promise<RepoBase | undefined> {
  const top = await git(projectPath, ["rev-parse", "--show-toplevel"]).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );
  if (top === undefined) return undefined;
  // show-toplevel can print a symlinked path; project paths are realpath'd, so normalize the same way.
  const repo = await realpath(top).catch(() => top);
  const base = await git(repo, ["rev-parse", "--verify", "HEAD"]).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );
  if (base === undefined) return undefined;
  return { repo, subdir: relative(repo, projectPath), base };
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "PiNomad",
  GIT_AUTHOR_EMAIL: "pinomad@localhost",
  GIT_COMMITTER_NAME: "PiNomad",
  GIT_COMMITTER_EMAIL: "pinomad@localhost",
};

/**
 * One commit capturing the full working tree of `sourceDir` (a worktree or repo
 * root): modified, deleted, and untracked-but-not-ignored files. A scratch
 * index file keeps the user's real index untouched. commit-tree needs an
 * identity and users may have none configured, so one is injected for it.
 */
export async function snapshotOf(sourceDir: string): Promise<{ base: string; snapshot: string }> {
  const indexFile = join(tmpdir(), `pinomad-index-${randomBytes(8).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const { stdout: head } = await git(sourceDir, ["rev-parse", "--verify", "HEAD"], env);
    const base = head.trim();
    await git(sourceDir, ["read-tree", base], env);
    // `add -A` without a pathspec covers the whole working tree.
    await git(sourceDir, ["add", "-A"], env);
    const { stdout: tree } = await git(sourceDir, ["write-tree"], env);
    const { stdout: commit } = await git(
      sourceDir,
      ["commit-tree", tree.trim(), "-p", base, "-m", "pinomad fork snapshot"],
      { ...env, ...SNAPSHOT_IDENTITY },
    );
    return { base, snapshot: commit.trim() };
  } finally {
    await rm(indexFile, { force: true });
  }
}

/** Git mutations on one repo serialize here: worktree add/remove take .git lock files. */
const repoLocks = new Map<string, Promise<void>>();

function locked<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const next = (repoLocks.get(repo) ?? Promise.resolve()).then(work, work);
  const settled = next.then(
    () => {},
    () => {},
  );
  repoLocks.set(repo, settled);
  void settled.then(() => {
    if (repoLocks.get(repo) === settled) repoLocks.delete(repo);
  });
  return next;
}

/** A worktree directory is real when it holds git's `.git` file, not merely when the path exists. */
export const worktreeExists = async (path: string): Promise<boolean> =>
  stat(join(path, ".git")).then(
    () => true,
    () => false,
  );

/**
 * Create the directory for a record that lacks one: an existing branch is
 * reused (committed work survives `rm -rf` and crashes between commit and
 * first use); a new branch starts at `base`, overlaid with the fork snapshot
 * so the parent's uncommitted and untracked state lands as pending changes.
 */
export async function ensureWorktree(record: WorktreeCheckout): Promise<void> {
  await locked(record.repo, async () => {
    if (await worktreeExists(record.path)) return;
    // Drop registrations whose directories are gone before re-adding a path.
    await git(record.repo, ["worktree", "prune"]);
    const branchExists = await git(record.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`]).then(
      () => true,
      () => false,
    );
    if (branchExists) {
      await git(record.repo, ["worktree", "add", record.path, record.branch]);
      return;
    }
    await git(record.repo, ["worktree", "add", "-b", record.branch, record.path, record.base]);
    if (record.snapshot !== undefined) {
      await git(record.path, ["read-tree", "-u", "--reset", record.snapshot]);
      // HEAD/index back at base: the snapshot lands purely as working-tree state.
      await git(record.path, ["reset", "-q"]);
    }
  });
}

/**
 * Remove a worktree's directory; the branch is never deleted (it may be
 * unmerged). No --force: a dirty tree is refused, and the refusal reason is
 * returned so the caller can warn. Returns undefined when removed or absent.
 */
export async function removeWorktree(record: WorktreeCheckout): Promise<string | undefined> {
  return await locked(record.repo, async () => {
    if (!(await worktreeExists(record.path))) return undefined;
    return await git(record.repo, ["worktree", "remove", record.path]).then(
      () => undefined,
      (error: unknown) => reasonOf(error),
    );
  });
}

function reasonOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : error instanceof Error ? error.message : String(error);
  return text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? text;
}

/**
 * Everything `dir` differs from `base` as a unified patch: commits made since,
 * uncommitted edits, deletions, and untracked-but-not-ignored files — staged
 * through a scratch index so the user's real index never moves.
 */
export async function changesOf(dir: string, base: string, maxBytes = 1024 * 1024): Promise<{
  readonly base: string;
  readonly patch: string;
  readonly truncated: boolean;
}> {
  const indexFile = join(tmpdir(), `pinomad-index-${randomBytes(8).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(dir, ["read-tree", "HEAD"], env);
    await git(dir, ["add", "-A"], env);
    const { stdout } = await git(dir, ["diff", "--cached", "--no-color", "--find-renames", base], env);
    if (Buffer.byteLength(stdout) <= maxBytes) return { base, patch: stdout, truncated: false };
    // Cut at a line boundary so the patch stays parseable as far as it goes.
    const cut = stdout.slice(0, maxBytes);
    const patch = cut.slice(0, cut.lastIndexOf("\n") + 1);
    return { base, patch, truncated: true };
  } finally {
    await rm(indexFile, { force: true });
  }
}
