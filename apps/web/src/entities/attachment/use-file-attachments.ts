// Composer file-attachment state (issue #321): each picked file uploads
// immediately, a failed one retries from where the host stopped, and a send
// waits for every upload to settle before it takes ids. The slot lives on the
// host runtime, so an upload keeps going while focus moves to another host.
import { useEffect } from "react";
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import {
  useComposerSlotState,
  useLocalComposerSlot,
} from "../composer/composer-context.tsx";
import type { ComposerSlot, FileAttachmentEntry } from "../composer/composer-store.ts";

export type { FileAttachmentEntry } from "../composer/composer-store.ts";

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
  /** The same chips' display names and sizes, for the local bubble. */
  details(): UserAttachment[];
}

export function useFileAttachments(
  remote: RemoteDurable,
  enabled: boolean,
  slot?: ComposerSlot,
): FileAttachments {
  const local = useLocalComposerSlot();
  const active = slot ?? local;
  useEffect(() => {
    active.attachRemote(remote);
  }, [active, remote]);
  const state = useComposerSlotState(active);
  return {
    entries: state.fileEntries,
    get uploading() {
      return state.fileEntries.some((entry) => entry.status === "uploading");
    },
    get failed() {
      return state.fileEntries.some((entry) => entry.status === "failed");
    },
    // A failed chip is too small for its reason, so it goes to the composer's
    // error line, first: it is what keeps Send disabled.
    error: joinErrors(failedUploadError(state.fileEntries), state.fileError),
    add: (files) => active.addFiles(files, enabled),
    retry: (key) => active.retryFile(key),
    remove: (key) => active.removeFile(key),
    restore: (files) => active.restoreFiles(files),
    clear: () => active.clearFiles(),
    ids: () => active.ids(),
    details: () => active.details(),
  };
}

function failedUploadError(entries: readonly FileAttachmentEntry[]): string | null {
  const failed = entries.find((entry) => entry.status === "failed" && entry.error !== undefined);
  return failed === undefined ? null : `${failed.name}: ${failed.error}`;
}

function joinErrors(first: string | null, second: string | null): string | null {
  if (first === null || second === null) return first ?? second;
  return `${/[.!?]$/.test(first) ? first : `${first}.`} ${second}`;
}
