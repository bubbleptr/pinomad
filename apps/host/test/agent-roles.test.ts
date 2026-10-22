import { writeFileSync, type FSWatcher } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRole, AgentRoles } from "@pinomad/protocol/agents.ts";
import { describe, expect, it, vi } from "vitest";
import { openAgentRoles, type AgentRoleStore } from "../src/agent-roles.ts";
import { tempDir, useCleanups } from "./support.ts";

const watcherSetup = vi.hoisted(() => ({
  beforeWatch: undefined as (() => void) | undefined,
  dropEvents: false,
}));

// Simulate the window between the first scan and a real OS watcher: the hook
// writes the file before watch() starts, so only a scan after arming can see it.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((...args: unknown[]) => {
      watcherSetup.beforeWatch?.();
      const watcher = Reflect.apply(actual.watch, actual, args) as FSWatcher;
      if (watcherSetup.dropEvents) watcher.close();
      return watcher;
    }) as typeof actual.watch,
  };
});

const defer = useCleanups();

async function openStore(
  dir: string,
  options: { debounceMs?: number; rescanMs?: number } = {},
): Promise<AgentRoleStore> {
  const store = await openAgentRoles({
    dir: join(dir, "agents"),
    debounceMs: options.debounceMs ?? 20,
    rescanMs: options.rescanMs,
  });
  defer(() => store.close());
  return store;
}

/** Resolve with the next published value, after `action` ran. */
function next(store: AgentRoleStore, predicate: (value: AgentRoles) => boolean, timeoutMs = 5000): Promise<AgentRoles> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`agent-roles condition not met within ${timeoutMs} ms`));
    }, timeoutMs);
    const check = (value: AgentRoles): void => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = store.subscribe(check);
    check(store.value);
  });
}

const writeRole = (dir: string, file: string, content: string) => writeFile(join(dir, "agents", file), content);

const VALID = `---\ndescription: "Reviews code changes"\n---\n\nLook for mistakes.\n`;

describe("agent-roles", () => {
  it("loads a valid file with its prompt trimmed", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "agents"), { recursive: true });
    await writeRole(dir.path, "reviewer.md", `---\ndescription: "Reviews code"\nmodel: "faux/faux-1"\nthinkingLevel: "high"\n---\n\n  Look for mistakes.\n\n`);
    const store = await openStore(dir.path);
    expect(store.value).toEqual({
      roles: [
        {
          name: "reviewer",
          description: "Reviews code",
          model: "faux/faux-1",
          thinkingLevel: "high",
          prompt: "Look for mistakes.",
        },
      ],
      problems: [],
    });
  });

  it("lists bad files as problems, not roles", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "agents"), { recursive: true });
    await writeRole(dir.path, "no-description.md", `---\nmodel: "faux/faux-1"\n---\n\nprompt\n`);
    await writeRole(dir.path, "Bad Name.md", VALID);
    await writeRole(dir.path, "unknown-field.md", `---\ndescription: "d"\ntools: ["bash"]\n---\n\nprompt\n`);
    await writeRole(dir.path, "non-string.md", `---\ndescription: 42\n---\n\nprompt\n`);
    await writeRole(dir.path, "good.md", VALID);
    const store = await openStore(dir.path);
    expect(store.value.roles.map((role) => role.name)).toEqual(["good"]);
    expect(store.value.problems).toEqual([
      { file: "Bad Name.md", reason: "Name must be lowercase letters, digits and hyphens (max 32)" },
      { file: "no-description.md", reason: "description is required" },
      { file: "non-string.md", reason: 'Field "description" must be a string' },
      { file: "unknown-field.md", reason: 'Unknown field "tools"' },
    ]);
  });

  it("reports an unparsable frontmatter and ignores other files and subdirectories", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "agents"), { recursive: true });
    await writeRole(dir.path, "broken.md", `---\ndescription: [unterminated\n---\n\nbody\n`);
    await writeRole(dir.path, "note.txt", `---\ndescription: "not an agent"\n---\n\nnope\n`);
    await mkdir(join(dir.path, "agents", "nested"), { recursive: true });
    await writeFile(join(dir.path, "agents", "nested", "inner.md"), VALID);
    const store = await openStore(dir.path);
    expect(store.value.roles).toEqual([]);
    expect(store.value.problems).toHaveLength(1);
    expect(store.value.problems[0]!.file).toBe("broken.md");
    expect(store.value.problems[0]!.reason).toContain("Couldn't parse");
  });

  it("round-trips a created role through load, including tricky strings", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    const role: AgentRole = {
      name: "picky",
      description: 'Says "hi": uses # tags\nand a second line',
      model: "faux/faux-1",
      thinkingLevel: "low",
      prompt: "Body with ---\n---\na divider inside",
    };
    await store.create(role);
    expect(store.value.roles).toEqual([role]);
    // The file on disk parses back to the same role — JSON scalars round-trip through YAML.
    const text = await readFile(join(dir.path, "agents", "picky.md"), "utf8");
    expect(text).toContain("description: ");
    expect(store.value.problems).toEqual([]);
  });

  it("refuses create on an existing file and update on a missing one, writing nothing", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    const role: AgentRole = { name: "reviewer", description: "Reviews", prompt: "Look." };
    await store.create(role);
    await expect(store.create(role)).rejects.toThrow('Agent "reviewer" already exists');
    expect(await readFile(join(dir.path, "agents", "reviewer.md"), "utf8")).toBe(serializeExpectation());
    await expect(store.update({ name: "missing", description: "d", prompt: "p" })).rejects.toThrow('No such agent: "missing"');
    await expect(store.remove("missing")).rejects.toThrow('No such agent: "missing"');
    expect(store.value.roles.map((each) => each.name)).toEqual(["reviewer"]);
  });

  it("fixes an invalid file with update and deletes with remove", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "agents"), { recursive: true });
    await writeRole(dir.path, "broken.md", `---\ntools: ["bash"]\n---\n\nx\n`);
    const store = await openStore(dir.path);
    expect(store.value.problems).toHaveLength(1);
    await store.update({ name: "broken", description: "Fixed now", prompt: "New prompt" });
    expect(store.value).toEqual({
      roles: [{ name: "broken", description: "Fixed now", prompt: "New prompt" }],
      problems: [],
    });
    await store.remove("broken");
    expect(store.value).toEqual({ roles: [], problems: [] });
  });

  it("publishes a hand-written file after the watcher fires", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    const arrived = next(store, (value) => value.roles.some((role) => role.name === "by-hand"));
    await writeRole(dir.path, "by-hand.md", VALID);
    const value = await arrived;
    expect(value.roles[0]).toMatchObject({ name: "by-hand", description: "Reviews code changes", prompt: "Look for mistakes." });
  });

  it("does not lose a file written while the watcher is being set up", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    watcherSetup.beforeWatch = () => writeFileSync(join(dir.path, "agents", "by-hand.md"), VALID);
    try {
      const store = await openStore(dir.path);
      expect(store.value.roles.map((role) => role.name)).toEqual(["by-hand"]);
    } finally {
      watcherSetup.beforeWatch = undefined;
    }
  });

  it("republishes when the watcher misses an event", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    watcherSetup.dropEvents = true;
    try {
      const store = await openStore(dir.path, { rescanMs: 25 });
      const arrived = next(store, (value) => value.roles.some((role) => role.name === "by-hand"));
      await writeRole(dir.path, "by-hand.md", VALID);
      await arrived;
    } finally {
      watcherSetup.dropEvents = false;
    }
  });
});

function serializeExpectation(): string {
  return `---\ndescription: "Reviews"\n---\n\nLook.\n`;
}

describe("agent-roles safety", () => {
  it("serializes concurrent writes: a second create of the same name loses", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    const a: AgentRole = { name: "reviewer", description: "A", prompt: "Prompt A" };
    const b: AgentRole = { name: "reviewer", description: "B", prompt: "Prompt B" };
    const settled = await Promise.allSettled([store.create(a), store.create(b)]);
    expect(settled.map((each) => each.status)).toEqual(["fulfilled", "rejected"]);
    expect((settled[1] as PromiseRejectedResult).reason.message).toContain('Agent "reviewer" already exists');
    // The dir holds exactly one file with the first write's content, no temp leftover.
    expect((await readdir(join(dir.path, "agents"))).sort()).toEqual(["reviewer.md"]);
    expect(await readFile(join(dir.path, "agents", "reviewer.md"), "utf8")).toContain("Prompt A");
    expect(store.value.roles[0]).toMatchObject({ name: "reviewer", prompt: "Prompt A" });
  });

  it("serializes create-then-remove into no file and no temp leftover", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    const role: AgentRole = { name: "reviewer", description: "d", prompt: "p" };
    await Promise.allSettled([store.create(role), store.remove("reviewer")]);
    expect(await readdir(join(dir.path, "agents"))).toEqual([]);
    expect(store.value).toEqual({ roles: [], problems: [] });
  });

  it("rejects a remove whose name escapes the agents directory", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const store = await openStore(dir.path);
    // A file next to agents/ must survive a deleteAgent for a traversal name.
    await writeFile(join(dir.path, "outside.md"), "do not delete\n");
    await expect(store.remove("../outside")).rejects.toThrow("lowercase letters, digits and hyphens");
    expect(await readFile(join(dir.path, "outside.md"), "utf8")).toBe("do not delete\n");
  });
});
