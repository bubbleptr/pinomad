// The Inbox sandbox (ADR-0052 §7): an Inbox run's child processes get their
// own HOME, an environment without credentials, and an OS sandbox that hides
// the user's credential files and the host's data dir.
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { AgentRoleStore } from "../src/agent-roles.ts";
import { coding } from "../src/extensions/coding.ts";
import { createProcesses } from "../src/extensions/processes.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import type { OpenedHost } from "../src/host.ts";
import { addInboxEvent, InboxDoc, type InboxTask } from "../src/inbox.ts";
import type { Processes } from "../src/processes.ts";
import {
  credentialEnv,
  inboxSandboxPolicy,
  openSandboxedEnv,
  type SandboxPolicy,
  sandboxAvailable,
  scrubEnv,
} from "../src/sandbox.ts";
import { connectTo, startConversation, startFauxHost, tempDir, useCleanups } from "./support.ts";

const context = BACKGROUND_CONTEXT;
const defer = useCleanups();
const exec = promisify(execFile);
const available = await sandboxAvailable();
if (!available) console.warn(`sandbox: no OS sandbox on ${process.platform}; the OS-level cases are skipped`);

async function temp(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  return dir.path;
}

/** A fake user home holding the credentials an Inbox run must not reach. */
async function fakeHome(): Promise<string> {
  const home = await temp();
  await mkdir(join(home, ".ssh"));
  await writeFile(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_secret");
  return home;
}

async function gitWorktree(): Promise<{ repo: string; worktree: string }> {
  const repo = await temp();
  const git = (...args: string[]) => exec("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(await temp(), "wt");
  await git("worktree", "add", "-q", "-b", "task", worktree);
  return { repo, worktree };
}

async function run(env: Awaited<ReturnType<typeof openSandboxedEnv>>, command: string, extra?: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(
    command,
    {
      ...(extra === undefined ? {} : { env: extra }),
      onOutput: (text, _context, info) => {
        if (info.stream === "stdout") stdout += text;
        else stderr += text;
      },
    },
    context,
  );
  if (!result.ok) throw result.error;
  return { exitCode: result.value.exitCode, stdout, stderr };
}

describe("scrubEnv", () => {
  it("drops credential-like variables and keeps the rest", () => {
    const credentials = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "NPM_TOKEN",
      "CLIENT_SECRET",
      "DB_PASSWORD",
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "SSH_AUTH_SOCK",
      "GPG_AGENT_INFO",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_CONFIG_GLOBAL",
      "KUBECONFIG",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CLIENT_SECRET",
      "DBUS_SESSION_BUS_ADDRESS",
      "gh_token",
    ];
    for (const name of credentials) expect(credentialEnv(name), name).toBe(true);
    for (const name of ["PATH", "LANG", "TERM", "NODE_ENV", "TOKENIZERS_PARALLELISM", "KEYBOARD", "SHELL"]) {
      expect(credentialEnv(name), name).toBe(false);
    }
  });

  it("points HOME and the XDG dirs at the sandbox home", () => {
    const env = scrubEnv({ PATH: "/usr/bin", HOME: "/Users/me", XDG_CONFIG_HOME: "/Users/me/.config", GH_TOKEN: "x" }, "/sandbox");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/sandbox",
      XDG_CONFIG_HOME: "/sandbox/.config",
      XDG_DATA_HOME: "/sandbox/.local/share",
      XDG_CACHE_HOME: "/sandbox/.cache",
      XDG_STATE_HOME: "/sandbox/.local/state",
    });
  });
});

describe("sandboxed environment", () => {
  async function setup(): Promise<{ policy: SandboxPolicy; realHome: string; dataDir: string; repo: string; worktree: string }> {
    const realHome = await fakeHome();
    const dataDir = await temp();
    const { repo, worktree } = await gitWorktree();
    const policy = await inboxSandboxPolicy({ dataDir, project: repo, cwd: worktree, realHome });
    return { policy, realHome, dataDir, repo, worktree };
  }

  it("gives commands the sandbox HOME and no credential variables", async () => {
    const { policy, worktree } = await setup();
    const env = await openSandboxedEnv(worktree, policy);
    const out = await run(env, 'printf "%s|%s" "$HOME" "${GH_TOKEN-unset}"', { GH_TOKEN: "gho_leak" });
    expect(out.stdout).toBe(`${policy.home}|unset`);
  });

  it("refuses the file tools a credential path, even through a symlink in the worktree", async () => {
    const { policy, realHome, worktree, dataDir } = await setup();
    const env = await openSandboxedEnv(worktree, policy);
    await symlink(join(realHome, ".ssh"), join(worktree, "keys"));
    for (const path of [join(realHome, ".ssh", "id_ed25519"), join(worktree, "keys", "id_ed25519"), join(dataDir, "auth.json")]) {
      const read = await env.readTextFile(path, context);
      expect(read.ok, path).toBe(false);
      if (!read.ok) expect(read.error.code).toBe("permission_denied");
    }
    const listed = await env.listDir(join(realHome, ".config", "gh"), context);
    expect(listed.ok).toBe(false);
    const written = await env.writeFile(join(dataDir, "planted"), "x", context);
    expect(written.ok).toBe(false);

    expect((await env.writeFile(join(worktree, "notes.txt"), "fine", context)).ok).toBe(true);
    const read = await env.readTextFile(join(worktree, "notes.txt"), context);
    expect(read.ok && read.value).toBe("fine");
  });

  it.runIf(available)("denies credential reads and writes outside the worktree and temp dirs at the OS level", async () => {
    const { policy, realHome, dataDir, repo, worktree } = await setup();
    const env = await openSandboxedEnv(worktree, policy);
    const attempts = {
      ssh: `cat ${join(realHome, ".ssh", "id_ed25519")}`,
      gh: `ls ${join(realHome, ".config", "gh")}`,
      dataDir: `echo planted > ${join(dataDir, "planted")}`,
      hooks: `echo 'exit 0' > ${join(repo, ".git", "hooks", "pre-commit")}`,
      gitConfig: `git config core.hooksPath /tmp`,
    };
    for (const [name, command] of Object.entries(attempts)) {
      const out = await run(env, command);
      expect(out.exitCode, `${name}: ${out.stdout}${out.stderr}`).not.toBe(0);
    }
  });

  it.runIf(available)("still runs builds: node, git status and git commit in the worktree", async () => {
    const { policy, worktree } = await setup();
    const env = await openSandboxedEnv(worktree, policy);
    const out = await run(
      env,
      "node -e 'console.log(1+1)' && git status --short && echo hi > a.txt && git add a.txt && git commit -q -m add && git log --oneline | wc -l && echo tmp > \"${TMPDIR:-/tmp}/sandbox-probe\"",
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout.split("\n").map((line) => line.trim())).toEqual(["2", "2", ""]);
  });
});

const tasksOf = async (host: OpenedHost, project: string): Promise<InboxTask[]> => {
  const doc = await host.harness.snapshot(InboxDoc, context);
  return doc?.inboxes[Object.keys(doc.inboxes).find((path) => path.endsWith(project.split("/").pop()!))!]?.tasks ?? [];
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function toolOutputs(host: OpenedHost, id: ConversationId): Promise<string[]> {
  const conversation = await host.harness.conversation(id, context);
  const page = await conversation!.entries({ order: "ascending" }, 1000, undefined, context);
  return page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify((entry as { model?: unknown }).model));
}

const bash = (command: string) => fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
const event = (id: string) => ({ id, source: "user" as const, summary: "look", trusted: true });

describe("Inbox runs", () => {
  it("sandbox an Inbox task's bash but not a coding conversation sharing its cwd", async () => {
    const project = await temp();
    const dataDir = await temp();
    const host = await startFauxHost(defer, {
      dataDir,
      projects: [project],
      extensions: [coding],
      answers: [bash('printf "home=%s" "$HOME"'), "inbox done", bash('printf "home=%s" "$HOME"'), "coding done"],
    });
    await addInboxEvent(host.harness, project, event("e1"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    const inboxOut = await toolOutputs(host, task!.conversationId!);
    expect(inboxOut.join()).toContain(`home=${join(await realpath(dataDir), "inbox-home")}`);

    const client = await connectTo(defer, host);
    const ordinary = await startConversation(client, { kind: "project", path: project }, "hi");
    const codingOut = await until(() => toolOutputs(host, ordinary), (out) => out.length === 1);
    expect(codingOut.join()).toContain(`home=${process.env.HOME}`);
  });

  it("sandboxes a subagent an Inbox task dispatches", async () => {
    const project = await temp();
    const dataDir = await temp();
    const host = await startFauxHost(defer, {
      dataDir,
      projects: [project],
      extensions: (provided: { models: Models; modelSummaries: () => readonly ModelSummary[]; agentRoles: AgentRoleStore }) => [
        coding,
        createSubagent({
          models: provided.models,
          modelSummaries: provided.modelSummaries,
          roles: () => provided.agentRoles.value.roles,
          exclude: [],
        }),
      ],
      answers: [
        fauxAssistantMessage(fauxToolCall("subagent", { task: "look", checkout: "shared" }), { stopReason: "toolUse" }),
        bash('printf "home=%s" "$HOME" > sub-home.txt'),
        "child done",
        "parent done",
      ],
    });
    await addInboxEvent(host.harness, project, event("e1"), context);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(await readFile(join(project, "sub-home.txt"), "utf8")).toContain(`home=${join(await realpath(dataDir), "inbox-home")}`);
  });

  it("starts an Inbox task's background process in the sandbox", async () => {
    const project = await temp();
    const dataDir = await temp();
    const host = await startFauxHost(defer, {
      dataDir,
      projects: [project],
      extensions: (provided: { processes?: Processes }) => [
        createProcesses(provided.processes === undefined ? {} : { runtime: provided.processes }),
      ],
      processes: {
        shell: { file: "/bin/sh", args: [] },
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GH_TOKEN: "gho_leak" },
      },
      answers: [
        fauxAssistantMessage(
          fauxToolCall("process_start", { command: 'printf "home=%s token=%s" "$HOME" "${GH_TOKEN-unset}" > proc.txt' }),
          { stopReason: "toolUse" },
        ),
        "started",
      ],
    });
    await addInboxEvent(host.harness, project, event("e1"), context);
    const text = await until(
      () => readFile(join(project, "proc.txt"), "utf8").catch(() => ""),
      (value) => value.includes("token="),
    );
    expect(text).toContain(`home=${join(await realpath(dataDir), "inbox-home")}`);
    expect(text).toContain("token=unset");
  });
});
