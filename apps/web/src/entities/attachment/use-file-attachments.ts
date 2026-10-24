// Composer file-attachment state (issue #321): each picked file uploads
// immediately, a failed one retries from where the host stopped, and a send
// waits for every upload to settle before it takes ids.
import { useRef, useState } from "react";
import { MAX_ATTACHMENTS_PER_MESSAGE, type UserAttachment } from "@pinomad/protocol/attachments.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import {
  UploadCancelled,
  attachmentRoom,
  fileProblem,
  uploadAttachment,
} from "./file-attachments.ts";

export interface FileAttachmentEntry {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly status: "uploading" | "done" | "failed";
  /** Present once beginAttachment answered (or an edit restored a used id). */
  readonly attachmentId?: string;
  /** Bytes the host confirmed; a retry resumes here. */
  readonly received: number;
  readonly error?: string;
  /** Absent on a restored queued edit: the bytes already live on the host. */
  readonly file?: File;
}

export interface FileAttachments {
  readonly entries: readonly FileAttachmentEntry[];
  readonly uploading: boolean;
  readonly failed: boolean;
  readonly error: string | null;
  add(files: readonly File[]): void;
  retry(key: string): void;
  remove(key: string): void;
  /** Replace the chips with ids an edit or retry brings back. */
  restore(files: readonly UserAttachment[]): void;
  clear(): void;
  /** Ids of every finished chip, in order — what submit sends. */
  ids(): string[];
}

export function useFileAttachments(remote: RemoteDurable, enabled: boolean): FileAttachments {
  const [entries, setEntries] = useState<readonly FileAttachmentEntry[]>([]);
  const entriesRef = useRef<readonly FileAttachmentEntry[]>(entries);
  const nextKey = useRef(1);
  const [error, setError] = useState<string | null>(null);

  const replace = (next: readonly FileAttachmentEntry[]): void => {
    entriesRef.current = next;
    setEntries(next);
  };

  const patch = (key: string, changes: Partial<FileAttachmentEntry>): void => {
    replace(entriesRef.current.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)));
  };

  const start = async (
    key: string,
    file: File,
    attachmentId: string | undefined,
    received: number,
  ): Promise<void> => {
    try {
      await uploadAttachment(remote.controller, file, { ...(attachmentId === undefined ? {} : { attachmentId }), received }, {
        onId: (id) => patch(key, { attachmentId: id }),
        onProgress: (bytes, complete) =>
          patch(key, { received: bytes, ...(complete ? { status: "done" as const } : {}) }),
        isCancelled: () => !entriesRef.current.some((entry) => entry.key === key),
      });
      if (entriesRef.current.some((entry) => entry.key === key)) patch(key, { status: "done" });
    } catch (failure) {
      if (failure instanceof UploadCancelled) return;
      if (!entriesRef.current.some((entry) => entry.key === key)) return;
      const message = failure instanceof Error ? failure.message : String(failure);
      // A cleaned/expired host-side upload cannot be resumed; the next retry
      // starts a fresh one instead of replaying the dead id forever.
      const gone = /expired|not found/i.test(message);
      patch(key, {
        status: "failed",
        error: message,
        ...(gone ? { attachmentId: undefined, received: 0 } : {}),
      });
    }
  };

  const add = (files: readonly File[]): void => {
    if (!enabled) {
      setError("Attaching files needs a host on protocol 5.19; run `pinomad upgrade` on the host");
      return;
    }
    const usable = files.filter((file) => !file.type.startsWith("image/"));
    if (usable.length === 0) return;
    if (usable.length < files.length) setError("Images are attached from Add images…");
    const room = attachmentRoom(entriesRef.current.length);
    if (room === 0) {
      setError(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`);
      return;
    }
    const kept: File[] = [];
    let problem: string | undefined = usable.length > room ? `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message` : undefined;
    for (const file of usable.slice(0, room)) {
      const each = fileProblem(file);
      if (each !== undefined) {
        problem = `${file.name}: ${each}`;
        continue;
      }
      kept.push(file);
    }
    if (problem !== undefined) setError(problem);
    else setError(null);
    if (kept.length === 0) return;
    const added = kept.map((file) => ({
      key: `file-${nextKey.current++}`,
      name: file.name,
      size: file.size,
      status: "uploading" as const,
      received: 0,
      file,
    }));
    replace([...entriesRef.current, ...added]);
    for (const entry of added) void start(entry.key, entry.file!, undefined, 0);
  };

  const retry = (key: string): void => {
    const entry = entriesRef.current.find((candidate) => candidate.key === key);
    if (entry?.file === undefined) return;
    patch(key, { status: "uploading", error: undefined });
    void start(key, entry.file, entry.attachmentId, entry.received);
  };

  const remove = (key: string): void => {
    replace(entriesRef.current.filter((entry) => entry.key !== key));
  };

  const restore = (files: readonly UserAttachment[]): void => {
    // A restore replaces the composer's chips; in-flight starts notice the
    // missing key and stop after their current await.
    replace(
      files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((file) => ({
        key: `file-${nextKey.current++}`,
        name: file.name,
        size: file.size,
        status: "done" as const,
        attachmentId: file.id,
        received: file.size,
      })),
    );
    setError(
      files.length > MAX_ATTACHMENTS_PER_MESSAGE
        ? `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`
        : null,
    );
  };

  const clear = (): void => {
    replace([]);
    setError(null);
  };

  return {
    entries,
    get uploading() {
      return entriesRef.current.some((entry) => entry.status === "uploading");
    },
    get failed() {
      return entriesRef.current.some((entry) => entry.status === "failed");
    },
    error,
    add,
    retry,
    remove,
    restore,
    clear,
    ids: () => entriesRef.current.flatMap((entry) => (entry.status === "done" && entry.attachmentId !== undefined ? [entry.attachmentId] : [])),
  };
}
