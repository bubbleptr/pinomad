// `listSkills` (issue #143): the `$`-mentionable skills a scope's system
// prompt carries. One loader feeds both call sites — the prompt section and
// the gateway call — so the menu can never offer a name the model would not
// see. Read-only: answers from the filesystem or git, never materializes
// checkouts, never writes durable state.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Harness } from "@earendil-works/pi-durable";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillListing, SkillScope } from "@pinomad/protocol/organization.ts";
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

/** One entry directory's skills, tagged with the source PiNomad records for it. */
function entrySkills(dir: string, source: "project" | "user", agentsHome: string): ScopedSkill[] {
  // One entry per loadSkills call keeps upstream's within-entry realpath and
  // name dedupe; the merge below owns cross-entry precedence.
  const { skills } = loadSkills({ cwd: dir, agentDir: agentsHome, includeDefaults: false, skillPaths: [dir] });
  return skills.map((skill) => ({ skill, source }));
}

/**
 * Merge entry lists project-first, dedupe by name, then drop
 * `disable-model-invocation` entries. The order matters: a disabled project
 * skill must still shadow the user's same-named one (issue #143).
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
  return merged.filter((scoped) => !scoped.skill.disableModelInvocation);
}

/**
 * The skills a system prompt rooted at `root` would carry — the shared
 * loader behind the context extension's skills section: the project entry
 * (`<root>/.agents/skills`) merged over the user entry (`<agentsHome>/skills`),
 * or the user entry alone when there is no root (a Chat draft).
 */
export function scopedSkills(root: string | undefined, agentsHome: string): ScopedSkill[] {
  return mergeSkills([
    ...(root === undefined ? [] : [entrySkills(join(root, ".agents", "skills"), "project", agentsHome)]),
    entrySkills(join(agentsHome, "skills"), "user", agentsHome),
  ]);
}

/**
 * The committed `.agents/skills` paths under `root`, project-relative — what
 * a fresh worktree would carry (ADR-0010). `null` when no worktree could
 * check out (the root is not in a work tree, or has no commits yet) — the
 * caller treats that scope like `"project"`.
 */
async function committedSkillFiles(root: string): Promise<Set<string> | null> {
  if (!(await inWorkTree(root)) || !(await hasHead(root))) return null;
  // execFile, no shell; `-C` scopes the listing to the project's own
  // subdirectory and the output is project-relative.
  const { stdout } = await exec("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ".agents/skills"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return new Set(stdout.split("\0").filter((path) => path !== ""));
}

/**
 * One scope's listing: the project entry merged over the user entry — for
 * `head` keeping only project skills whose file is committed at HEAD (a
 * fresh worktree would not have the uncommitted ones). The name check runs
 * last: names the composer cannot type stay in the prompt but not in the
 * `$` menu.
 */
export async function enumerateSkills(
  root: string | undefined,
  mode: RootMode,
  agentsHome: string,
): Promise<SkillListing> {
  let project: ScopedSkill[] = [];
  if (root !== undefined) {
    project = entrySkills(join(root, ".agents", "skills"), "project", agentsHome);
    if (mode === "head") {
      const committed = await committedSkillFiles(root);
      if (committed !== null) {
        project = project.filter((scoped) =>
          committed.has(relative(root, scoped.skill.filePath).split(sep).join("/")),
        );
      }
    }
  }
  const merged = mergeSkills([project, entrySkills(join(agentsHome, "skills"), "user", agentsHome)]);
  return {
    skills: merged
      .filter((scoped) => invocableSkillName(scoped.skill.name))
      .map((scoped) => ({ name: scoped.skill.name, description: scoped.skill.description, source: scoped.source })),
  };
}

// The composer's typing burst shares one scan per scope; the cache only
// needs to outlive a few seconds of menu use.
const CACHE_TTL_MS = 3_000;
const MAX_CACHED_SCOPES = 64;

/** The scope listing a resolved `(root, mode)` yields; `root: undefined` reads the user entry alone (a Chat draft). */
export type SkillLister = (root: string | undefined, mode: RootMode) => Promise<SkillListing>;

/**
 * Share scans across callers: concurrent requests for the same root+mode ride
 * one listing, and the result is cached for `ttlMs`. Failures are not cached.
 * Unlike `createCandidateLister` there is no concurrency bound — a listing is
 * a bounded `.agents/skills` scan plus at most one small `git ls-tree`.
 */
export function createSkillLister(
  enumerate: (root: string | undefined, mode: RootMode) => Promise<SkillListing>,
  options: { readonly now?: () => number; readonly ttlMs?: number; readonly maxCached?: number } = {},
): SkillLister {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const maxCached = options.maxCached ?? MAX_CACHED_SCOPES;
  const cache = new Map<string, { value: SkillListing; expiresAt: number }>();
  const inflight = new Map<string, Promise<SkillListing>>();
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
 * The `listSkills` call: resolve the scope to a `(root, mode)` and list it.
 * A conversation's root is its persisted AgentState cwd — a Chat's is under
 * `<dataDir>/chats`, so its project entry is empty and only user skills list.
 * A missing cwd is a business error: never ensureWorktree, never fall back to
 * the project directory (same rule as listFiles, issue #138).
 */
export async function listSkills(
  harness: Harness,
  lister: SkillLister,
  scope: SkillScope,
  context: Context,
): Promise<SkillListing> {
  if (scope.kind === "chat") return lister(undefined, "live");
  let root: string;
  let mode: RootMode = "live";
  if (scope.kind === "conversation") {
    const agent = await harness.snapshot(AgentDoc, scope.conversationId, context);
    if (agent === undefined) throw new Error(`Conversation ${scope.conversationId} does not exist`);
    const cwd = agent.cwd;
    if (cwd === undefined) throw new Error(`Conversation ${scope.conversationId} has no checkout`);
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
    const info = await stat(normalized).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new Error(`Not a directory: ${normalized}`);
    }
    root = normalized;
    mode = scope.checkout === "worktree" ? "head" : "live";
  }
  return lister(root, mode);
}
