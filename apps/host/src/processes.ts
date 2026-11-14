// Background processes the host runs for a conversation family (ADR-0045).
// They are OS processes in this host's memory, not Durable tasks: the only
// durable state is the family root's `pinomad.processes` document. A process
// started by any conversation belongs to that conversation (its checkout is
// the working directory) but shares its family's document and limit.
//
// Output uses the same bounded, positioned buffer as terminals. On an exit
// with no stop reason the host reports it to the conversation that started the
// process, and the report and the family-root document update share one
// commit. A stop reason is remembered before any signal, so an exit after that
// point is a stop and is never reported.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import {
  isProcessActive,
  type ProcessId,
  type ProcessInfo,
  type ProcessOutput,
  type ProcessState,
  type ProcessStopReason,
  type ProcessesHello,
} from "@pinomad/protocol/processes.ts";
import type { HostValue } from "./host-value.ts";
import { Published } from "./host-value.ts";
import { IndexDoc, familyRoot } from "./organization.ts";
import { ProcessDoc, type ProcessesDocValue } from "./process-doc.ts";
import { OutputBuffer, type OutputSink } from "./output-buffer.ts";
import { loginShell, shellEnv, type PtyProcess, type SpawnPty } from "./terminals.ts";

export const PROCESS_LIMIT = 8;
/** Ended entries the document keeps; older ones fall off with their output. */
export const ENDED_PROCESS_LIMIT = 20;
/** Total output retained for ended processes across the whole host. */
export const ENDED_OUTPUT_BUDGET = 64 * 1024 * 1024;
export const STOP_GRACE_MS = 5_000;
export const GROUP_WAIT_MS = 2_000;
const OUTPUT_CHUNK = 16 * 1024;
const REPORT_LIMIT = 4 * 1024;
const REPORT_LINES = 40;
const REPORT_TAIL = "\n\nLast output:\n";

export interface ProcessesOptions {
  /** Resolved after Harness.open; `open()` is called once it exists. */
  readonly harness: () => Harness;
  readonly spawn: SpawnPty;
  readonly shell: { readonly file: string; readonly args: readonly string[] };
  readonly env: Record<string, string>;
  readonly limit?: number;
  readonly endedLimit?: number;
  readonly outputBudget?: number;
  /** How much raw output each process keeps for replay, in UTF-16 code units. */
  readonly bufferSize?: number;
  /** How long output is gathered before it reaches viewers. */
  readonly flushMs?: number;
  readonly stopGraceMs?: number;
  /** How long to wait after SIGKILL before accepting a group that still appears alive. */
  readonly groupWaitMs?: number;
  /** Sends a signal to a pid (negative for a process group); injected by tests. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether the process group still has live members; injected by tests. */
  readonly groupAlive?: (pid: number) => boolean;
  /** True while an immediate upgrade is installing: exit at once but do not report. */
  readonly installing?: () => boolean;
  readonly onOutput?: () => void;
  readonly now?: () => number;
  readonly diagnostic?: (message: string) => void;
}

/** The runtime surface the processes extension depends on (ADR-0004). */
export interface ProcessRuntime {
  readonly limit: number;
  start(input: {
    readonly conversationId: ConversationId;
    readonly command: string;
    readonly name: string;
    readonly cwd: string;
    /** A replay reuses the id its tool call memoized; an existing live entry wins. */
    readonly id?: ProcessId;
  }, context: Context): Promise<ProcessInfo>;
  output(input: {
    readonly conversationId: ConversationId;
    readonly id: ProcessId;
    readonly since?: number;
  }, context: Context): Promise<ProcessOutput>;
  stop(input: {
    readonly conversationId: ConversationId;
    readonly id: ProcessId;
    readonly reason?: ProcessStopReason;
  }, context: Context): Promise<ProcessInfo>;
  list(conversationId: ConversationId, context: Context): Promise<readonly ProcessInfo[]>;
}

interface MutableInfo {
  id: ProcessId;
  owner: ConversationId;
  name: string;
  command: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  state: ProcessState;
}

interface Entry {
  readonly info: MutableInfo;
  readonly root: ConversationId;
  readonly output: OutputBuffer;
  readonly done: Promise<void>;
  resolveDone: () => void;
  pty: PtyProcess | undefined;
  stopReason: ProcessStopReason | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  groupTimer: ReturnType<typeof setTimeout> | undefined;
  /** SIGKILL was sent; do not schedule a second grace period. */
  killed: boolean;
  killedAt: number | undefined;
  killWaitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The stopped document write is running or done. */
  finishing: boolean;
  generation: number;
  released: boolean;
}

export class Processes implements ProcessRuntime {
  readonly #options: ProcessesOptions;
  readonly #limit: number;
  readonly #endedLimit: number;
  readonly #outputBudget: number;
  readonly #processes = new Map<ProcessId, Entry>();
  readonly #roots = new Map<ConversationId, ConversationId>();
  /** Conversation ids whose family is being archived: no new process may start. */
  readonly #sealed = new Set<ConversationId>();
  readonly #busy: Published<boolean>;
  #closing = false;

  constructor(options: ProcessesOptions) {
    this.#options = options;
    this.#limit = options.limit ?? PROCESS_LIMIT;
    this.#endedLimit = options.endedLimit ?? ENDED_PROCESS_LIMIT;
    this.#outputBudget = options.outputBudget ?? ENDED_OUTPUT_BUDGET;
    this.#busy = new Published(false, (a, b) => a === b);
  }

  get limit(): number {
    return this.#limit;
  }

  get hello(): ProcessesHello {
    return { limit: this.#limit };
  }

  /** Live processes for the idle-upgrade check (ADR-0043 §5). */
  get busy(): HostValue<boolean> {
    return this.#busy;
  }

  /** Settle every entry the previous host left `starting` or `running` to `lost`. */
  async open(context: Context): Promise<void> {
    await settleLostProcesses(this.#options.harness(), context);
  }

  async start(input: {
    readonly conversationId: ConversationId;
    readonly command: string;
    readonly name: string;
    readonly cwd: string;
    readonly id?: ProcessId;
  }, context: Context): Promise<ProcessInfo> {
    const harness = this.#options.harness();
    const root = await this.#root(input.conversationId);
    if (this.#closing) throw new Error("The host is shutting down");
    if (this.#options.installing?.() === true) throw new Error("An upgrade is installing; try again after it finishes");
    if (
      this.#sealed.has(input.conversationId)
      || (await this.#archivedInFamily(harness, input.conversationId, context))
    ) {
      throw new Error("This conversation is archived");
    }

    // The archive check above awaits; re-check the state that admission
    // depends on before the synchronous check-and-register stretch.
    if (this.#closing) throw new Error("The host is shutting down");
    if (this.#options.installing?.() === true) throw new Error("An upgrade is installing; try again after it finishes");
    if (this.#sealed.has(input.conversationId)) throw new Error("This conversation is archived");

    const existing = input.id === undefined ? undefined : this.#processes.get(input.id);
    if (existing !== undefined) {
      if (!isProcessActive(existing.info.state)) throw new Error(`Process ${existing.info.id} has already ended`);
      return info(existing);
    }

    // From here to the admission commit is one synchronous stretch: a second
    // start cannot observe the limit before this entry is registered.
    const active = [...this.#processes.values()].filter(
      (entry) => entry.root === root && isProcessActive(entry.info.state),
    ).length;
    if (active >= this.#limit) throw new Error(`Process limit reached (${this.#limit})`);

    const id = input.id ?? randomUUID();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: Entry = {
      info: {
        id,
        owner: input.conversationId,
        name: input.name,
        command: input.command,
        startedAt: this.#now(),
        state: "starting",
      },
      root,
      output: new OutputBuffer({
        ...(this.#options.bufferSize === undefined ? {} : { bufferSize: this.#options.bufferSize }),
        ...(this.#options.flushMs === undefined ? {} : { flushMs: this.#options.flushMs }),
        onFlush: () => this.#options.onOutput?.(),
      }),
      done,
      resolveDone,
      pty: undefined,
      stopReason: undefined,
      killTimer: undefined,
      groupTimer: undefined,
      killed: false,
      killedAt: undefined,
      killWaitTimer: undefined,
      finishing: false,
      generation: 0,
      released: false,
    };
    this.#processes.set(id, entry);
    this.#refreshBusy();
    try {
      await harness.commit((tx) => this.#applyDoc(tx, entry), context);
    } catch (error) {
      this.#processes.delete(id);
      this.#refreshBusy();
      throw error;
    }

    try {
      this.#spawn(entry, input.cwd);
    } catch (error) {
      await this.#fail(entry, message(error), context);
      throw error;
    }
    await this.#write(entry, context);
    return info(entry);
  }

  async output(input: {
    readonly conversationId: ConversationId;
    readonly id: ProcessId;
    readonly since?: number;
  }, context: Context): Promise<ProcessOutput> {
    const root = await this.#root(input.conversationId);
    const entry = this.#processes.get(input.id);
    if (entry !== undefined && entry.root === root && !entry.released) {
      // Show what the pty already wrote without waiting for the 8 ms flush.
      entry.output.flush();
      const slice = entry.output.snapshot(input.since, OUTPUT_CHUNK);
      const state = entry.info.state;
      return {
        text: stripAnsi(slice.text),
        next: slice.next,
        truncated: slice.truncated,
        status: state,
        ...(typeof state === "object" && "exited" in state ? { exitCode: state.exited } : {}),
      };
    }
    // A lost or previous-host entry may have no memory; if the family document
    // still lists it, answer with that state and say the output is gone.
    const record = await this.#docEntry(root, input.id, context);
    if (record === undefined) throw new Error("Unknown process");
    return {
      text: "",
      next: input.since ?? 0,
      truncated: true,
      status: record.state,
      ...(typeof record.state === "object" && "exited" in record.state ? { exitCode: record.state.exited } : {}),
      released: true,
    };
  }

  async stop(input: {
    readonly conversationId: ConversationId;
    readonly id: ProcessId;
    readonly reason?: ProcessStopReason;
  }, context: Context): Promise<ProcessInfo> {
    const root = await this.#root(input.conversationId);
    const entry = this.#processes.get(input.id);
    if (entry !== undefined && entry.root === root) {
      return await this.#stopEntry(entry, input.reason ?? "user", context);
    }
    if (entry !== undefined) throw new Error("This process does not belong to the conversation's family");
    // The document may still describe an ended or lost process this host no
    // longer tracks; there is nothing left to signal, so return that state.
    const record = await this.#docEntry(root, input.id, context);
    if (record === undefined) throw new Error("Unknown process");
    return record;
  }

  async list(conversationId: ConversationId, context: Context): Promise<readonly ProcessInfo[]> {
    const root = await this.#root(conversationId);
    const doc = await this.#options.harness().snapshot(ProcessDoc, root, context);
    return doc?.processes ?? [];
  }

  async #docEntry(
    root: ConversationId,
    id: ProcessId,
    context: Context,
  ): Promise<ProcessInfo | undefined> {
    const doc = await this.#options.harness().snapshot(ProcessDoc, root, context);
    return doc?.processes.find((process) => process.id === id);
  }

  /** Pipe one process's output to a viewer; the returned stop detaches it. */
  attach(id: ProcessId, since: number | undefined, sink: OutputSink): () => void {
    const entry = this.#processes.get(id);
    if (entry === undefined) throw new Error("Unknown process");
    if (entry.released) throw new Error("The output of this process is no longer available");
    return entry.output.attach(since, sink);
  }

  /** Close admission for these conversations while their archive commits. */
  seal(owners: Iterable<ConversationId>): void {
    for (const owner of owners) this.#sealed.add(owner);
  }

  unseal(owners: Iterable<ConversationId>): void {
    for (const owner of owners) this.#sealed.delete(owner);
  }

  /** Stop every process started in these conversations, then release their output. */
  async closeOwners(owners: Iterable<ConversationId>, reason: ProcessStopReason, context: Context): Promise<void> {
    const set = new Set(owners);
    const entries = [...this.#processes.values()].filter((entry) => set.has(entry.info.owner));
    await Promise.all(entries.map((entry) => this.#stopEntry(entry, reason, context)));
    for (const entry of entries) {
      this.#release(entry, "Conversation archived");
      this.#processes.delete(entry.info.id);
      entry.resolveDone();
    }
    this.#refreshBusy();
  }

  /** An immediate upgrade's install: stop everything without closing the runtime. */
  async drain(context: Context): Promise<void> {
    const entries = [...this.#processes.values()].filter((entry) => isProcessActive(entry.info.state));
    await Promise.all(entries.map((entry) => this.#stopEntry(entry, "shutdown", context)));
  }

  /** The host is closing: refuse new starts, then stop everything and release output. */
  async close(context: Context): Promise<void> {
    this.#closing = true;
    const entries = [...this.#processes.values()];
    await Promise.all(
      entries.filter((entry) => isProcessActive(entry.info.state)).map((entry) => this.#stopEntry(entry, "shutdown", context)),
    );
    for (const entry of entries) {
      this.#release(entry, "The host shut down");
      this.#processes.delete(entry.info.id);
      entry.resolveDone();
    }
    this.#sealed.clear();
    this.#refreshBusy();
  }

  /**
   * Whether the conversation or any ancestor in its family is archived. A
   * fork's subagents have no Index entry of their own, so walk the parent and
   * owner links; the root document's owner is checked at the end of the chain.
   */
  async #archivedInFamily(harness: Harness, conversationId: ConversationId, context: Context): Promise<boolean> {
    let current: ConversationId | undefined = conversationId;
    const seen = new Set<ConversationId>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const index = await harness.snapshot(IndexDoc, context);
      if (index?.conversations.some((entry) => entry.id === current && entry.archived === true) === true) return true;
      const record = await harness.commit((tx) => tx.conversation(current!), BACKGROUND_CONTEXT);
      current = record?.parent?.conversationId ?? record?.owner?.conversationId;
    }
    return false;
  }

  async #root(conversationId: ConversationId): Promise<ConversationId> {
    const cached = this.#roots.get(conversationId);
    if (cached !== undefined) return cached;
    const root = await familyRoot(this.#options.harness(), conversationId, BACKGROUND_CONTEXT);
    this.#roots.set(conversationId, root);
    return root;
  }

  #spawn(entry: Entry, cwd: string): void {
    const generation = ++entry.generation;
    const { shell, env } = this.#options;
    const pty = this.#options.spawn(shell.file, [...shell.args, "-c", entry.info.command], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    entry.pty = pty;
    if (pty.pid !== undefined) entry.info.pid = pty.pid;
    // Running before the listeners attach: a pty that exits immediately must
    // not be resurrected by the write that follows the spawn.
    entry.info.state = "running";
    pty.onData((data) => {
      if (entry.generation !== generation || entry.released) return;
      entry.output.push(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (entry.generation !== generation || entry.released || !this.#processes.has(entry.info.id)) return;
      void this.#exit(entry, exitCode, signal);
    });
  }

  async #exit(entry: Entry, exitCode: number | null, signal: number | undefined): Promise<void> {
    entry.pty = undefined;
    entry.output.flush();
    if (entry.stopReason === undefined && this.#closing) entry.stopReason = "shutdown";
    if (entry.stopReason !== undefined) {
      // The pty's exit is only the shell's. A child that ignored SIGTERM can
      // still be in the process group, so keep the SIGKILL timer and wait for
      // the whole group before declaring the process stopped.
      if (this.#groupAlive(entry)) {
        this.#ensureKillTimer(entry);
        this.#pollGroup(entry);
        return;
      }
      await this.#finishStopped(entry);
      return;
    }

    this.#clearStopTimers(entry);
    entry.info.endedAt = this.#now();
    entry.info.state =
      signal === undefined || signal === 0 ? { exited: exitCode } : { exited: null, signal: signalName(signal) };
    const report = this.#options.installing?.() !== true;
    try {
      if (report) await this.#reportAndWrite(entry);
      else await this.#write(entry, BACKGROUND_CONTEXT);
    } catch (error) {
      this.#diagnose(error);
    }
    entry.resolveDone();
    this.#refreshBusy();
    this.#evictOutputs();
  }

  async #finishStopped(entry: Entry): Promise<void> {
    if (entry.finishing) return;
    entry.finishing = true;
    this.#clearStopTimers(entry);
    entry.info.endedAt = this.#now();
    entry.info.state = { stopped: entry.stopReason ?? "shutdown" };
    try {
      await this.#write(entry, BACKGROUND_CONTEXT);
    } catch (error) {
      this.#diagnose(error);
    }
    entry.resolveDone();
    this.#refreshBusy();
    this.#evictOutputs();
  }

  /** SIGTERM already went out; after the grace period the group gets SIGKILL. */
  #ensureKillTimer(entry: Entry): void {
    if (entry.killTimer !== undefined || entry.killed) return;
    const grace = this.#options.stopGraceMs ?? STOP_GRACE_MS;
    entry.killTimer = setTimeout(() => {
      entry.killTimer = undefined;
      entry.killed = true;
      entry.killedAt = this.#now();
      this.#signal(entry, "SIGKILL");
      // A group of zombies can keep kill(-pgid, 0) succeeding forever: never
      // let stop, archive, close or install wait on it without a bound.
      entry.killWaitTimer ??= setTimeout(
        () => this.#finishAfterKillWait(entry),
        this.#options.groupWaitMs ?? GROUP_WAIT_MS,
      );
    }, grace);
  }

  #pollGroup(entry: Entry): void {
    if (entry.groupTimer !== undefined || entry.finishing) return;
    const check = (): void => {
      entry.groupTimer = undefined;
      if (entry.finishing || entry.released || !this.#processes.has(entry.info.id)) return;
      if (!this.#groupAlive(entry)) {
        void this.#finishStopped(entry);
        return;
      }
      const wait = this.#options.groupWaitMs ?? GROUP_WAIT_MS;
      if (entry.killedAt !== undefined && this.#now() - entry.killedAt >= wait) {
        this.#finishAfterKillWait(entry);
        return;
      }
      entry.groupTimer = setTimeout(check, 25);
    };
    check();
  }

  #finishAfterKillWait(entry: Entry): void {
    entry.killWaitTimer = undefined;
    if (entry.finishing || entry.released || !this.#processes.has(entry.info.id)) return;
    if (this.#groupAlive(entry)) {
      this.#diagnose(
        `Process group ${entry.info.pid ?? "unknown"} still appears alive after SIGKILL; marking it stopped`,
      );
    }
    void this.#finishStopped(entry);
  }

  #groupAlive(entry: Entry): boolean {
    const pid = entry.info.pid;
    if (pid === undefined) return false;
    const alive = this.#options.groupAlive ?? ((group: number) => {
      try {
        process.kill(-group, 0);
        return true;
      } catch {
        return false;
      }
    });
    try {
      return alive(pid);
    } catch {
      return false;
    }
  }

  #clearStopTimers(entry: Entry): void {
    if (entry.killTimer !== undefined) clearTimeout(entry.killTimer);
    if (entry.groupTimer !== undefined) clearTimeout(entry.groupTimer);
    if (entry.killWaitTimer !== undefined) clearTimeout(entry.killWaitTimer);
    entry.killTimer = undefined;
    entry.groupTimer = undefined;
    entry.killWaitTimer = undefined;
  }

  async #fail(entry: Entry, reason: string, context: Context): Promise<void> {
    entry.generation++;
    entry.pty = undefined;
    entry.info.state = { failed: reason };
    entry.info.endedAt = this.#now();
    try {
      await this.#write(entry, context);
    } catch (error) {
      this.#diagnose(error);
    }
    entry.resolveDone();
    this.#refreshBusy();
    this.#evictOutputs();
  }

  async #stopEntry(entry: Entry, reason: ProcessStopReason, context: Context): Promise<ProcessInfo> {
    if (!isProcessActive(entry.info.state)) return info(entry);
    // First stop reason wins: an exit after this point is always a stop.
    entry.stopReason ??= reason;
    this.#signal(entry, "SIGTERM");
    this.#ensureKillTimer(entry);
    await entry.done;
    return info(entry);
  }

  #signal(entry: Entry, signal: NodeJS.Signals): void {
    const pid = entry.info.pid;
    try {
      if (pid !== undefined) {
        const kill = this.#options.kill ?? ((target: number, value: NodeJS.Signals) => process.kill(target, value));
        // Negative pid targets the whole process group; node-pty's own kill()
        // reaches only the shell, which may ignore SIGHUP/SIGTERM.
        kill(-pid, signal);
      } else {
        entry.pty?.kill(signal);
      }
    } catch {
      // Already gone.
    }
  }

  async #write(entry: Entry, context: Context): Promise<void> {
    const kept = await this.#options.harness().commit((tx) => this.#applyDoc(tx, entry), context);
    this.#retireMissing(kept, entry.root);
  }

  async #reportAndWrite(entry: Entry): Promise<void> {
    const harness = this.#options.harness();
    // The owner started the process (it may be a fork); the document still
    // belongs to the family root.
    const conversation = await harness.conversation(entry.info.owner, BACKGROUND_CONTEXT);
    const report = reportText(entry);
    if (conversation === undefined) {
      await this.#write(entry, BACKGROUND_CONTEXT);
      return;
    }
    const kept = await conversation.commit(async (tx) => {
      // The admission must come before the first table write (ReadAfterWrite),
      // and the document write comes after: one commit carries both.
      await conversation.submit(tx, {
        type: "input",
        content: report,
        whenBusy: "steer",
        requestId: `process:${entry.info.id}:exit`,
      });
      return this.#applyDoc(tx, entry);
    }, BACKGROUND_CONTEXT);
    this.#retireMissing(kept, entry.root);
  }

  async #applyDoc(tx: Tx, entry: Entry): Promise<Set<ProcessId>> {
    const doc: ProcessesDocValue = await tx.doc(ProcessDoc, entry.root);
    const next = docEntry(entry.info);
    const index = doc.processes.findIndex((process) => process.id === entry.info.id);
    if (index === -1) doc.processes.push(next);
    else doc.processes[index] = next;
    // Keep every live entry and the most recently ended ones.
    const ended = doc.processes
      .filter((process) => !isProcessActive(process.state))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .slice(0, this.#endedLimit);
    const keep = new Set(ended.map((process) => process.id));
    doc.processes = doc.processes.filter(
      (process) => isProcessActive(process.state) || keep.has(process.id),
    );
    return new Set(doc.processes.map((process) => process.id));
  }

  #retireMissing(kept: ReadonlySet<ProcessId>, root: ConversationId): void {
    for (const [id, entry] of this.#processes) {
      if (entry.root !== root || kept.has(id) || isProcessActive(entry.info.state)) continue;
      this.#release(entry, "Output released");
      this.#processes.delete(id);
      entry.resolveDone();
    }
    this.#refreshBusy();
  }

  #release(entry: Entry, reason: string): void {
    if (entry.released) return;
    entry.released = true;
    this.#clearStopTimers(entry);
    entry.output.close(reason);
    // The entry may outlive its output (history still lists it); let the
    // retained bytes go now rather than with the entry.
    entry.output.discard();
  }

  /** Keep ended output under the host-wide budget, oldest exits first. */
  #evictOutputs(): void {
    let total = 0;
    const ended: Entry[] = [];
    for (const entry of this.#processes.values()) {
      if (isProcessActive(entry.info.state) || entry.released) continue;
      total += entry.output.length;
      ended.push(entry);
    }
    if (total <= this.#outputBudget) return;
    ended.sort((a, b) => (a.info.endedAt ?? a.info.startedAt) - (b.info.endedAt ?? b.info.startedAt));
    for (const entry of ended) {
      if (total <= this.#outputBudget) return;
      total -= entry.output.length;
      this.#release(entry, "Output released");
    }
  }

  #refreshBusy(): void {
    this.#busy.set([...this.#processes.values()].some((entry) => isProcessActive(entry.info.state)));
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #diagnose(error: unknown): void {
    (this.#options.diagnostic ?? console.error)(`Background process update failed: ${message(error)}`);
  }
}

export interface StartProcessesOptions extends Partial<ProcessesOptions> {
  readonly harness: () => Harness;
  /** Replaces `import("@lydell/node-pty")`, for tests of the failure path. */
  readonly load?: () => Promise<unknown>;
  readonly diagnostic?: (message: string) => void;
}

/**
 * Load the pty module and start the process registry. Without it the host
 * keeps running: `hello.processes` is left out, the extension registers no
 * tools, and start-up settlement (`settleLostProcesses`) still runs.
 */
export async function startProcesses(options: StartProcessesOptions): Promise<Processes | undefined> {
  let spawn = options.spawn;
  if (spawn === undefined) {
    try {
      const loaded = (options.load === undefined ? await import("@lydell/node-pty") : await options.load()) as { spawn?: unknown };
      if (typeof loaded.spawn !== "function") throw new Error("the module has no spawn()");
      spawn = loaded.spawn as SpawnPty;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      (options.diagnostic ?? console.error)(
        `Background processes unavailable: cannot load @lydell/node-pty on ${process.platform} (${process.arch}); `
          + `missing @lydell/node-pty-${process.platform}-${process.arch}. `
          + `Install without --omit=optional; the host continues without hello.processes. (${detail})`,
      );
      return undefined;
    }
  }
  return new Processes({
    ...options,
    spawn,
    shell: options.shell ?? loginShell(),
    env: options.env ?? shellEnv(process.env),
  });
}

/**
 * Settle whatever the previous host left live to `lost`. This reads only
 * documents, so it works even when the pty module did not load.
 */
export async function settleLostProcesses(harness: Harness, context: Context): Promise<void> {
  let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
    for (const record of page.items) {
      // Process documents live only on family roots; skip every fork and
      // subagent before paying for a document snapshot.
      if (record.parent !== undefined || record.owner !== undefined) continue;
      const doc = await harness.snapshot(ProcessDoc, record.id, context);
      if (doc === undefined || !doc.processes.some((process) => process.state === "starting" || process.state === "running")) {
        continue;
      }
      await harness.commit(async (tx) => {
        const value = await tx.doc(ProcessDoc, record.id);
        for (const process of value.processes) {
          if (process.state === "starting" || process.state === "running") process.state = "lost";
        }
      }, context);
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

function info(entry: Entry): ProcessInfo {
  return { ...entry.info, ...(entry.info.pid === undefined ? {} : { pid: entry.info.pid }) };
}

function docEntry(entry: MutableInfo): ProcessInfo {
  return {
    id: entry.id,
    owner: entry.owner,
    name: entry.name,
    command: entry.command,
    ...(entry.pid === undefined ? {} : { pid: entry.pid }),
    startedAt: entry.startedAt,
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    state: typeof entry.state === "object" ? { ...entry.state } : entry.state,
  };
}

function reportText(entry: Entry): string {
  const state = entry.info.state;
  const outcome =
    typeof state === "object" && "exited" in state
      ? state.signal === undefined
        ? `exited with code ${state.exited ?? "unknown"}`
        : `exited after signal ${state.signal}`
      : "exited";
  const raw = entry.output.snapshot(undefined, Number.MAX_SAFE_INTEGER).text;
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const tail = clean.split("\n").slice(-REPORT_LINES).join("\n").trimEnd();
  const header = `Background process "${entry.info.name}" (${entry.info.id}) ${outcome}.`;
  const available = Math.max(0, REPORT_LIMIT - header.length - REPORT_TAIL.length);
  const body = truncateTail(tail, available);
  return body === "" ? header : `${header}${REPORT_TAIL}${body}`;
}

/** Strip CSI, OSC and other escape sequences from text meant for a model or UI. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Keep the end of `text`, never splitting a surrogate pair at the cut. */
function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let from = text.length - max;
  const code = text.charCodeAt(from);
  if (code >= 0xdc00 && code <= 0xdfff) from++;
  return text.slice(from);
}

function signalName(signal: number): string {
  return signal === 1 ? "SIGHUP"
    : signal === 2 ? "SIGINT"
    : signal === 9 ? "SIGKILL"
    : signal === 15 ? "SIGTERM"
    : String(signal);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
