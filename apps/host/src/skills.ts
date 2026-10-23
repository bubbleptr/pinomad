// `listSkills` (issue #143): the `$`-mentionable skills of a scope. One
// loader feeds every call site — the prompt section, the gateway call, and
// `$name` expansion (ADR-0028) — so the menu never offers a name the host
// would not expand. `disable-model-invocation` skills list and expand; only
// the prompt section leaves them out. Read-only: answers from the filesystem
// or git, never materializes checkouts, never writes durable state.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Harness } from "@earendil-works/pi-durable";
import { loadSkills, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillListing, SkillScope } from "@pinomad/protocol/organization.ts";
import { checkoutAt, worktreeSettled } from "./checkout.ts";
import { type RootMode, hasHead, inWorkTree } from "./files.ts";
import { IndexDoc } from "./organization.ts";

const exec = promisify(execFile);

/**
 * A skill plus which entry directory supplied it. The wire `source` records
 * the entry PiNomad loaded it under — not upstream's `source`, which a
 * `skillPaths` load would report as `path` (issue #143).
 */
export interface ScopedSkill {
  readonly skill: Skill;
  readonly source: "project" | "user";
}

/** Upstream's `validateName` (not exported): the names a `$` mention can carry. */
export function invocableSkillName(name: string): boolean {
  return (
    name.length <= 64
    && /^[a-z0-9-]+$/.test(name)
    && !name.startsWith("-")
    && !name.endsWith("-")
    && !name.includes("--")
  );
}

// One host process logs each finding once: the prompt reloads on every model
// request and the $ menu rescans often, so a broken skill must not flood the log.
const reportedDiagnostics = new Set<string>();

function reportDiagnostics(diagnostics: readonly ResourceDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    // The key is the finding (path + message), not which load produced it.
    const key = `${diagnostic.path ?? ""}\0${diagnostic.message}`;
    if (reportedDiagnostics.has(key)) continue;
    reportedDiagnostics.add(key);
    console.error(JSON.stringify({
      event: "skill",
      level: diagnostic.type === "error" ? "error" : "warning",
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      message: diagnostic.message,
    }));
  }
}

/** One entry directory's skills, tagged with the source PiNomad records for it. */
function entrySkills(dir: string, source: "project" | "user", agentsHome: string): ScopedSkill[] {
  // Most ancestors have no skills directory; loadSkills would report each one
  // as a missing-path warning on every request, which is noise, not a finding.
  if (!existsSync(dir)) return [];
  // One entry per loadSkills call keeps upstream's within-entry realpath and
  // name dedupe; the merge below owns cross-entry precedence.
  const { skills, diagnostics } = loadSkills({ cwd: dir, agentDir: agentsHome, includeDefaults: false, skillPaths: [dir] });
  reportDiagnostics(diagnostics);
  return skills.map((skill) => ({ skill, source }));
}

/**
 * The project entry directories from `root` up to the git root, nearest
 * first. A `.git` file counts (worktrees and submodules), and the walk stops
 * at the git root: `<agentsHome>/skills` is the user entry, never a project
 * ancestor. Outside git only `root` itself is a project layer.
 */
function projectSkillLayers(root: string): { readonly dirs: readonly string[]; readonly gitRoot?: string } {
  const start = resolve(root);
  const dirs = [start];
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return { dirs, gitRoot: dir };
    const parent = dirname(dir);
    if (parent === dir) return { dirs: [start] };
    dir = parent;
    dirs.push(dir);
  }
}

/** Every layer's project entry, flattened nearest-first. */
function projectSkills(dirs: readonly string[], agentsHome: string): ScopedSkill[] {
  return dirs.flatMap((dir) => entrySkills(join(dir, ".agents", "skills"), "project", agentsHome));
}

/**
 * Merge entry lists project-first and dedupe by name. A
 * `disable-model-invocation` skill stays in: it still shadows the user's
 * same-named one (issue #143), the user can still `$`-mention it, and the
 * prompt's `formatSkillsForPrompt` drops it on its own (ADR-0028).
 */
export function mergeSkills(entries: readonly (readonly ScopedSkill[])[]): ScopedSkill[] {
  const seen = new Set<string>();
  const merged: ScopedSkill[] = [];
  for (const entry of entries) {
    for (const scoped of entry) {
      if (seen.has(scoped.skill.name)) continue;
      seen.add(scoped.skill.name);
      merged.push(scoped);
    }
  }
  return merged;
}

/**
 * The skills a system prompt rooted at `root` would carry — the shared
 * loader behind the context extension's skills section: every project layer
 * from `root` up to the git root, nearest first, merged over the user entry
 * (`<agentsHome>/skills`); or the user entry alone when there is no root (a
 * Chat draft).
 */
export function scopedSkills(root: string | undefined, agentsHome: string): ScopedSkill[] {
  const project = root === undefined ? [] : projectSkills(projectSkillLayers(root).dirs, agentsHome);
  return mergeSkills([project, entrySkills(join(agentsHome, "skills"), "user", agentsHome)]);
}

/**
 * The committed `.agents/skills` paths under the project's git root,
 * root-relative — what a fresh worktree would carry (ADR-0010). One ls-tree
 * covers every layer's pathspec. `null` when no worktree could check out (the
 * root is not in a work tree, or has no commits yet) — the caller treats that
 * scope like `"project"`.
 */
async function committedSkillFiles(gitRoot: string, layers: readonly string[]): Promise<Set<string> | null> {
  if (!(await inWorkTree(gitRoot)) || !(await hasHead(gitRoot))) return null;
  // execFile, no shell; `-C gitRoot` plus --full-name keeps output relative to
  // the repository top level, so every layer's file compares the same way.
  const pathspecs = layers.map((dir) => {
    const rel = relative(gitRoot, dir).split(sep).join("/");
    return rel === "" ? ".agents/skills" : `${rel}/.agents/skills`;
  });
  const { stdout } = await exec(
    "git",
    ["-C", gitRoot, "ls-tree", "-r", "-z", "--full-name", "--name-only", "HEAD", "--", ...pathspecs],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return new Set(stdout.split("\0").filter((path) => path !== ""));
}

/** One `$`-mentionable skill of a scope: the wire listing's fields plus where its file is. */
export interface ListedSkill {
  readonly name: string;
  readonly description: string;
  readonly source: "project" | "user";
  readonly filePath: string;
  readonly baseDir: string;
}

/**
 * One scope's listing: every project layer merged over the user entry — for
 * `head` keeping only project skills whose file is committed at HEAD (a
 * fresh worktree would not have the uncommitted ones). The name check runs
 * last: names the composer cannot type stay in the prompt but not in the
 * `$` menu.
 */
export async function enumerateSkills(
  root: string | undefined,
  mode: RootMode,
  agentsHome: string,
): Promise<readonly ListedSkill[]> {
  let project: ScopedSkill[] = [];
  if (root !== undefined) {
    const layers = projectSkillLayers(root);
    project = projectSkills(layers.dirs, agentsHome);
    const gitRoot = layers.gitRoot;
    if (mode === "head" && gitRoot !== undefined) {
      const committed = await committedSkillFiles(gitRoot, layers.dirs);
      if (committed !== null) {
        project = project.filter((scoped) =>
          committed.has(relative(gitRoot, scoped.skill.filePath).split(sep).join("/")),
        );
      }
    }
  }
  const merged = mergeSkills([project, entrySkills(join(agentsHome, "skills"), "user", agentsHome)]);
  return merged
    .filter((scoped) => invocableSkillName(scoped.skill.name))
    .map(({ skill, source }) => ({
      name: skill.name,
      description: skill.description,
      source,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
    }));
}

// The composer's typing burst shares one scan per scope; the cache only
// needs to outlive a few seconds of menu use.
const CACHE_TTL_MS = 3_000;
const MAX_CACHED_SCOPES = 64;

/** The scope listing a resolved `(root, mode)` yields; `root: undefined` reads the user entry alone (a Chat draft). */
export type SkillLister = (root: string | undefined, mode: RootMode) => Promise<readonly ListedSkill[]>;

/**
 * Share scans across callers: concurrent requests for the same root+mode ride
 * one listing, and the result is cached for `ttlMs`. Failures are not cached.
 * Unlike `createCandidateLister` there is no concurrency bound — a listing is
 * a bounded `.agents/skills` scan plus at most one small `git ls-tree`.
 */
export function createSkillLister(
  enumerate: SkillLister,
  options: { readonly now?: () => number; readonly ttlMs?: number; readonly maxCached?: number } = {},
): SkillLister {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const maxCached = options.maxCached ?? MAX_CACHED_SCOPES;
  const cache = new Map<string, { value: readonly ListedSkill[]; expiresAt: number }>();
  const inflight = new Map<string, Promise<readonly ListedSkill[]>>();
  return (root, mode) => {
    // A conversation cwd or a project path is never "" — the empty root is
    // the Chat draft's user-only listing.
    const key = `${mode}${root ?? ""}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (hit.expiresAt > now()) return Promise.resolve(hit.value);
      cache.delete(key);
    }
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const scan = enumerate(root, mode);
    inflight.set(key, scan);
    void scan.then(
      (value) => {
        const at = now();
        // Expired entries are dead weight — sweep on write, and bound the map
        // so a long-lived host can't accumulate one listing per checkout.
        for (const [cached, entry] of cache) {
          if (entry.expiresAt <= at) cache.delete(cached);
        }
        while (cache.size >= maxCached) cache.delete(cache.keys().next().value!);
        cache.set(key, { value, expiresAt: at + ttlMs });
      },
      () => {},
    );
    return scan.finally(() => inflight.delete(key));
  };
}

/**
 * A scope's skills with their files: resolve the scope to a `(root, mode)`
 * and list it — what the `listSkills` call answers and `$name` expansion
 * looks names up in.
 * A conversation's root is its persisted AgentState cwd — a Chat's is under
 * `<dataDir>/chats`, so its project entry is empty and only user skills list.
 * A missing cwd is a business error: never ensureWorktree, never fall back to
 * the project directory (same rule as listFiles, issue #138). A worktree
 * still being checked out is waited for, never listed half-written.
 */
export async function scopeSkills(
  harness: Harness,
  lister: SkillLister,
  scope: SkillScope,
  context: Context,
): Promise<readonly ListedSkill[]> {
  if (scope.kind === "chat") return lister(undefined, "live");
  let root: string;
  let mode: RootMode = "live";
  if (scope.kind === "conversation") {
    const agent = await harness.snapshot(AgentDoc, scope.conversationId, context);
    if (agent === undefined) throw new Error(`Conversation ${scope.conversationId} does not exist`);
    const cwd = agent.cwd;
    if (cwd === undefined) throw new Error(`Conversation ${scope.conversationId} has no checkout`);
    const record = checkoutAt((await harness.snapshot(IndexDoc, context))?.checkouts, cwd);
    const ready = record === undefined || (await worktreeSettled(record));
    const info = ready ? await stat(cwd).catch(() => undefined) : undefined;
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
    const info = await stat(normalized).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new Error(`Not a directory: ${normalized}`);
    }
    root = normalized;
    mode = scope.checkout === "worktree" ? "head" : "live";
  }
  return lister(root, mode);
}

/** The `listSkills` call: the scope's skills without their file paths. */
export async function listSkills(
  harness: Harness,
  lister: SkillLister,
  scope: SkillScope,
  context: Context,
): Promise<SkillListing> {
  const skills = await scopeSkills(harness, lister, scope, context);
  return { skills: skills.map(({ name, description, source }) => ({ name, description, source })) };
}
