// `listFiles` (issue #138): file candidates under a scope's root for the
// composer's `@./path` completion. Read-only: it answers from the filesystem
// or git, never materializes checkouts, and never writes durable state.
// Enumeration is bounded (time, output bytes, entry count) and the results
// are cached briefly per root so a burst of keystroke queries shares one scan.
import { spawn } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Harness } from "@earendil-works/pi-durable";
import type { FileListing, FileScope } from "@pinomad/protocol/organization.ts";
import { IndexDoc } from "./organization.ts";

/** One enumeration's output: the candidate paths it found, and whether any bound cut it short. */
export interface FileCandidates {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/** Which kind of root content to enumerate: the live working directory, or the committed HEAD tree. */
export type RootMode = "live" | "head";

/** The enumerator a scope's root is handed to — the gateway's shared, cached instance. */
export type FileLister = (root: string, mode: RootMode) => Promise<FileCandidates>;

// The composer's debounce makes a burst of queries share one scan; the cache
// only needs to outlive a few seconds of typing.
const CACHE_TTL_MS = 3_000;
const MAX_CONCURRENT_SCANS = 4;
// Per-scan bounds: a slow or huge tree is cut, never queued forever.
const SCAN_BUDGET_MS = 5_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20_000;
const MAX_RESULTS = 50;

/** Paths that cannot complete anyway: `@./` completion inserts plain text, so whitespace/control/backtick names are unusable. */
const UNUSABLE_PATH = /[\s`\x00-\x1f\x7f-\x9f]/;

export interface ScanLimits {
  /** Injected for deterministic tests. */
  readonly now?: () => number;
  readonly budgetMs?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

/**
 * Share and bound enumeration: concurrent callers of the same root ride one
 * scan, results are cached for `ttlMs`, and at most `maxConcurrent` scans run
 * at once — the rest wait for a slot. Failures are not cached.
 */
export function createCandidateLister(
  enumerate: (root: string, mode: RootMode) => Promise<FileCandidates>,
  options: { readonly now?: () => number; readonly ttlMs?: number; readonly maxConcurrent?: number } = {},
): FileLister {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SCANS;
  const cache = new Map<string, { value: FileCandidates; expiresAt: number }>();
  const inflight = new Map<string, Promise<FileCandidates>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  return (root, mode) => {
    const key = `${mode}${root}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const scan = (async () => {
      if (running >= maxConcurrent) await new Promise<void>((release) => waiting.push(release));
      running += 1;
      try {
        return await enumerate(root, mode);
      } finally {
        running -= 1;
        waiting.shift()?.();
      }
    })();
    inflight.set(key, scan);
    void scan.then(
      (value) => cache.set(key, { value, expiresAt: now() + ttlMs }),
      () => {},
    );
    return scan.finally(() => inflight.delete(key));
  };
}

/** `git` for one enumeration: stdout is read to a byte cap, the process is killed at the deadline; either bound marks the scan truncated. */
function gitLines(
  cwd: string,
  args: readonly string[],
  limits: { readonly now: () => number; readonly deadline: number; readonly maxBytes: number },
): Promise<{ lines: string[]; truncated: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // execFile's 1 MiB default maxBuffer is the #176 trap — stream instead.
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const kill = (markTruncated: boolean) => {
      truncated ||= markTruncated;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(true), Math.max(0, limits.deadline - limits.now()));
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        rejectPromise(error);
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8");
      // Records are NUL-separated; a killed scan's last entry may be cut mid-path.
      const parts = output.split("\0");
      if (truncated) parts.pop();
      resolvePromise({ lines: parts.filter((part) => part !== ""), truncated });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        kill(true);
        return;
      }
      chunks.push(chunk);
      if (limits.now() > limits.deadline) kill(true);
    });
    child.on("error", (error) => finish(error));
    child.stderr.resume();
    child.on("close", (code) => {
      if (code === 0 || truncated) {
        finish(undefined);
      } else {
        finish(new Error(`git ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

/** Whether `root` sits inside a git working tree (worktree checkouts count; bare dirs do not). */
async function inWorkTree(root: string): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0 && out.trim() === "true"));
  });
}

/** Whether the repo `root` sits in has a committed HEAD — a fresh worktree needs one (ADR-0010). */
async function hasHead(root: string): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

/**
 * The working tree's files under `root`: `git ls-files` in the root lists
 * only paths below it (relative to it). Staged entries carry `mode sha
 * stage\tpath` — mode 160000 is a gitlink (submodule), dropped; untracked
 * entries print bare and an embedded repo appears as `dir/`. Paths deleted
 * from the working tree are subtracted through `ls-files --deleted`.
 */
async function gitWorkingFiles(
  root: string,
  limits: { readonly now: () => number; readonly deadline: number; readonly maxBytes: number },
): Promise<FileCandidates> {
  const listing = await gitLines(root, ["ls-files", "-z", "-s", "--cached", "--others", "--exclude-standard"], limits);
  const deleted = await gitLines(root, ["ls-files", "-z", "--deleted"], limits);
  const gone = new Set(deleted.lines);
  const files = new Set<string>();
  for (const line of listing.lines) {
    const tab = line.indexOf("\t");
    const path = tab === -1 ? line : line.slice(tab + 1);
    if (tab !== -1 && line.startsWith("160000 ")) continue;
    if (path === "" || path.endsWith("/") || gone.has(path)) continue;
    files.add(path);
  }
  return { files: [...files], truncated: listing.truncated || deleted.truncated };
}

/**
 * The committed tree under `root`: what a fresh worktree would hold — the
 * spec's `git ls-tree -r --name-only HEAD`, except modes are kept so gitlink
 * (submodule) entries drop like files-only output requires.
 */
async function gitHeadFiles(
  root: string,
  limits: { readonly now: () => number; readonly deadline: number; readonly maxBytes: number },
): Promise<FileCandidates> {
  const listing = await gitLines(root, ["ls-tree", "-r", "-z", "HEAD"], limits);
  const files: string[] = [];
  for (const line of listing.lines) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    // `mode type sha\tpath`; trees never appear under -r, commits are gitlinks.
    const kind = line.slice(0, tab).split(" ")[1];
    if (kind === "blob") files.push(line.slice(tab + 1));
  }
  return { files, truncated: listing.truncated };
}

/**
 * A plain directory: incremental `opendir` reads (never an unbounded readdir),
 * dot-directories and node_modules skipped, directory symlinks listed but not
 * followed — a symlink is always the entry, never resolved.
 */
async function walkFiles(
  root: string,
  limits: { readonly now: () => number; readonly deadline: number; readonly maxEntries: number },
): Promise<FileCandidates> {
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  const dirs: { dir: string; prefix: string }[] = [{ dir: root, prefix: "" }];
  while (dirs.length > 0) {
    if (limits.now() > limits.deadline) {
      truncated = true;
      break;
    }
    const { dir, prefix } = dirs.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch (error) {
      // The root must open — a missing one is the caller's error, not a
      // partial listing. A directory that vanished mid-scan counts as cut.
      if (prefix === "") throw error;
      truncated = true;
      continue;
    }
    for await (const entry of handle) {
      if (entries++ >= limits.maxEntries || limits.now() > limits.deadline) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ dir: join(dir, entry.name), prefix: `${prefix}${entry.name}/` });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(`${prefix}${entry.name}`);
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

/**
 * Enumerate the file candidates under `root`. `head` answers what a fresh
 * worktree would contain (committed files only); `live` answers the working
 * directory as it is. A git failure is an error — never a silent fallback to
 * a plain walk — but a non-git root (or one without commits, in `head`) is
 * exactly the spec's plain-directory case.
 */
export async function enumerateRoot(root: string, mode: RootMode, limits: ScanLimits = {}): Promise<FileCandidates> {
  const now = limits.now ?? Date.now;
  const bounded = {
    now,
    deadline: now() + (limits.budgetMs ?? SCAN_BUDGET_MS),
    maxBytes: limits.maxBytes ?? MAX_OUTPUT_BYTES,
    maxEntries: limits.maxEntries ?? MAX_WALK_ENTRIES,
  };
  if (!(await inWorkTree(root))) {
    return walkFiles(root, bounded);
  }
  // No commits → no worktree could check out (the same fallback as createConversation's project-dir path).
  if (mode === "head" && !(await hasHead(root))) {
    return walkFiles(root, bounded);
  }
  return mode === "head" ? gitHeadFiles(root, bounded) : gitWorkingFiles(root, bounded);
}

/**
 * Rank candidates for a query: case-insensitive filename-prefix, then
 * filename-contains, then path-contains; shorter paths first within a tier.
 * An empty query is every candidate in path order. At most 50.
 */
export function matchFiles(
  candidates: readonly string[],
  query: string,
  max: number = MAX_RESULTS,
): { files: string[]; truncated: boolean } {
  const usable = candidates.filter((path) => !UNUSABLE_PATH.test(path));
  if (query === "") {
    const sorted = [...usable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { files: sorted.slice(0, max), truncated: sorted.length > max };
  }
  const needle = query.toLowerCase();
  const tiers: string[][] = [[], [], []];
  for (const path of usable) {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const lower = path.toLowerCase();
    if (base.startsWith(needle)) tiers[0]!.push(path);
    else if (base.includes(needle)) tiers[1]!.push(path);
    else if (lower.includes(needle)) tiers[2]!.push(path);
  }
  const shorter = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  const matched = [...tiers[0]!.sort(shorter), ...tiers[1]!.sort(shorter), ...tiers[2]!.sort(shorter)];
  return { files: matched.slice(0, max), truncated: matched.length > max };
}

/**
 * The `listFiles` call: resolve the scope to a root, enumerate (cached per
 * root), match. A Chat conversation has no project files — an empty answer,
 * not an error.
 */
export async function listFiles(
  harness: Harness,
  dataDir: string,
  enumerate: FileLister,
  scope: FileScope,
  query: string,
  context: Context,
): Promise<FileListing> {
  let root: string;
  let mode: RootMode = "live";
  if (scope.kind === "conversation") {
    const agent = await harness.snapshot(AgentDoc, scope.conversationId, context);
    if (agent === undefined) throw new Error(`Conversation ${scope.conversationId} does not exist`);
    const cwd = agent.cwd;
    if (cwd === undefined) throw new Error(`Conversation ${scope.conversationId} has no checkout`);
    // Chats live under <dataDir>/chats — never a project checkout.
    if (cwd.startsWith(join(dataDir, "chats") + sep)) return { files: [], truncated: false };
    // The checkout must already exist: never ensureWorktree, never fall back
    // to the project directory (issue #138).
    const info = await stat(cwd).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new Error(`Conversation ${scope.conversationId}'s checkout is unavailable: ${cwd}`);
    }
    root = cwd;
  } else {
    const normalized = await realpath(resolve(scope.path)).catch(() => resolve(scope.path));
    const index = await harness.snapshot(IndexDoc, context);
    if (!index?.projects.some((project) => project.path === normalized)) {
      throw new Error(`Unknown project: ${scope.path}`);
    }
    // A registered path whose directory is gone is an error, not an empty listing.
    const info = await stat(normalized).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new Error(`Not a directory: ${normalized}`);
    }
    root = normalized;
    mode = scope.checkout === "worktree" ? "head" : "live";
  }
  const candidates = await enumerate(root, mode);
  const matched = matchFiles(candidates.files, query);
  return { files: matched.files, truncated: matched.truncated || candidates.truncated };
}
