// Host-side storage for file attachments (issue #321, protocol 5.19).
//
// Layout: <dataDir>/attachments/<attachmentId>/meta.json plus the sanitized
// file. The process-wide lock is enough: the data-dir lock guarantees one
// host process per directory. Every state transition, the budget check, submit
// references and the cleanup sweep run through it, so cleanup can never delete
// a file between its `used` mark and the message write.
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  ATTACHMENT_TTL_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENTS,
  type AttachmentFile,
  type AttachmentMeta,
  attachmentBeginProblem,
  attachmentChunkProblem,
  base64DecodedLength,
  isAttachmentId,
} from "@pinomad/protocol/attachments.ts";

const META = "meta.json";
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FILE_NAME_BYTES = 200;

export interface AttachmentStoreOptions {
  /** <dataDir>/attachments — the store root. */
  readonly dir: string;
  /** Test seams: the wall clock, sweep interval and budgets. */
  readonly now?: () => number;
  readonly cleanupIntervalMs?: number;
  readonly pendingLimit?: number;
  readonly pendingBytesLimit?: number;
  readonly ttlMs?: number;
}

/** The parsed meta plus the id directory that holds it. */
interface StoredMeta extends AttachmentMeta {
  readonly id: string;
}

function metaOf(value: unknown, id: string): StoredMeta | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const meta = value as Partial<AttachmentMeta>;
  if (meta.v !== 1) return undefined;
  if (typeof meta.name !== "string" || typeof meta.fileName !== "string") return undefined;
  if (typeof meta.size !== "number" || !Number.isSafeInteger(meta.size) || meta.size < 0) return undefined;
  if (meta.state !== "uploading" && meta.state !== "complete" && meta.state !== "used") return undefined;
  if (typeof meta.createdAt !== "number" || typeof meta.expiresAt !== "number") return undefined;
  // A corrupted fileName must never escape its directory.
  if (meta.fileName === "" || basename(meta.fileName) !== meta.fileName || meta.fileName === "." || meta.fileName === "..") {
    return undefined;
  }
  return { ...meta, id } as StoredMeta;
}

function displayName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= MAX_ATTACHMENT_NAME_LENGTH ? name : chars.slice(0, MAX_ATTACHMENT_NAME_LENGTH).join("");
}

/** How many UTF-8 bytes the first `limit` bytes of `text` can hold without splitting a code point. */
function truncateUtf8(text: string, limit: number): string {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * The disk name: basename, `/\\` and control characters become `_`, edges
 * trimmed, leading dots dropped, 200 UTF-8 bytes at most with the extension
 * kept where it fits. An empty result is `file`.
 */
export function attachmentFileName(name: string): string {
  let clean = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  clean = clean.replace(/^\.+/, "");
  if (clean === "") return "file";
  const dot = clean.lastIndexOf(".");
  const rawExtension = dot > 0 ? clean.slice(dot) : "";
  // A "extension" longer than 32 bytes is not worth preserving.
  const extension = Buffer.byteLength(rawExtension, "utf8") <= 32 ? rawExtension : "";
  const stem = extension === "" ? clean : clean.slice(0, -extension.length);
  const extensionBytes = Buffer.byteLength(extension, "utf8");
  const keptStem = truncateUtf8(stem, Math.max(0, FILE_NAME_BYTES - extensionBytes));
  const trimmedStem = keptStem.replace(/[\s.]+$/u, "");
  const candidate = trimmedStem + (trimmedStem === "" ? "" : extension);
  return candidate === "" ? "file" : candidate;
}

export class AttachmentStore {
  readonly #root: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #pendingLimit: number;
  readonly #pendingBytesLimit: number;
  readonly #cleanupIntervalMs: number;
  /** One promise chain: every meta read/write and directory removal runs here. */
  #lock: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AttachmentStoreOptions) {
    this.#root = resolve(options.dir);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? ATTACHMENT_TTL_MS;
    this.#pendingLimit = options.pendingLimit ?? MAX_PENDING_ATTACHMENTS;
    this.#pendingBytesLimit = options.pendingBytesLimit ?? MAX_PENDING_ATTACHMENT_BYTES;
    this.#cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
  }

  get root(): string {
    return this.#root;
  }

  /** Create the root, sweep once, then sweep every six hours until close(). */
  async open(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await this.sweep();
    this.#timer = setInterval(() => void this.sweep().catch(() => {}), this.#cleanupIntervalMs);
    this.#timer.unref();
  }

  close(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(work, work);
    this.#lock = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  #directory(id: string): string {
    return join(this.#root, id);
  }

  #dataPath(meta: StoredMeta): string {
    return join(this.#directory(meta.id), meta.fileName);
  }

  async #readMeta(id: string): Promise<StoredMeta | undefined> {
    if (!isAttachmentId(id)) return undefined;
    try {
      return metaOf(JSON.parse(await readFile(join(this.#directory(id), META), "utf8")), id);
    } catch {
      return undefined;
    }
  }

  async #writeMeta(meta: StoredMeta): Promise<void> {
    const { id, ...value } = meta;
    const directory = this.#directory(id);
    const temporary = join(directory, `.meta.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, join(directory, META));
  }

  /** Counted and summed under the lock: only uploads still awaiting a message. */
  async #pending(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = await this.#readMeta(entry.name);
      if (meta === undefined || meta.state === "used") continue;
      count += 1;
      bytes += meta.size;
    }
    return { count, bytes };
  }

  /** Start an upload; resolves with the host-generated id. */
  begin(name: string, size: number): Promise<string> {
    return this.#run(async () => {
      const problem = attachmentBeginProblem(name, size);
      if (problem !== undefined) throw new Error(problem);
      const pending = await this.#pending();
      if (pending.count + 1 > this.#pendingLimit) {
        throw new Error(`Too many pending attachments (${this.#pendingLimit} at most); try again after unused uploads expire`);
      }
      if (pending.bytes + size > this.#pendingBytesLimit) {
        throw new Error(`Pending attachments exceed the ${this.#pendingBytesLimit / (1024 * 1024)} MB budget; try again after unused uploads expire`);
      }
      const id = randomBytes(16).toString("base64url");
      const directory = this.#directory(id);
      const meta: StoredMeta = {
        id,
        v: 1,
        name: displayName(name),
        fileName: attachmentFileName(name),
        size,
        state: size === 0 ? "complete" : "uploading",
        createdAt: this.#now(),
        expiresAt: this.#now() + this.#ttlMs,
      };
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(this.#dataPath(meta), new Uint8Array(0), { mode: 0o600 });
        if (size === 0) await chmod(this.#dataPath(meta), 0o444);
        await this.#writeMeta(meta);
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return id;
    });
  }

  /**
   * Append one chunk. A duplicate/retried offset gets the current length back
   * instead of a write; a complete attachment answers its final size and
   * `complete: true` regardless of `offset`, so a lost reply is safe to retry.
   */
  append(id: string, offset: number, data: string): Promise<{ received: number; complete: boolean }> {
    return this.#run(async () => {
      const meta = await this.#readMeta(id);
      if (meta === undefined) throw new Error("Attachment not found or expired; attach it again");
      if (meta.state === "complete" || meta.state === "used") {
        return { received: meta.size, complete: true };
      }
      const problem = attachmentChunkProblem(data);
      if (problem !== undefined) throw new Error(problem);
      const decoded = base64DecodedLength(data)!;
      const path = this.#dataPath(meta);
      const received = (await stat(path)).size;
      // A crash between the last write and the meta flip leaves a full file
      // still marked uploading. Recover it here instead of appending forever.
      if (received === meta.size) {
        await chmod(path, 0o444);
        await this.#writeMeta({ ...meta, state: "complete" });
        return { received, complete: true };
      }
      if (offset !== received) return { received, complete: false };
      if (received + decoded > meta.size) throw new Error("Attachment chunk is larger than the remaining size");
      const bytes = Buffer.from(data, "base64");
      const handle = await open(path, "r+");
      try {
        const { bytesWritten } = await handle.write(bytes, 0, bytes.length, received);
        if (bytesWritten !== bytes.length) throw new Error("Could not write the whole attachment chunk");
      } finally {
        await handle.close();
      }
      const after = received + bytes.length;
      if (after === meta.size) {
        await chmod(path, 0o444);
        await this.#writeMeta({ ...meta, state: "complete" });
      }
      return { received: after, complete: after === meta.size };
    });
  }

  /**
   * Validate a message's attachment ids under the lock and mark them `used`
   * before the caller writes the message. `used` is permanent: a failed send,
   * a withdrawn queue item or an edit never frees the file.
   */
  use(ids: readonly string[] | undefined): Promise<AttachmentFile[] | undefined> {
    return this.#run(async () => {
      if (ids === undefined || ids.length === 0) return undefined;
      if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
      }
      const checked: { meta: StoredMeta; path: string }[] = [];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index]!;
        const meta = await this.#readMeta(id);
        if (meta === undefined) throw new Error(`Attachment ${index + 1} has expired; attach it again`);
        if (meta.state === "uploading") throw new Error(`Attachment ${index + 1} is still uploading`);
        const path = this.#dataPath(meta);
        let info;
        try {
          info = await lstat(path);
        } catch {
          throw new Error(`Attachment ${index + 1} is unavailable; attach it again`);
        }
        // lstat: a symlink is never an attachment, even if it points at a regular file.
        if (!info.isFile() || info.size !== meta.size) {
          throw new Error(`Attachment ${index + 1} is unavailable; attach it again`);
        }
        checked.push({ meta, path });
      }
      for (const { meta } of checked) {
        if (meta.state === "used") continue;
        await this.#writeMeta({ ...meta, state: "used" });
      }
      return checked.map(({ meta, path }) => ({ id: meta.id, name: meta.name, path, size: meta.size }));
    });
  }

  /**
   * Delete expired unused uploads and old broken directories. The sweep runs
   * under the same lock as `use`, and re-reads each meta there, so a file
   * marked `used` by a concurrent submit survives.
   */
  sweep(): Promise<number> {
    return this.#run(async () => {
      let removed = 0;
      let entries;
      try {
        entries = await readdir(this.#root, { withFileTypes: true });
      } catch {
        return 0;
      }
      const now = this.#now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = this.#directory(entry.name);
        const meta = await this.#readMeta(entry.name);
        if (meta !== undefined) {
          if (meta.state === "used") continue;
          if (meta.expiresAt > now) continue;
        } else {
          // No trustworthy meta means no trustworthy expiry; the directory's
          // creation time is the only timestamp left. Valid metas always use
          // their own expiresAt (never the directory's mtime).
          try {
            if (now - (await stat(directory)).mtimeMs <= this.#ttlMs) continue;
          } catch {
            continue;
          }
        }
        try {
          await rm(directory, { recursive: true, force: true });
          removed += 1;
        } catch {
          // A transient permission/ENOENT problem is retried next sweep.
        }
      }
      return removed;
    });
  }
}
