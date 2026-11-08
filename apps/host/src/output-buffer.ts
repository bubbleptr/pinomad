// Bounded output with positions, shared by interactive terminals (ADR-0041) and
// background processes (ADR-0045). The buffer holds raw pty output; positions
// (`seq`) count UTF-16 code units and never reset. Every viewer reads from its
// own position and is sent the next piece only after the last reached its
// transport, so a slow viewer never pauses the producer or other viewers: once
// its position falls out of the buffer it gets the whole buffer with `reset`.
export interface OutputFrame {
  readonly seq: number;
  readonly data: string;
  readonly reset?: true;
}

export interface OutputSink {
  /** Resolves once the frame is handed to the transport; the next one waits for it. */
  output(frame: OutputFrame): Promise<void>;
  ended(reason: string): void;
}

export interface OutputBufferOptions {
  /** How much output is kept for replay, in UTF-16 code units. */
  readonly bufferSize?: number;
  /** How long output is gathered before it is sent. */
  readonly flushMs?: number;
  /** The largest piece of output one frame carries. */
  readonly maxChunk?: number;
  /** Called after `data` was appended to the buffer, before viewers pump. */
  readonly onFlush?: (data: string) => void;
}

const BUFFER_SIZE = 512 * 1024;
const FLUSH_MS = 8;
// Raw output can grow 6× as JSON (\u001b), so a 16 KiB piece stays under
// ~100 KiB on the wire: a conversation frame never waits behind much.
const MAX_CHUNK = 16 * 1024;

interface Viewer {
  readonly sink: OutputSink;
  /** The next position to send; `undefined` → send the whole buffer with `reset`. */
  position: number | undefined;
  sending: boolean;
}

/** One slice of the retained output, at raw positions. */
export interface OutputSlice {
  readonly text: string;
  /** The raw position after `text`; the next `since` for a follow-up read. */
  readonly next: number;
  /** `since` was older than the retained window, so the beginning is missing. */
  readonly truncated: boolean;
}

export class OutputBuffer {
  readonly #bufferSize: number;
  readonly #flushMs: number;
  readonly #maxChunk: number;
  readonly #onFlush: ((data: string) => void) | undefined;
  readonly #viewers = new Set<Viewer>();
  #buffer = "";
  #start = 0;
  #pending = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ended = false;

  constructor(options: OutputBufferOptions = {}) {
    this.#bufferSize = options.bufferSize ?? BUFFER_SIZE;
    this.#flushMs = options.flushMs ?? FLUSH_MS;
    this.#maxChunk = options.maxChunk ?? MAX_CHUNK;
    this.#onFlush = options.onFlush;
  }

  /** The retained output's first position. */
  get start(): number {
    return this.#start;
  }

  /** The position after all retained output. */
  get end(): number {
    return this.#start + this.#buffer.length;
  }

  /** How much output is retained now, in UTF-16 code units. */
  get length(): number {
    return this.#buffer.length;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Append pty output; it is sent once it reaches the chunk size or after `flushMs`. */
  push(data: string): void {
    if (this.#ended || data === "") return;
    this.#pending += data;
    if (this.#pending.length >= this.#maxChunk) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), this.#flushMs);
  }

  /** Append whatever is pending now. */
  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const data = this.#pending;
    if (data === "") return;
    this.#pending = "";
    this.#buffer += data;
    this.#trim();
    this.#onFlush?.(data);
    for (const viewer of this.#viewers) void this.#pump(viewer);
  }

  /**
   * Drop the retained output and leave a one-position gap: a viewer that read
   * the old output and comes back later holds a position the new buffer no
   * longer has, so it gets a reset instead of silently missing the start.
   */
  discard(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const gap = this.#buffer.length + this.#pending.length + 1;
    this.#buffer = "";
    this.#pending = "";
    this.#start += gap;
    for (const viewer of this.#viewers) viewer.position = undefined;
  }

  /** Stop accepting output and end every viewer; retained output stays readable. */
  close(reason: string): void {
    if (this.#ended) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#ended = true;
    for (const viewer of this.#viewers) viewer.sink.ended(reason);
    this.#viewers.clear();
  }

  /** Attach a viewer at `since`, or at the retained start; returns the detach. */
  attach(since: number | undefined, sink: OutputSink): () => void {
    const position = since !== undefined && since >= this.#start && since <= this.end ? since : undefined;
    const viewer: Viewer = { sink, position, sending: false };
    this.#viewers.add(viewer);
    void this.#pump(viewer);
    return () => {
      this.#viewers.delete(viewer);
    };
  }

  /** The retained output after `since`, at most `maxChunk` units; never mutates the viewer positions. */
  snapshot(since?: number, maxChunk = this.#maxChunk): OutputSlice {
    const end = this.end;
    const from = since === undefined ? this.#start : Math.min(Math.max(since, this.#start), end);
    let to = Math.min(end, from + maxChunk);
    // Never end a piece between the halves of a surrogate pair.
    if (to < end && isHighSurrogate(this.#buffer.charCodeAt(to - this.#start - 1))) to--;
    const text = this.#buffer.slice(from - this.#start, to - this.#start);
    return {
      text,
      next: to,
      truncated: since === undefined ? this.#start > 0 : since < this.#start,
    };
  }

  #trim(): void {
    if (this.#buffer.length <= this.#bufferSize) return;
    // Drop the oldest output, starting the kept part at a line where one is
    // near so a replay doesn't open mid-line.
    let cut = this.#buffer.length - this.#bufferSize;
    const line = this.#buffer.indexOf("\n", cut);
    if (line !== -1 && line - cut < 1024) cut = line + 1;
    this.#buffer = this.#buffer.slice(cut);
    this.#start += cut;
  }

  async #pump(viewer: Viewer): Promise<void> {
    if (viewer.sending) return;
    viewer.sending = true;
    try {
      while (this.#viewers.has(viewer)) {
        const end = this.end;
        const reset = viewer.position === undefined || viewer.position < this.#start;
        const from = reset ? this.#start : viewer.position!;
        // Nothing to replay yet: keep the viewer at "reset" so its first
        // frame carries the output that arrives next.
        if (reset && end === this.#start) return;
        // A reset replays the whole buffer at once: the client clears first,
        // so it must not see a partial screen in between.
        if (!reset && from >= end) return;
        let to = reset ? end : Math.min(end, from + this.#maxChunk);
        // Never end a piece between the halves of a surrogate pair.
        if (to < end && isHighSurrogate(this.#buffer.charCodeAt(to - this.#start - 1))) to--;
        const data = this.#buffer.slice(from - this.#start, to - this.#start);
        viewer.position = to;
        await viewer.sink.output(reset ? { seq: to, data, reset: true } : { seq: to, data });
      }
    } finally {
      viewer.sending = false;
    }
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
