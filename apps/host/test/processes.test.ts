// Background processes (ADR-0045): admission and the family limit, stop
// reasons, exit reporting, archive/shutdown, lost settlement, and the shared
// output positions. A fake pty keeps these deterministic; the real pty smoke
// is separate.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { ProcessDoc } from "../src/process-doc.ts";
import { settleLostProcesses } from "../src/processes.ts";
import type { PtyProcess } from "../src/terminals.ts";
import { startChat, startFauxHost, tempDir, useCleanups } from "./support.ts";

const CONTEXT = BACKGROUND_CONTEXT;
const CWD = process.cwd();
const defer = useCleanups();

class FakePty implements PtyProcess {
  readonly pid: number;
  readonly file: string;
  readonly args: string[];
  readonly options: { cwd: string; env: Record<string, string> };
  #data: ((data: string) => void)[] = [];
  #exit: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  finished = false;

  constructor(pid: number, file: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
    this.pid = pid;
    this.file = file;
    this.args = args;
    this.options = options;
  }

  onData(listener: (data: string) => void): void {
    this.#data.push(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.#exit.push(listener);
  }

  write(): void {}

  resize(): void {}

  kill(): void {}

  emit(data: string): void {
    for (const listener of this.#data) listener(data);
  }

  finish(exitCode = 0, signal?: number): void {
    if (this.finished) return;
    this.finished = true;
    for (const listener of this.#exit) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
}

interface FakeSpawner {
  readonly spawn: (file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => FakePty;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly ptys: FakePty[];
  readonly signals: { pid: number; signal: NodeJS.Signals }[];
}

function fakeSpawner(options: {
  /** What a signal does; the default exits at once. */
  readonly onSignal?: (pty: FakePty | undefined, signal: NodeJS.Signals) => void;
} = {}): FakeSpawner {
  const ptys: FakePty[] = [];
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  let next = 20_000;
  return {
    spawn: (file, args, spawnOptions) => {
      const pty = new FakePty(++next, file, args, spawnOptions);
      ptys.push(pty);
      return pty;
    },
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      const pty = ptys.find((candidate) => candidate.pid === Math.abs(pid));
      (options.onSignal ?? ((target, value) => target?.finish(0, value === "SIGTERM" ? 15 : 9)))(pty, signal);
    },
    ptys,
    signals,
  };
}

async function setup(options: {
  answers?: string[];
  processes?: Record<string, unknown>;
  fake?: FakeSpawner;
} = {}) {
  const fake = options.fake ?? fakeSpawner();
  const host = await startFauxHost(defer, {
    answers: options.answers ?? Array.from({ length: 20 }, () => "ok"),
    processes: {
      spawn: fake.spawn,
      kill: fake.kill,
      shell: { file: "/bin/sh", args: [] },
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      stopGraceMs: 50,
      ...options.processes,
    },
  });
  const client = await connectTo(host);
  const conversationId = await startChat(client, "hi");
  return { host, client, conversationId, fake, runtime: host.processes! };
}

async function connectTo(host: Awaited<ReturnType<typeof startFauxHost>>) {
  const { connectRemoteDurable } = await import("@pinomad/protocol/remote-durable.ts");
  const client = await connectRemoteDurable({
    url: host.url,
    token: host.token,
    reconnectDelayMs: { min: 50, max: 100 },
  });
  defer(() => client.close());
  return client;
}

async function startProcess(
  setupValue: Awaited<ReturnType<typeof setup>>,
  overrides: { id?: string; command?: string; name?: string; conversationId?: ConversationId } = {},
) {
  return await setupValue.runtime.start(
    {
      conversationId: overrides.conversationId ?? setupValue.conversationId,
      command: overrides.command ?? "sleep 30",
      name: overrides.name ?? "monitor",
      cwd: CWD,
      ...(overrides.id === undefined ? {} : { id: overrides.id }),
    },
    CONTEXT,
  );
}

async function document(host: Awaited<ReturnType<typeof startFauxHost>>, conversationId: ConversationId) {
  return await host.harness.snapshot(ProcessDoc, conversationId, CONTEXT);
}

async function entries(host: Awaited<ReturnType<typeof startFauxHost>>, conversationId: ConversationId) {
  const conversation = await host.harness.conversation(conversationId, CONTEXT);
  const page = await conversation!.entries({}, 50, undefined, CONTEXT);
  return JSON.stringify(page.items);
}

async function forkConversation(
  host: Awaited<ReturnType<typeof startFauxHost>>,
  root: ConversationId,
) {
  const conversation = await host.harness.conversation(root, CONTEXT);
  const page = await conversation!.entries({}, 1, undefined, CONTEXT);
  return await conversation!.fork(page.items[0]!.id, { ownership: { kind: "ownerless" } }, CONTEXT);
}

async function until(test: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await test())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Result = { ok: boolean; value?: unknown; error?: string };

/** A bare socket for calls the RemoteDurable controller does not expose. */
async function rawClient(host: { url: string; token: string }) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  const frames: ServerFrame[] = [];
  const pending = new Map<number, (value: Result) => void>();
  let next = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "result") {
      pending.get(frame.id)?.(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
      pending.delete(frame.id);
    }
  });
  await once(socket, "open");
  defer(() => socket.terminate());
  return {
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
  };
}

describe("Processes", () => {
  it("admits two concurrent starts without passing the family limit", async () => {
    const value = await setup({ processes: { limit: 1 } });
    const results = await Promise.allSettled([startProcess(value), startProcess(value)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("Process limit reached (1)");
    // Starting again in another family has its own budget.
    const second = await startChat(value.client, "second");
    await value.runtime.start(
      { conversationId: second, command: "sleep 30", name: "other", cwd: CWD },
      CONTEXT,
    );
    expect(value.fake.ptys).toHaveLength(2);
  });

  it("returns the same process for a replayed start id and does not spawn twice", async () => {
    const value = await setup();
    const first = await startProcess(value, { id: "fixed-id" });
    const second = await startProcess(value, { id: "fixed-id" });
    expect(second).toEqual(first);
    expect(value.fake.ptys).toHaveLength(1);
  });

  it("keeps the first stop reason and waits for the group signal", async () => {
    const fake = fakeSpawner({
      onSignal: (_pty, signal) => {
        if (signal === "SIGKILL") fake.ptys[0]!.finish(0, 9);
      },
    });
    const value = await setup({ fake, processes: { stopGraceMs: 20 } });
    const process = await startProcess(value);
    const stopping = [
      value.runtime.stop({ conversationId: value.conversationId, id: process.id, reason: "agent" }, CONTEXT),
      value.runtime.stop({ conversationId: value.conversationId, id: process.id, reason: "user" }, CONTEXT),
    ];
    const [first, second] = await Promise.all(stopping);
    expect(first.state).toEqual({ stopped: "agent" });
    expect(second.state).toEqual({ stopped: "agent" });
    expect(fake.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    expect((await document(value.host, value.conversationId))!.processes[0]!.state).toEqual({ stopped: "agent" });
  });

  it("reports a self-exit in one commit and steers a busy conversation", async () => {
    const value = await setup();
    const process = await startProcess(value);
    const pty = value.fake.ptys[0]!;
    pty.emit("hello \x1b[31mred\x1b[0m\n");
    pty.finish(3);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const doc = await document(value.host, value.conversationId);
    expect(doc!.processes[0]!.state).toEqual({ exited: 3 });
    const text = await entries(value.host, value.conversationId);
    expect(text).toContain("exited with code 3");
    expect(text).toContain("hello");
  });

  it("streams output by raw positions and strips ANSI only from text", async () => {
    const value = await setup();
    const process = await startProcess(value);
    const raw = "a\x1b[31mb\x1b[0mc";
    value.fake.ptys[0]!.emit(raw);
    const first = await value.runtime.output(
      { conversationId: value.conversationId, id: process.id, since: 0 },
      CONTEXT,
    );
    expect(first.text).toBe("abc");
    expect(first.next).toBe(raw.length);
    expect(first.truncated).toBe(false);
    const second = await value.runtime.output(
      { conversationId: value.conversationId, id: process.id, since: first.next },
      CONTEXT,
    );
    expect(second.text).toBe("");
    expect(second.next).toBe(raw.length);
  });

  it("writes stopped: shutdown on close and never reports the exit", async () => {
    const value = await setup();
    const process = await startProcess(value);
    await value.runtime.close(CONTEXT);
    expect((await document(value.host, value.conversationId))!.processes[0]!.state).toEqual({ stopped: "shutdown" });
    expect(await entries(value.host, value.conversationId)).not.toContain("exited with code");
    expect(value.fake.ptys[0]!.finished).toBe(true);
    expect(process.id).toBeTruthy();
  });

  it("settles starting/running entries to lost on the next start, even without a pty module", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const fake = fakeSpawner();
    const first = await startFauxHost(defer, {
      dataDir: dir.path,
      processes: {
        spawn: fake.spawn,
        kill: fake.kill,
        shell: { file: "/bin/sh", args: [] },
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      },
    });
    const firstClient = await connectTo(first);
    const conversationId = await startChat(firstClient, "hi");
    await first.harness.commit(async (tx) => {
      const doc = await tx.doc(ProcessDoc, conversationId);
      doc.processes.push({
        id: "left-behind",
        owner: conversationId,
        name: "old",
        command: "sleep 30",
        pid: 1234,
        startedAt: Date.now(),
        state: "running",
      });
    }, CONTEXT);
    await first.close();

    const second = await startFauxHost(defer, {
      dataDir: dir.path,
      processes: {
        load: () => Promise.reject(new Error("no prebuild")),
        diagnostic: () => {},
      },
    });
    expect(second.processes).toBeUndefined();
    const doc = await second.harness.snapshot(ProcessDoc, conversationId, CONTEXT);
    expect(doc!.processes[0]!.state).toBe("lost");
    expect(doc!.processes[0]!.pid).toBe(1234);
  });

  it("rejects another family's process id and stops the right one", async () => {
    const value = await setup();
    const process = await startProcess(value);
    const other = await startChat(value.client, "other");
    const raw = await rawClient(value.host);
    expect(await raw.call("stopProcess", { conversationId: other, id: process.id })).toEqual({
      ok: false,
      error: "This process does not belong to the conversation's family",
    });
    expect(await raw.call("stopProcess", { conversationId: value.conversationId, id: process.id })).toEqual({
      ok: true,
      value: { state: { stopped: "user" } },
    });
  });

  it("seals, stops and waits before an archive completes", async () => {
    const fake = fakeSpawner({ onSignal: (_pty, signal) => { if (signal === "SIGKILL") fake.ptys[0]!.finish(0, 9); } });
    const value = await setup({ fake, processes: { stopGraceMs: 500 } });
    const process = await startProcess(value);
    const raw = await rawClient(value.host);
    let archived = false;
    const archiving = raw.call("archive", { conversationId: value.conversationId, archived: true }).then((result) => {
      archived = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(archived).toBe(false);
    value.fake.ptys[0]!.finish(0, 15);
    expect(await archiving).toEqual({ ok: true, value: null });
    expect((await document(value.host, value.conversationId))!.processes[0]!.state).toEqual({ stopped: "archive" });
    await expect(startProcess(value)).rejects.toThrow("archived");
    expect(process.id).toBeTruthy();
  });

  it("keeps another family's ended output when a different family updates", async () => {
    const value = await setup();
    const first = await startProcess(value, { name: "first" });
    value.fake.ptys[0]!.emit("first-output");
    value.fake.ptys[0]!.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const other = await startChat(value.client, "other");
    const second = await value.runtime.start(
      { conversationId: other, command: "sleep 30", name: "second", cwd: CWD },
      CONTEXT,
    );
    value.fake.ptys[1]!.emit("second-output");
    value.fake.ptys[1]!.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await value.runtime.output({ conversationId: value.conversationId, id: first.id }, CONTEXT)).text).toBe(
      "first-output",
    );
    expect((await value.runtime.output({ conversationId: other, id: second.id }, CONTEXT)).text).toBe("second-output");
  });

  it("keeps the SIGKILL timer when the shell exits before its group", async () => {
    let alive = true;
    const fake = fakeSpawner({
      onSignal: (pty, signal) => {
        if (signal === "SIGTERM") pty?.finish(0, 15);
        if (signal === "SIGKILL") alive = false;
      },
    });
    const value = await setup({
      fake,
      processes: { stopGraceMs: 20, groupAlive: () => alive },
    });
    const process = await startProcess(value);
    const stopped = await value.runtime.stop(
      { conversationId: value.conversationId, id: process.id, reason: "user" },
      CONTEXT,
    );
    expect(stopped.state).toEqual({ stopped: "user" });
    expect(fake.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("evicts the oldest ended output when the budget is exceeded", async () => {
    const value = await setup({ processes: { outputBudget: 20 } });
    const first = await startProcess(value, { name: "first" });
    value.fake.ptys[0]!.emit("012345678901");
    value.fake.ptys[0]!.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await startProcess(value, { name: "second" });
    value.fake.ptys[1]!.emit("abcdefghijkl");
    value.fake.ptys[1]!.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const evicted = await value.runtime.output({ conversationId: value.conversationId, id: first.id }, CONTEXT);
    expect(evicted).toMatchObject({ released: true, status: { exited: 0 } });
    const kept = await value.runtime.output({ conversationId: value.conversationId, id: second.id }, CONTEXT);
    expect(kept.text).toBe("abcdefghijkl");
  });

  it("reports a self-exit to the fork that started it, while the document stays on the root", async () => {
    const value = await setup();
    const fork = await forkConversation(value.host, value.conversationId);
    const process = await value.runtime.start(
      { conversationId: fork.id, command: "sleep 30", name: "fork-monitor", cwd: CWD },
      CONTEXT,
    );
    value.fake.ptys[0]!.finish(3);
    await until(async () => {
      const doc = await document(value.host, value.conversationId);
      return doc?.processes.some((entry) => entry.id === process.id && entry.state !== "running") === true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await entries(value.host, fork.id)).toContain("fork-monitor");
    expect(await entries(value.host, fork.id)).toContain("exited with code 3");
    expect(await entries(value.host, value.conversationId)).not.toContain("fork-monitor");
    expect((await document(value.host, fork.id))?.processes ?? []).toEqual([]);
  });

  it("ends a stop after a bounded group wait when the group never disappears", async () => {
    const diagnostics: string[] = [];
    const fake = fakeSpawner({
      onSignal: (pty, signal) => {
        if (signal === "SIGTERM") pty?.finish(0, 15);
      },
    });
    const value = await setup({
      fake,
      processes: {
        stopGraceMs: 10,
        groupWaitMs: 30,
        groupAlive: () => true,
        diagnostic: (message: string) => diagnostics.push(message),
      },
    });
    const process = await startProcess(value);
    const stopped = await value.runtime.stop(
      { conversationId: value.conversationId, id: process.id, reason: "user" },
      CONTEXT,
    );
    expect(stopped.state).toEqual({ stopped: "user" });
    expect(fake.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(diagnostics.join("\n")).toContain("still appears alive after SIGKILL");
  });

  it("settles only root documents and skips forks before snapshotting", async () => {
    const value = await setup();
    const fork = await forkConversation(value.host, value.conversationId);
    const snapshots: number[] = [];
    const harness = value.host.harness;
    const wrapped = {
      snapshot: (token: typeof ProcessDoc, id: ConversationId, context: typeof CONTEXT) => {
        snapshots.push(Number(id));
        return harness.snapshot(token, id, context);
      },
      commit: (change: Parameters<typeof harness.commit>[0], context: typeof CONTEXT) => harness.commit(change, context),
    } as unknown as Parameters<typeof settleLostProcesses>[0];
    await settleLostProcesses(wrapped, CONTEXT);
    expect(snapshots).toContain(Number(value.conversationId));
    expect(snapshots).not.toContain(Number(fork.id));
  });

  it("returns document state and released output for entries no longer in memory", async () => {
    const value = await setup();
    await value.host.harness.commit(async (tx) => {
      const doc = await tx.doc(ProcessDoc, value.conversationId);
      doc.processes.push({
        id: "left-over",
        owner: value.conversationId,
        name: "left-over",
        command: "sleep 30",
        pid: 1234,
        startedAt: 1,
        endedAt: 2,
        state: "lost",
      });
    }, CONTEXT);
    const output = await value.runtime.output(
      { conversationId: value.conversationId, id: "left-over", since: 7 },
      CONTEXT,
    );
    expect(output).toMatchObject({ text: "", next: 7, released: true, status: "lost" });
    const stopped = await value.runtime.stop(
      { conversationId: value.conversationId, id: "left-over", reason: "user" },
      CONTEXT,
    );
    expect(stopped).toMatchObject({ id: "left-over", state: "lost" });
    await expect(
      value.runtime.output({ conversationId: value.conversationId, id: "absent" }, CONTEXT),
    ).rejects.toThrow("Unknown process");
    await expect(
      value.runtime.stop({ conversationId: value.conversationId, id: "absent" }, CONTEXT),
    ).rejects.toThrow("Unknown process");
  });
});
