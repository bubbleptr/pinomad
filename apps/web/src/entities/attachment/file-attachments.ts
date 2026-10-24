// File upload helpers (issue #321): chunking, base64, and the retry/resume
// loop. The host serializes appends per attachment; the client sends one chunk
// at a time and trusts the host's `received`, so a lost reply is recovered by
// resending from where the host actually is.
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentBeginProblem,
} from "@pinomad/protocol/attachments.ts";
import type { DurableController } from "@pinomad/protocol/view.ts";

/** Pasted/dropped/picked files split by the existing image path (ADR-0027). */
export function splitFiles(files: readonly File[]): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) images.push(file);
    else others.push(file);
  }
  return { images, others };
}

/** "5 B", "1.2 KB", "3.4 MB" — the same compact style as the docs. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Browser base64 without spreading a whole chunk into one call. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** How many files a selection may add; the host enforces the same cap. */
export function attachmentRoom(current: number): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - current);
}

/** The begin-time pre-check shared by a picked batch. */
export function fileProblem(file: File): string | undefined {
  return attachmentBeginProblem(file.name, file.size);
}

export interface UploadProgress {
  /** Set once the host named the upload, so a retry can resume it. */
  onId(attachmentId: string): void;
  onProgress(received: number, complete: boolean): void;
  /** Removing the chip stops the loop after the current await. */
  isCancelled(): boolean;
}

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelled";
  }
}

/**
 * Upload one file from `target.received`, creating the host id first when a
 * previous attempt never got one. A retry passes the last known id and
 * offset; the host answers the offset it really has, so duplicate or lost
 * chunks converge instead of corrupting the file.
 */
export async function uploadAttachment(
  controller: Pick<DurableController, "beginAttachment" | "appendAttachment">,
  file: File,
  target: { attachmentId?: string; received: number },
  progress: UploadProgress,
): Promise<{ attachmentId: string; received: number }> {
  let attachmentId = target.attachmentId;
  let received = target.received;
  if (attachmentId === undefined) {
    attachmentId = await controller.beginAttachment(file.name, file.size);
    progress.onId(attachmentId);
  }
  if (file.size === 0) {
    progress.onProgress(0, true);
    return { attachmentId, received: 0 };
  }
  while (received < file.size) {
    if (progress.isCancelled()) throw new UploadCancelled();
    const end = Math.min(received + ATTACHMENT_CHUNK_BYTES, file.size);
    const data = bytesToBase64(new Uint8Array(await file.slice(received, end).arrayBuffer()));
    const result = await controller.appendAttachment(attachmentId, received, data);
    if (result.complete) {
      progress.onProgress(file.size, true);
      return { attachmentId, received: file.size };
    }
    if (result.received <= received) throw new Error("Upload made no progress");
    received = result.received;
    progress.onProgress(received, false);
  }
  progress.onProgress(file.size, true);
  return { attachmentId, received: file.size };
}
