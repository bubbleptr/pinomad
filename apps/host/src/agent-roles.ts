// Named agents (ADR-0023 §1-3): one `<name>.md` per agent under `<dataDir>/agents`.
// The directory is watched so a hand edit republishes promptly — unlike
// settings.json, users are expected to write these files themselves — and the
// store's own writes round through the same load path so `value` is always what
// the disk says. A bad file lands in `problems`, never in `roles`, and never
// kills the watcher.
import { randomBytes } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  agentNameProblem,
  agentRoleProblem,
  type AgentRole,
  type AgentRoleProblem,
  type AgentRoles,
} from "@pinomad/protocol/agents.ts";
import { Published, sameList, type HostValue } from "./host-value.ts";

/** The `agents` stream's source plus the store the create/update/delete calls write through. */
export interface AgentRoleStore extends HostValue<AgentRoles> {
  create(role: AgentRole): Promise<void>;
  update(role: AgentRole): Promise<void>;
  remove(name: string): Promise<void>;
  close(): void;
}

/** Frontmatter fields this format defines — anything else is an error, so a copied Claude Code file isn't silently half-applied. */
const KNOWN_FIELDS = new Set(["description", "model", "thinkingLevel"]);

async function load(dir: string): Promise<AgentRoles> {
  const roles: AgentRole[] = [];
  const problems: AgentRoleProblem[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = entry.name;
    const name = file.slice(0, -".md".length);
    const problem = (reason: string): void => void problems.push({ file, reason });
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(await readFile(join(dir, file), "utf8"));
    } catch (error) {
      problem(`Couldn't parse the file: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // parseFrontmatter accepts any YAML node; a string or list is malformed input here.
    if (typeof parsed.frontmatter !== "object" || parsed.frontmatter === null || Array.isArray(parsed.frontmatter)) {
      problem("Frontmatter must be a record of fields");
      continue;
    }
    const unknown = Object.keys(parsed.frontmatter).find((key) => !KNOWN_FIELDS.has(key));
    if (unknown !== undefined) {
      problem(`Unknown field "${unknown}"`);
      continue;
    }
    const bad = Object.entries(parsed.frontmatter).find(([, value]) => typeof value !== "string");
    if (bad !== undefined) {
      problem(`Field "${bad[0]}" must be a string`);
      continue;
    }
    const frontmatter = parsed.frontmatter as { description?: string; model?: string; thinkingLevel?: string };
    const role: AgentRole = {
      name,
      description: frontmatter.description ?? "",
      ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
      // isThinkingLevel is checked inside agentRoleProblem; the raw string goes
      // through so a mistyped level reports that, not a silent drop.
      ...(frontmatter.thinkingLevel === undefined ? {} : { thinkingLevel: frontmatter.thinkingLevel as AgentRole["thinkingLevel"] }),
      prompt: parsed.body.trim(),
    };
    const reason = agentRoleProblem(role);
    if (reason !== undefined) {
      problem(reason);
      continue;
    }
    roles.push(role);
  }
  roles.sort((a, b) => a.name.localeCompare(b.name));
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { roles, problems };
}

/** JSON strings are valid YAML double-quoted scalars — no YAML dependency needed to write. */
function serialize(role: AgentRole): string {
  const fields = [
    `description: ${JSON.stringify(role.description)}`,
    ...(role.model === undefined ? [] : [`model: ${JSON.stringify(role.model)}`]),
    ...(role.thinkingLevel === undefined ? [] : [`thinkingLevel: ${JSON.stringify(role.thinkingLevel)}`]),
  ];
  return `---\n${fields.join("\n")}\n---\n\n${role.prompt}\n`;
}

const sameRole = (a: AgentRole, b: AgentRole): boolean =>
  a.name === b.name
  && a.description === b.description
  && a.model === b.model
  && a.thinkingLevel === b.thinkingLevel
  && a.prompt === b.prompt;

const sameProblem = (a: AgentRoleProblem, b: AgentRoleProblem): boolean => a.file === b.file && a.reason === b.reason;

/**
 * Watch `dir` (created if absent) for `*.md` agent files. `debounceMs` groups
 * a burst of file events into one reload; `rescanMs` is a safety scan because
 * OS watcher events can be dropped and, on macOS, the OS stream starts after
 * watch() returns. Tests can shorten both. No locking: the last write wins.
 */
export async function openAgentRoles(options: {
  dir: string;
  debounceMs?: number;
  rescanMs?: number;
}): Promise<AgentRoleStore> {
  const dir = options.dir;
  await mkdir(dir, { recursive: true });
  const debounceMs = options.debounceMs ?? 150;
  const rescanMs = options.rescanMs ?? 1000;
  const published = new Published<AgentRoles>(
    { roles: [], problems: [] },
    (a, b) => sameList(a.roles, b.roles, sameRole) && sameList(a.problems, b.problems, sameProblem),
  );

  let closed = false;
  let reported = false;
  let timer: NodeJS.Timeout | undefined;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();

  const loadOnce = async (): Promise<void> => {
    try {
      published.set(await load(dir));
      reported = false;
    } catch (error) {
      // A load failure keeps the last value; a bad or half-written dir must not kill the watcher.
      if (!reported) console.error(`agent-roles reload failed: ${error instanceof Error ? error.message : String(error)}`);
      reported = true;
    }
  };

  /**
   * Serialize scans and coalesce requests. Racing loads could publish an older
   * snapshot last; a request made during a scan must queue one more scan after it.
   */
  const reload = (): Promise<void> => {
    if (closed) return Promise.resolve();
    queued = true;
    chain = chain.then(async () => {
      if (!queued || closed) return;
      queued = false;
      await loadOnce();
    });
    return chain;
  };

  // Watch before the first scan: a file written while the directory is being
  // read is either in that snapshot or has already produced an event. macOS can
  // still lose one while its FSEvents stream starts; the safety scan covers it.
  // Every event is only a signal to rescan — the changed name is ignored so
  // create, write, rename and atomic replace all take the same path.
  const watcher: FSWatcher = watch(dir, () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), debounceMs);
  });
  watcher.on("error", (error) => {
    if (!reported) console.error(`agent-roles watch failed: ${error.message}`);
    reported = true;
    // Node closes a watcher that errors; read once now and let the safety scan
    // cover later changes.
    void reload();
  });

  await reload();
  const rescan = setInterval(() => void reload(), rescanMs);

  // Existence checks and writes interleave: without this chain two concurrent
  // creates of the same name both see the file absent and the second silently
  // overwrites the first. Agent edits are rare, so one store-wide chain does.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const run = pending.then(operation, operation);
    // The chain must settle on failure too; a rejected op hands off to the next.
    pending = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const write = async (role: AgentRole, mustExist: boolean): Promise<void> => {
    const problem = agentRoleProblem(role);
    if (problem !== undefined) throw new Error(problem);
    await enqueue(async () => {
      const target = join(dir, `${role.name}.md`);
      const exists = existsSync(target);
      if (mustExist && !exists) throw new Error(`No such agent: "${role.name}"`);
      if (!mustExist && exists) throw new Error(`Agent "${role.name}" already exists`);
      // Temp + rename: a reader never sees a half-written file. A unique name
      // per write keeps a concurrent op's temp apart (not *.md, so the loader
      // ignores it either way).
      const temp = join(dir, `.${role.name}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(temp, serialize(role));
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      // Publish now; the watcher would, after its debounce.
      await reload();
    });
  };

  return {
    get value() {
      return published.value;
    },
    subscribe: (listener) => published.subscribe(listener),
    create: (role) => write(role, false),
    update: (role) => write(role, true),
    async remove(name) {
      // The name joins into a path: validate it before touching the filesystem,
      // otherwise "../outside" deletes a file outside the agents directory.
      const problem = agentNameProblem(name);
      if (problem !== undefined) throw new Error(problem);
      await enqueue(async () => {
        const target = join(dir, `${name}.md`);
        if (!existsSync(target)) throw new Error(`No such agent: "${name}"`);
        await rm(target);
        await reload();
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(rescan);
      watcher.close();
    },
  };
}
