// Terminals run real ptys (/bin/sh, no rc files) so the tests see what a
// client would: output, sizes, exits, replay and the per-owner limit.
import { spawn } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { Terminals, type TerminalFrame } from "../src/terminals.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { TerminalList } from "@pinomad/protocol/terminals.ts";
import { tempDir } from "./support.ts";

const OWNER = 7 as ConversationId;
const SIZE = { cols: 80, rows: 24 };
let open: Terminals[] = [];

afterEach(() => {
  for (const terminals of open.splice(0)) terminals.closeAll();
});

function terminalsFor(options: Partial<ConstructorParameters<typeof Terminals>[0]> = {}): Terminals {
  const terminals = new Terminals({
    spawn,
    shell: { file: "/bin/sh", args: [] },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ ", HOME: process.env.HOME ?? "/" },
    ...options,
  });
  open.push(terminals);
  return terminals;
}

/** A subscriber that records frames and resolves `until` once its text matches. */
function watchOutput(terminals: Terminals, id: string, since?: number) {
  const frames: TerminalFrame[] = [];
  let text = "";
  const waiters: { test: (text: string) => boolean; resolve: () => void }[] = [];
  let ended: string | undefined;
  const detach = terminals.attach(id, since, {
    output: async (frame) => {
      frames.push(frame);
      text = frame.reset === true ? frame.data : text + frame.data;
      for (const waiter of waiters.filter((w) => w.test(text))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    ended: (reason) => {
      ended = reason;
    },
  });
  return {
    frames,
    text: () => text,
    ended: () => ended,
    detach,
    until: (test: RegExp | string) =>
      new Promise<void>((resolve) => {
        const match = (value: string) => (typeof test === "string" ? value.includes(test) : test.test(value));
        if (match(text)) resolve();
        else waiters.push({ test: match, resolve });
      }),
  };
}

function watchList(terminals: Terminals, owner = OWNER) {
  let current: TerminalList | undefined;
  const waiters: { test: (list: TerminalList) => boolean; resolve: () => void }[] = [];
  const stop = terminals.watch(owner, (list) => {
    current = list;
    for (const waiter of waiters.filter((w) => w.test(list))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return {
    current: () => current!,
    stop,
    until: (test: (list: TerminalList) => boolean) =>
      new Promise<void>((resolve) => {
        if (current !== undefined && test(current)) resolve();
        else waiters.push({ test, resolve });
      }),
  };
}

describe("Terminals", () => {
  it("runs a shell in the owner's checkout and carries input and output", async () => {
    const dir = await tempDir();
    try {
      const terminals = terminalsFor();
      const id = terminals.open(OWNER, dir.path, SIZE);
      const output = watchOutput(terminals, id);
      terminals.input(id, "pwd; echo done-$((40 + 2))\r");
      await output.until(/done-42/);
      expect(output.text()).toContain(dir.path.split("/").at(-1));
    } finally {
      await dir.remove();
    }
  });

  it("lists terminals in creation order with Terminal N names that never repeat", async () => {
    const terminals = terminalsFor();
    const list = watchList(terminals);
    const first = terminals.open(OWNER, "/", SIZE);
    const second = terminals.open(OWNER, "/", SIZE);
    terminals.close(first);
    terminals.open(OWNER, "/", SIZE);
    await list.until((value) => value.terminals.length === 2);
    expect(list.current().owner).toBe(OWNER);
    expect(list.current().terminals.map((t) => t.name)).toEqual(["Terminal 2", "Terminal 3"]);
    expect(list.current().terminals[0]!.id).toBe(second);
    // Ids are random, not a counter a device could walk.
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses past the limit, counting exited terminals", async () => {
    const terminals = terminalsFor({ limit: 2 });
    const list = watchList(terminals);
    const first = terminals.open(OWNER, "/", SIZE);
    terminals.open(OWNER, "/", SIZE);
    terminals.input(first, "exit 0\r");
    await list.until((value) => value.terminals[0]?.exit !== undefined);
    expect(() => terminals.open(OWNER, "/", SIZE)).toThrow("Terminal limit reached (2)");
    // Another owner has its own budget.
    expect(() => terminals.open(8 as ConversationId, "/", SIZE)).not.toThrow();
  });

  it("keeps an exited terminal with its code, and restart runs a new shell after a reset", async () => {
    const terminals = terminalsFor();
    const list = watchList(terminals);
    const id = terminals.open(OWNER, "/", SIZE);
    const output = watchOutput(terminals, id);
    terminals.input(id, "echo before-$((1 + 1)); exit 3\r");
    await list.until((value) => value.terminals[0]?.exit !== undefined);
    expect(list.current().terminals[0]!.exit).toEqual({ code: 3 });

    terminals.restart(id, SIZE);
    await list.until((value) => value.terminals[0]?.exit === undefined);
    terminals.input(id, "echo after-$((1 + 1))\r");
    await output.until(/after-2\r?\n/);
    expect(output.frames.some((frame) => frame.reset === true)).toBe(true);
    expect(output.text()).not.toContain("before-2");
  });

  it("resets a viewer that resumes from a position before a restart", async () => {
    const terminals = terminalsFor();
    const id = terminals.open(OWNER, "/", SIZE);
    const before = watchOutput(terminals, id);
    terminals.input(id, "echo old-$((1 + 1))\r");
    // Read everything, prompt included, so the position is the old output's end.
    await before.until(/old-2\r?\n[^]*\$ $/);
    const position = before.frames.at(-1)!.seq;
    before.detach();

    terminals.restart(id, SIZE);
    const after = watchOutput(terminals, id, position);
    terminals.input(id, "echo new-$((1 + 1))\r");
    await after.until(/new-2\r?\n/);
    expect(after.frames[0]!.reset).toBe(true);
  });

  it("leaves nothing behind when the pty can't start, and shows a failed restart as exited", async () => {
    let fail = true;
    const terminals = terminalsFor({
      limit: 1,
      spawn: (...args) => {
        if (fail) throw new Error("out of ptys");
        return spawn(...args);
      },
    });
    const list = watchList(terminals);
    expect(() => terminals.open(OWNER, "/", SIZE)).toThrow("out of ptys");
    expect(list.current().terminals).toEqual([]);

    fail = false;
    const id = terminals.open(OWNER, "/", SIZE);
    fail = true;
    expect(() => terminals.restart(id, SIZE)).toThrow("out of ptys");
    expect(list.current().terminals[0]).toMatchObject({ id, exit: { code: null } });
  });

  it("resizes the pty and reports the size in the list", async () => {
    const terminals = terminalsFor();
    const list = watchList(terminals);
    const id = terminals.open(OWNER, "/", SIZE);
    const output = watchOutput(terminals, id);
    terminals.resize(id, { cols: 132, rows: 43 });
    terminals.input(id, "stty size\r");
    await output.until(/43 132/);
    await list.until((value) => value.terminals[0]?.cols === 132);
    expect(list.current().terminals[0]).toMatchObject({ cols: 132, rows: 43 });
  });

  it("takes the typing device's size when it differs", async () => {
    const terminals = terminalsFor();
    const id = terminals.open(OWNER, "/", SIZE);
    const output = watchOutput(terminals, id);
    terminals.input(id, "stty size\r", { cols: 100, rows: 30 });
    await output.until(/30 100/);
  });

  it("names a terminal after the shell's window title until it is renamed", async () => {
    const terminals = terminalsFor();
    const list = watchList(terminals);
    const id = terminals.open(OWNER, "/", SIZE);
    terminals.input(id, "printf '\\033]0;build server\\007'\r");
    await list.until((value) => value.terminals[0]?.name === "build server");

    terminals.rename(id, "dev");
    terminals.input(id, "printf '\\033]2;other\\007'\r");
    await list.until((value) => value.terminals[0]?.name === "dev");
    expect(list.current().terminals[0]!.renamed).toBe(true);

    terminals.rename(id, null);
    await list.until((value) => value.terminals[0]?.name === "other");
    expect(list.current().terminals[0]!.renamed).toBe(false);
  });

  it("replays from a known position, or the whole buffer with reset once it fell out", async () => {
    const terminals = terminalsFor({ bufferSize: 4096 });
    const id = terminals.open(OWNER, "/", SIZE);
    const first = watchOutput(terminals, id);
    terminals.input(id, "echo mark-$((0 + 1))\r");
    await first.until(/mark-1\r?\n/);
    const position = first.frames.at(-1)!.seq;
    first.detach();

    terminals.input(id, "echo mark-$((1 + 1))\r");
    const live = watchOutput(terminals, id);
    await live.until(/mark-2\r?\n/);

    const resumed = watchOutput(terminals, id, position);
    await resumed.until(/mark-2\r?\n/);
    expect(resumed.frames[0]!.reset).toBeUndefined();
    expect(resumed.text()).not.toContain("mark-1\r\n");

    // Push the remembered position out of the 4 KiB buffer.
    terminals.input(id, "i=0; while [ $i -lt 600 ]; do echo filler-$i; i=$((i+1)); done; echo mark-$((2 + 1))\r");
    await live.until(/mark-3\r?\n/);
    const late = watchOutput(terminals, id, position);
    await late.until(/mark-3\r?\n/);
    expect(late.frames[0]!.reset).toBe(true);
    expect(late.frames[0]!.data.length).toBeLessThanOrEqual(4096);
  });

  it("keeps the pty and other viewers going while one viewer stops reading", async () => {
    const terminals = terminalsFor({ bufferSize: 4096 });
    const id = terminals.open(OWNER, "/", SIZE);
    terminals.attach(id, undefined, { output: () => new Promise(() => {}), ended: () => {} });
    const reader = watchOutput(terminals, id);
    terminals.input(id, "i=0; while [ $i -lt 500 ]; do echo line-$i; i=$((i+1)); done; echo fin-$((6 * 7))\r");
    await reader.until(/fin-42\r?\n/);
  });

  it("ends viewers and drops the entry on close", async () => {
    const terminals = terminalsFor();
    const list = watchList(terminals);
    const id = terminals.open(OWNER, "/", SIZE);
    const output = watchOutput(terminals, id);
    terminals.close(id);
    await list.until((value) => value.terminals.length === 0);
    expect(output.ended()).toBe("Terminal closed");
    expect(() => terminals.input(id, "x")).toThrow("Unknown terminal");
  });

  it("closes every terminal of the given owners, and all of them on closeAll", async () => {
    const terminals = terminalsFor();
    const fork = 9 as ConversationId;
    const other = 11 as ConversationId;
    terminals.open(OWNER, "/", SIZE);
    terminals.open(fork, "/", SIZE);
    const kept = terminals.open(other, "/", SIZE);
    terminals.closeOwners([OWNER, fork]);
    expect(watchList(terminals, OWNER).current().terminals).toEqual([]);
    expect(watchList(terminals, fork).current().terminals).toEqual([]);
    expect(watchList(terminals, other).current().terminals.map((t) => t.id)).toEqual([kept]);
    terminals.closeAll();
    expect(watchList(terminals, other).current().terminals).toEqual([]);
  });
});
