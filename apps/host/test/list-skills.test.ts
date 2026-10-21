// `listSkills` (issue #143): the `$`-mentionable skills a scope's prompt would
// carry — the three scopes, worktree-vs-live project entries, the
// dedupe-then-disable order, invalid names staying prompt-only, and the
// per-scope cache a typing burst rides on.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { SkillListing } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { createSkillLister, scopedSkills } from "../src/skills.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
let nextCall = 1;

async function socketTo(host: OpenedHost) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

function call<M extends keyof CallMethods>(
  client: { socket: WebSocket; frames: ServerFrame[] },
  method: M,
  args: CallMethods[M]["args"],
): Promise<Extract<ServerFrame, { type: "result" }>> {
  const id = nextCall++;
  client.socket.send(JSON.stringify({ type: "call", id, method, args }));
  return (async () => {
    for (;;) {
      const found = client.frames.find(
        (frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result" && frame.id === id,
      );
      if (found !== undefined) return found;
      await once(client.socket, "message");
    }
  })();
}

const skillsOf = (result: Extract<ServerFrame, { type: "result" }>): SkillListing =>
  (result as { value: SkillListing }).value;

const namesOf = (listing: SkillListing): string[] => listing.skills.map((skill) => skill.name);

const SKILL = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${description}.\n`;

const DISABLED = `disable-model-invocation: true\n`;

async function writeSkill(dir: string, name: string, description: string, extra = ""): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), SKILL(name, description, extra));
}

/** A project dir with committed `committed` project skills. */
async function initProject(path: string, committed: string[]): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-C", path, "init", "-b", "main"]);
  for (const name of committed) {
    await writeSkill(join(path, ".agents", "skills"), name, `Project ${name} steps`);
  }
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
}

/** Discovery order inside an entry is upstream's; what matters is which names list, and their source. */
const sortedNames = (listing: SkillListing): string[] => namesOf(listing).sort();

/** Resolve once the shown conversation's first run finished — the checkout exists by then. */
const settled = (client: RemoteDurable) =>
  waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).length >= 2);

describe("listSkills", () => {
  it("lists a project's and the user's skills, project first on a name collision", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeSkill(join(project.path, ".agents", "skills"), "deploy", "Project deploy steps");
    await writeSkill(join(agentsHome.path, "skills"), "deploy", "User deploy steps");
    await writeSkill(join(agentsHome.path, "skills"), "review", "User review steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);

    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } }));
    expect(namesOf(listing)).toEqual(["deploy", "review"]);
    expect(listing.skills[0]).toEqual({ name: "deploy", description: "Project deploy steps", source: "project" });
    expect(listing.skills[1]).toEqual({ name: "review", description: "User review steps", source: "user" });
  });

  it("keeps a project's disabled skill shadowing the user's, and drops both", async () => {
    // Dedupe before the disabled filter: without that order the project's
    // disabled `deploy` would expose the user's same-named one (issue #143).
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeSkill(join(project.path, ".agents", "skills"), "deploy", "Project deploy steps", DISABLED);
    await writeSkill(join(agentsHome.path, "skills"), "deploy", "User deploy steps");
    await writeSkill(join(agentsHome.path, "skills"), "review", "User review steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);

    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } }));
    expect(namesOf(listing)).toEqual(["review"]);
  });

  it("drops names the composer cannot type, but the shared loader still carries them", async () => {
    // Upstream loads a bad name with a warning — it stays in the prompt, it
    // just can't be `$`-mentioned, so listSkills alone filters it out.
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeSkill(join(project.path, ".agents", "skills"), "Bad_Name", "Oddly named steps");
    await writeSkill(join(agentsHome.path, "skills"), "review", "User review steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);

    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } }));
    expect(namesOf(listing)).toEqual(["review"]);
    // The shared loader — what the system prompt renders — keeps it.
    expect(scopedSkills(project.path, agentsHome.path).map((scoped) => scoped.skill.name)).toEqual(["Bad_Name", "review"]);
  });

  it("for a worktree checkout keeps only committed project skills; the user's same-named one survives", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await initProject(project.path, ["review"]);
    // Uncommitted project skills never reach a fresh worktree (ADR-0010).
    await writeSkill(join(project.path, ".agents", "skills"), "draft", "Uncommitted project steps");
    await writeSkill(join(project.path, ".agents", "skills"), "deploy", "Uncommitted deploy steps");
    // The user's `deploy` shows instead: filtered before the merge, so the
    // uncommitted project one cannot shadow it.
    await writeSkill(join(agentsHome.path, "skills"), "deploy", "User deploy steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);

    const worktree = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "worktree" } }));
    expect(sortedNames(worktree)).toEqual(["deploy", "review"]);
    expect(worktree.skills.find((skill) => skill.name === "deploy")).toMatchObject({ description: "User deploy steps", source: "user" });

    const live = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } }));
    expect(sortedNames(live)).toEqual(["deploy", "draft", "review"]);
  });

  it("treats a project outside git like checkout project", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeSkill(join(project.path, ".agents", "skills"), "draft", "Uncommitted project steps");

    const host = await startFauxHost(defer, { projects: [project.path] });
    const raw = await socketTo(host);
    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "worktree" } }));
    expect(namesOf(listing)).toEqual(["draft"]);
  });

  it("lists a conversation's checkout skills plus the user's, and a Chat's user skills", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await initProject(project.path, ["review"]);
    await writeSkill(join(agentsHome.path, "skills"), "deploy", "User deploy steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const id = await startConversation(client, { kind: "project", path: project.path }, "work");
    await settled(client);
    const cwd = (await host.harness.snapshot(AgentDoc, id, context))!.cwd!;
    // The worktree's own draft skill: live on disk, so the conversation sees it.
    await writeSkill(join(cwd, ".agents", "skills"), "fresh", "Fresh worktree steps");

    const convo = skillsOf(await call(raw, "listSkills", { scope: { kind: "conversation", conversationId: id } }));
    expect(sortedNames(convo)).toEqual(["deploy", "fresh", "review"]);
    expect(convo.skills.find((skill) => skill.name === "fresh")).toMatchObject({ source: "project" });
    expect(convo.skills.find((skill) => skill.name === "deploy")).toMatchObject({ source: "user" });

    const chat = await startChat(client, "hi");
    await settled(client);
    const chatListing = skillsOf(await call(raw, "listSkills", { scope: { kind: "conversation", conversationId: chat } }));
    expect(namesOf(chatListing)).toEqual(["deploy"]);
  });

  it("lists only user skills for a chat draft scope", async () => {
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeSkill(join(agentsHome.path, "skills"), "review", "User review steps");
    const project = await tempDir();
    defer(project.remove);
    await writeSkill(join(project.path, ".agents", "skills"), "deploy", "Project deploy steps");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);
    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "chat" } }));
    expect(listing.skills).toEqual([{ name: "review", description: "User review steps", source: "user" }]);
  });

  it("fails a conversation whose checkout is gone — never materializes a worktree", async () => {
    const project = await tempDir();
    defer(project.remove);
    await initProject(project.path, []);
    const host = await startFauxHost(defer, { projects: [project.path] });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const id = await startConversation(client, { kind: "project", path: project.path }, "work");
    await settled(client);
    const cwd = (await host.harness.snapshot(AgentDoc, id, context))!.cwd!;
    await rm(cwd, { recursive: true, force: true });

    const result = await call(raw, "listSkills", { scope: { kind: "conversation", conversationId: id } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("checkout") });
    // No ensureWorktree ran: the directory stays gone.
    await expect(run("git", ["-C", cwd, "rev-parse"])).rejects.toThrow();
  });

  it("rejects unknown conversations, unregistered projects, and deleted project dirs", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, { projects: [project.path] });
    const raw = await socketTo(host);

    const missing = await call(raw, "listSkills", { scope: { kind: "conversation", conversationId: 999 as ConversationId } });
    expect(missing).toMatchObject({ ok: false, error: "Conversation 999 does not exist" });
    const outside = await tempDir();
    defer(outside.remove);
    const unknown = await call(raw, "listSkills", { scope: { kind: "project", path: outside.path, checkout: "project" } });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown project") });

    await rm(project.path, { recursive: true, force: true });
    const gone = await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } });
    expect(gone).toMatchObject({ ok: false });
  });

  it("answers an empty list when the skills dirs are absent or their files invalid", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await mkdir(join(project.path, ".agents", "skills", "broken"), { recursive: true });
    await writeFile(join(project.path, ".agents", "skills", "broken", "SKILL.md"), "not frontmatter\n");

    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path });
    const raw = await socketTo(host);
    const listing = skillsOf(await call(raw, "listSkills", { scope: { kind: "project", path: project.path, checkout: "project" } }));
    expect(listing.skills).toEqual([]);
  });

  it("closes a socket on malformed args (4400) instead of a result", async () => {
    const host = await startFauxHost(defer);
    const raw = await socketTo(host);
    raw.socket.send(JSON.stringify({ type: "call", id: nextCall++, method: "listSkills", args: { scope: { kind: "nope" } } }));
    await new Promise<void>((resolve) => raw.socket.once("close", (code) => {
      expect(code).toBe(4400);
      resolve();
    }));
    expect(raw.frames.some((f) => f.type === "result")).toBe(false);
  });
});

describe("createSkillLister", () => {
  const manual = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("merges concurrent scans of the same scope and caches them briefly", async () => {
    const clock = manual();
    const gate = deferred<SkillListing>();
    const scans: string[] = [];
    const enumerate = async (root: string | undefined): Promise<SkillListing> => {
      scans.push(root ?? "none");
      return await gate.promise;
    };
    const list = createSkillLister((root) => enumerate(root), { now: clock.now, ttlMs: 3000 });

    const a = list("/root", "live");
    const b = list("/root", "live");
    await Promise.resolve();
    expect(scans).toEqual(["/root"]); // one scan for both callers
    gate.resolve({ skills: [] });
    expect(await a).toEqual({ skills: [] });
    expect(await b).toEqual({ skills: [] });

    // Within the TTL the cache answers — no second scan.
    expect(await list("/root", "live")).toEqual({ skills: [] });
    expect(scans).toEqual(["/root"]);
    clock.advance(3100);
    const reopened = createSkillLister(async (root) => {
      scans.push(`again:${root}`);
      return { skills: [] };
    }, { now: clock.now, ttlMs: 3000 });
    await reopened("/root", "live");
    expect(scans).toEqual(["/root", "again:/root"]);
  });

  it("does not cache a failed scan", async () => {
    const clock = manual();
    let n = 0;
    const enumerate = async (): Promise<SkillListing> => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return { skills: [] };
    };
    const list = createSkillLister(enumerate, { now: clock.now });
    await expect(list("/r", "live")).rejects.toThrow("boom");
    expect(await list("/r", "live")).toEqual({ skills: [] });
    expect(n).toBe(2);
  });
});
