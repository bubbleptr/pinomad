// Interactive terminals the host runs for a conversation family (ADR-0040 §5,
// ADR-0041). Each terminal is a pty owned by a conversation — the family
// root, or a legacy fork with its own worktree — and lives in memory only:
// a client disconnecting leaves it running, the host stopping ends it.
//
// Output goes into one bounded buffer per terminal. Every viewer reads from
// its own position in that buffer and is sent the next piece once the last
// was handed to its transport, so a slow viewer never pauses the pty or
// other viewers: if it falls behind the buffer, it gets the whole buffer
// again with `reset`.
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { TerminalId, TerminalInfo, TerminalList } from "@pinomad/protocol/terminals.ts";

/** The part of node-pty's `IPty` the host uses. */
export interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess;

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** One `output` frame's content, before the gateway names the stream. */
export interface TerminalFrame {
  readonly seq: number;
  readonly data: string;
  readonly reset?: true;
}

export interface TerminalSink {
  /** Resolves once the frame is handed to the transport; the next one waits for it. */
  output(frame: TerminalFrame): Promise<void>;
  ended(reason: string): void;
}

export interface TerminalsOptions {
  readonly spawn: SpawnPty;
  readonly shell: { readonly file: string; readonly args: readonly string[] };
  /** The shell's environment, before TERM and COLORTERM. */
  readonly env: Record<string, string>;
  readonly limit?: number;
  /** How much output each terminal keeps for replay, in UTF-16 code units. */
  readonly bufferSize?: number;
  /** How long pty output is gathered before it is sent. */
  readonly flushMs?: number;
  /** The largest piece of output one frame carries. */
  readonly maxChunk?: number;
}

export const TERMINAL_LIMIT = 8;
const BUFFER_SIZE = 512 * 1024;
const FLUSH_MS = 8;
// Raw output can grow 6× as JSON (\u001b), so a 16 KiB piece stays under
// ~100 KiB on the wire: a conversation frame never waits behind much.
const MAX_CHUNK = 16 * 1024;
// A window title longer than this is not one; drop the partial sequence.
const MAX_TITLE = 1024;
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

interface Viewer {
  readonly sink: TerminalSink;
  /** The next position to send; `undefined` → send the whole buffer with `reset`. */
  position: number | undefined;
  sending: boolean;
}

interface Terminal {
  readonly id: TerminalId;
  readonly owner: ConversationId;
  readonly cwd: string;
  readonly number: number;
  pty: PtyProcess | undefined;
  /** Bumped per shell, so a killed shell's late exit doesn't mark its successor. */
  generation: number;
  cols: number;
  rows: number;
  title: string | undefined;
  rename: string | undefined;
  exit: TerminalInfo["exit"];
  /** Output kept for replay: `buffer` holds positions `start` to `start + buffer.length`. */
  buffer: string;
  start: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** An unfinished title sequence at the end of the last output. */
  titleCarry: string;
  readonly viewers: Set<Viewer>;
}

export class Terminals {
  readonly #options: TerminalsOptions;
  readonly #limit: number;
  readonly #terminals = new Map<TerminalId, Terminal>();
  readonly #numbers = new Map<ConversationId, number>();
  readonly #watchers = new Map<ConversationId, Set<(list: TerminalList) => void>>();

  constructor(options: TerminalsOptions) {
    this.#options = options;
    this.#limit = options.limit ?? TERMINAL_LIMIT;
  }

  get limit(): number {
    return this.#limit;
  }

  list(owner: ConversationId): TerminalList {
    const terminals = [...this.#terminals.values()].filter((terminal) => terminal.owner === owner).map(info);
    return { owner, limit: this.#limit, terminals };
  }

  /** Calls `listener` with the owner's list now and after every change; returns the stop. */
  watch(owner: ConversationId, listener: (list: TerminalList) => void): () => void {
    let set = this.#watchers.get(owner);
    if (set === undefined) this.#watchers.set(owner, (set = new Set()));
    set.add(listener);
    listener(this.list(owner));
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#watchers.delete(owner);
    };
  }

  open(owner: ConversationId, cwd: string, size: TerminalSize): TerminalId {
    const count = [...this.#terminals.values()].filter((terminal) => terminal.owner === owner).length;
    if (count >= this.#limit) throw new Error(`Terminal limit reached (${this.#limit})`);
    const number = (this.#numbers.get(owner) ?? 0) + 1;
    this.#numbers.set(owner, number);
    const terminal: Terminal = {
      id: randomUUID(),
      owner,
      cwd,
      number,
      pty: undefined,
      generation: 0,
      cols: size.cols,
      rows: size.rows,
      title: undefined,
      rename: undefined,
      exit: undefined,
      buffer: "",
      start: 0,
      pending: "",
      flushTimer: undefined,
      titleCarry: "",
      viewers: new Set(),
    };
    this.#terminals.set(terminal.id, terminal);
    this.#start(terminal);
    this.#changed(owner);
    return terminal.id;
  }

  /** `size` is the sending connection's last reported size; the pty takes it if it differs. */
  input(id: TerminalId, data: string, size?: TerminalSize): void {
    const terminal = this.#get(id);
    if (size !== undefined) this.#resize(terminal, size);
    terminal.pty?.write(data);
  }

  resize(id: TerminalId, size: TerminalSize): void {
    this.#resize(this.#get(id), size);
  }

  rename(id: TerminalId, name: string | null): void {
    const terminal = this.#get(id);
    const trimmed = name?.trim();
    terminal.rename = trimmed === undefined || trimmed === "" ? undefined : trimmed;
    this.#changed(terminal.owner);
  }

  restart(id: TerminalId, size: TerminalSize): void {
    const terminal = this.#get(id);
    this.#stop(terminal);
    // Positions keep counting; the old output is dropped, so every viewer
    // starts over from the new shell's first output.
    terminal.start += terminal.buffer.length + terminal.pending.length;
    terminal.buffer = "";
    terminal.pending = "";
    terminal.titleCarry = "";
    terminal.title = undefined;
    terminal.exit = undefined;
    terminal.cols = size.cols;
    terminal.rows = size.rows;
    for (const viewer of terminal.viewers) viewer.position = undefined;
    this.#start(terminal);
    this.#changed(terminal.owner);
  }

  close(id: TerminalId): void {
    const terminal = this.#get(id);
    this.#remove(terminal);
    this.#changed(terminal.owner);
  }

  /** Close every terminal these conversations own (a family's root was archived). */
  closeOwners(owners: Iterable<ConversationId>): void {
    for (const owner of new Set(owners)) {
      const owned = [...this.#terminals.values()].filter((terminal) => terminal.owner === owner);
      if (owned.length === 0) continue;
      for (const terminal of owned) this.#remove(terminal);
      this.#changed(owner);
    }
  }

  /** The host is stopping: end every shell. */
  closeAll(): void {
    this.closeOwners([...this.#terminals.values()].map((terminal) => terminal.owner));
  }

  /**
   * Stream a terminal's output to `sink`: what came after `since` if the
   * buffer still has it, otherwise the whole buffer with `reset`, then live.
   */
  attach(id: TerminalId, since: number | undefined, sink: TerminalSink): () => void {
    const terminal = this.#get(id);
    const end = terminal.start + terminal.buffer.length;
    const position = since !== undefined && since >= terminal.start && since <= end ? since : undefined;
    const viewer: Viewer = { sink, position, sending: false };
    terminal.viewers.add(viewer);
    void this.#pump(terminal, viewer);
    return () => {
      terminal.viewers.delete(viewer);
    };
  }

  #get(id: TerminalId): Terminal {
    const terminal = this.#terminals.get(id);
    if (terminal === undefined) throw new Error("Unknown terminal");
    return terminal;
  }

  #start(terminal: Terminal): void {
    const generation = ++terminal.generation;
    const { shell, env } = this.#options;
    const pty = this.#options.spawn(shell.file, [...shell.args], {
      name: "xterm-256color",
      cols: terminal.cols,
      rows: terminal.rows,
      cwd: terminal.cwd,
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    terminal.pty = pty;
    pty.onData((data) => {
      if (terminal.generation !== generation) return;
      terminal.pending += data;
      if (terminal.pending.length >= (this.#options.maxChunk ?? MAX_CHUNK)) this.#flush(terminal);
      else terminal.flushTimer ??= setTimeout(() => this.#flush(terminal), this.#options.flushMs ?? FLUSH_MS);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (terminal.generation !== generation || !this.#terminals.has(terminal.id)) return;
      this.#flush(terminal);
      terminal.pty = undefined;
      terminal.exit = signal === undefined || signal === 0 ? { code: exitCode } : { code: exitCode, signal };
      this.#changed(terminal.owner);
    });
  }

  #stop(terminal: Terminal): void {
    if (terminal.flushTimer !== undefined) clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    terminal.generation++;
    const pty = terminal.pty;
    terminal.pty = undefined;
    try {
      pty?.kill();
    } catch {
      // Already gone.
    }
  }

  #remove(terminal: Terminal): void {
    this.#stop(terminal);
    this.#terminals.delete(terminal.id);
    for (const viewer of terminal.viewers) viewer.sink.ended("Terminal closed");
    terminal.viewers.clear();
  }

  #resize(terminal: Terminal, size: TerminalSize): void {
    if (terminal.cols === size.cols && terminal.rows === size.rows) return;
    terminal.cols = size.cols;
    terminal.rows = size.rows;
    try {
      terminal.pty?.resize(size.cols, size.rows);
    } catch {
      // The process exited between the check and the call.
    }
    this.#changed(terminal.owner);
  }

  #flush(terminal: Terminal): void {
    if (terminal.flushTimer !== undefined) clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    const data = terminal.pending;
    if (data === "") return;
    terminal.pending = "";
    terminal.buffer += data;
    const bufferSize = this.#options.bufferSize ?? BUFFER_SIZE;
    if (terminal.buffer.length > bufferSize) {
      // Drop the oldest output, starting the kept part at a line where one is
      // near so a replay doesn't open mid-line.
      let cut = terminal.buffer.length - bufferSize;
      const line = terminal.buffer.indexOf("\n", cut);
      if (line !== -1 && line - cut < 1024) cut = line + 1;
      terminal.buffer = terminal.buffer.slice(cut);
      terminal.start += cut;
    }
    if (this.#readTitle(terminal, data)) this.#changed(terminal.owner);
    for (const viewer of terminal.viewers) void this.#pump(terminal, viewer);
  }

  /** Whether `data` changed the shell's window title (OSC 0 or 2). */
  #readTitle(terminal: Terminal, data: string): boolean {
    const text = terminal.titleCarry + data;
    let title: string | undefined;
    let consumed = 0;
    for (const match of text.matchAll(TITLE)) {
      title = match[1];
      consumed = match.index + match[0].length;
    }
    const open = text.lastIndexOf("\x1b]");
    terminal.titleCarry = open >= consumed && text.length - open <= MAX_TITLE ? text.slice(open) : "";
    if (title === undefined || title === terminal.title) return false;
    terminal.title = title;
    return terminal.rename === undefined;
  }

  async #pump(terminal: Terminal, viewer: Viewer): Promise<void> {
    if (viewer.sending) return;
    viewer.sending = true;
    try {
      const maxChunk = this.#options.maxChunk ?? MAX_CHUNK;
      while (terminal.viewers.has(viewer)) {
        const end = terminal.start + terminal.buffer.length;
        const reset = viewer.position === undefined || viewer.position < terminal.start;
        const from = reset ? terminal.start : viewer.position!;
        // A reset replays the whole buffer at once: the client clears first,
        // so it must not see a partial screen in between.
        if (!reset && from >= end) return;
        let to = reset ? end : Math.min(end, from + maxChunk);
        // Never end a piece between the halves of a surrogate pair.
        if (to < end && isHighSurrogate(terminal.buffer.charCodeAt(to - terminal.start - 1))) to--;
        const data = terminal.buffer.slice(from - terminal.start, to - terminal.start);
        viewer.position = to;
        await viewer.sink.output(reset ? { seq: to, data, reset: true } : { seq: to, data });
      }
    } finally {
      viewer.sending = false;
    }
  }

  #changed(owner: ConversationId): void {
    const watchers = this.#watchers.get(owner);
    if (watchers === undefined) return;
    const list = this.list(owner);
    for (const watcher of watchers) watcher(list);
  }
}

export interface StartTerminalsOptions extends Partial<TerminalsOptions> {
  /** Replaces `import("@lydell/node-pty")`, for tests of the failure path. */
  readonly load?: () => Promise<unknown>;
  readonly diagnostic?: (message: string) => void;
}

/**
 * Load the pty module and start the terminal registry. A host without the
 * module (a platform package npm skipped) keeps running without terminals:
 * `hello.terminals` is left out and this one line says why.
 */
export async function startTerminals(options: StartTerminalsOptions = {}): Promise<Terminals | undefined> {
  let spawn = options.spawn;
  if (spawn === undefined) {
    try {
      const loaded = (options.load === undefined ? await import("@lydell/node-pty") : await options.load()) as { spawn?: unknown };
      if (typeof loaded.spawn !== "function") throw new Error("the module has no spawn()");
      spawn = loaded.spawn as SpawnPty;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      (options.diagnostic ?? console.error)(
        `Terminals unavailable: cannot load @lydell/node-pty on ${process.platform} (${process.arch}); `
          + `missing @lydell/node-pty-${process.platform}-${process.arch}. `
          + `Install without --omit=optional; the host continues without hello.terminals. (${detail})`,
      );
      return undefined;
    }
  }
  return new Terminals({ ...options, spawn, shell: options.shell ?? loginShell(), env: options.env ?? shellEnv(process.env) });
}

/** The user's login shell, as a terminal app would start it. */
function loginShell(): TerminalsOptions["shell"] {
  let file = process.env.SHELL;
  if (file === undefined || file === "") {
    try {
      file = userInfo().shell ?? undefined;
    } catch {
      file = undefined;
    }
  }
  return { file: file === undefined || file === "" ? "/bin/sh" : file, args: ["-l"] };
}

/** The host's environment minus its own PINOMAD_* settings, which are not the user's shell's business. */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("PINOMAD_")) result[key] = value;
  }
  return result;
}

function info(terminal: Terminal): TerminalInfo {
  return {
    id: terminal.id,
    name: terminal.rename ?? terminal.title ?? `Terminal ${terminal.number}`,
    renamed: terminal.rename !== undefined,
    cols: terminal.cols,
    rows: terminal.rows,
    ...(terminal.exit === undefined ? {} : { exit: terminal.exit }),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
