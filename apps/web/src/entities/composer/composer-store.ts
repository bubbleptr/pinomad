// One in-memory composer slot per host and draft target. It outlives the
// Workbench on focus changes, so text, picks, attachments and in-flight file
// uploads keep running on that host's connection (ADR-0035 §3/§7).
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { Home } from "@pinomad/protocol/organization.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, type UserAttachment } from "@pinomad/protocol/attachments.ts";
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from "@pinomad/protocol/images.ts";
import type { AgentDraftOverrides } from "@pinomad/client/model.ts";
import { emptyDraft, restoreDraft, type SkillDraft } from "../agent/skill-bindings.ts";
import {
  UploadCancelled,
  attachmentRoom,
  fileProblem,
  uploadAttachment,
} from "../attachment/file-attachments.ts";
import { primeImages } from "../image/image-cache.ts";
import { prepareImage } from "../image/prepare-image.ts";

export type CheckoutMode = "worktree" | "local";

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

export interface ComposerSlotState {
  readonly draft: SkillDraft;
  readonly images: readonly MessageImage[];
  readonly preparing: number;
  readonly imageError: string | null;
  readonly fileEntries: readonly FileAttachmentEntry[];
  readonly fileError: string | null;
  /** The new-draft target; ignored by conversation slots. */
  readonly home: Home;
  readonly checkoutMode: CheckoutMode;
  readonly agent: string | undefined;
  readonly overrides: AgentDraftOverrides;
  /** A createConversation call is in flight; it lives on the slot so a focus
      switch and remount cannot submit the same draft twice. */
  readonly submitting: boolean;
}

const initialState = (): ComposerSlotState => ({
  draft: emptyDraft,
  images: [],
  preparing: 0,
  imageError: null,
  fileEntries: [],
  fileError: null,
  home: { kind: "chat" },
  checkoutMode: "worktree",
  agent: undefined,
  overrides: {},
  submitting: false,
});

export class ComposerSlot {
  readonly #store: HostComposerStore;
  readonly #listeners = new Set<() => void>();
  #state: ComposerSlotState = initialState();
  #imageGeneration = 0;
  #imagesTaken = 0;
  #nextFileKey = 1;

  constructor(store: HostComposerStore) {
    this.#store = store;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): ComposerSlotState => this.#state;

  attachRemote(remote: RemoteDurable | undefined): void {
    this.#store.setRemote(remote);
  }

  #set(patch: Partial<ComposerSlotState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  setDraft(draft: SkillDraft): void {
    this.#set({ draft });
  }

  restoreDraft(text: string, skills: readonly string[]): void {
    this.setDraft(restoreDraft(text, skills));
  }

  setHome(home: Home): void {
    this.#set({ home });
  }

  setCheckoutMode(checkoutMode: CheckoutMode): void {
    this.#set({ checkoutMode });
  }

  setAgent(agent: string | undefined): void {
    this.#set({ agent, overrides: {} });
  }

  setOverrides(overrides: AgentDraftOverrides): void {
    this.#set({ overrides });
  }

  /** Reserve the create call synchronously; false means one is already in flight. */
  beginSubmit(): boolean {
    if (this.#state.submitting) return false;
    this.#set({ submitting: true });
    return true;
  }

  endSubmit(): void {
    if (this.#state.submitting) this.#set({ submitting: false });
  }

  addImages(files: File[], accepts: boolean): void {
    if (!accepts) {
      this.#set({ imageError: "This model doesn't accept images" });
      return;
    }
    const usable = files.filter((file) => file.type.startsWith("image/"));
    const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - this.#imagesTaken);
    const kept = usable.slice(0, room);
    if (usable.length > room) this.#set({ imageError: "At most 4 images per message" });
    else if (usable.length < files.length) this.#set({ imageError: "Only images can be attached" });
    else this.#set({ imageError: null });
    if (kept.length === 0) return;
    this.#imagesTaken += kept.length;
    const generation = this.#imageGeneration;
    this.#set({ preparing: this.#state.preparing + kept.length });
    void Promise.all(kept.map((file) => prepareImage(file))).then(
      async (prepared) => {
        if (this.#imageGeneration !== generation) return;
        await primeImages(prepared);
        if (this.#imageGeneration !== generation) return;
        this.#set({ images: [...this.#state.images, ...prepared], preparing: this.#state.preparing - kept.length });
      },
      (failure: unknown) => {
        if (this.#imageGeneration !== generation) return;
        this.#imagesTaken -= kept.length;
        this.#set({
          imageError: failure instanceof Error ? failure.message : String(failure),
          preparing: this.#state.preparing - kept.length,
        });
      },
    );
  }

  restoreImages(images: readonly MessageImage[]): void {
    const kept = images.slice(0, MAX_IMAGES_PER_MESSAGE);
    this.#imageGeneration += 1;
    this.#imagesTaken = kept.length;
    this.#set({
      images: [...kept],
      preparing: 0,
      imageError: images.length > MAX_IMAGES_PER_MESSAGE ? "At most 4 images per message" : null,
    });
  }

  removeImage(index: number): void {
    this.#imagesTaken -= 1;
    this.#set({ images: this.#state.images.filter((_, at) => at !== index) });
  }

  clearImages(): void {
    this.#imageGeneration += 1;
    this.#imagesTaken = 0;
    this.#set({ images: [], preparing: 0, imageError: null });
  }

  #patchFile(key: string, changes: Partial<FileAttachmentEntry>): void {
    this.#set({
      fileEntries: this.#state.fileEntries.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)),
    });
  }

  async #startFile(
    key: string,
    file: File,
    attachmentId: string | undefined,
    received: number,
  ): Promise<void> {
    const remote = this.#store.remote;
    if (remote === undefined) {
      this.#patchFile(key, { status: "failed", error: "Host is not connected" });
      return;
    }
    try {
      await uploadAttachment(
        remote.controller,
        file,
        { ...(attachmentId === undefined ? {} : { attachmentId }), received },
        {
          onId: (id) => this.#patchFile(key, { attachmentId: id }),
          onProgress: (bytes, complete) =>
            this.#patchFile(key, { received: bytes, ...(complete ? { status: "done" as const } : {}) }),
          isCancelled: () => !this.#state.fileEntries.some((entry) => entry.key === key),
        },
      );
      if (this.#state.fileEntries.some((entry) => entry.key === key)) this.#patchFile(key, { status: "done" });
    } catch (failure) {
      if (failure instanceof UploadCancelled) return;
      if (!this.#state.fileEntries.some((entry) => entry.key === key)) return;
      const message = failure instanceof Error ? failure.message : String(failure);
      const gone = /expired|not found/i.test(message);
      this.#patchFile(key, {
        status: "failed",
        error: message,
        ...(gone ? { attachmentId: undefined, received: 0 } : {}),
      });
    }
  }

  addFiles(files: readonly File[], enabled: boolean): void {
    if (!enabled) {
      this.#set({ fileError: "Attaching files needs a host on protocol 5.19; run `pinomad upgrade` on the host" });
      return;
    }
    const usable = files.filter((file) => !file.type.startsWith("image/"));
    if (usable.length === 0) return;
    if (usable.length < files.length) this.#set({ fileError: "Images are attached from Add images…" });
    const room = attachmentRoom(this.#state.fileEntries.length);
    if (room === 0) {
      this.#set({ fileError: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message` });
      return;
    }
    const kept: File[] = [];
    let problem: string | undefined =
      usable.length > room ? `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message` : undefined;
    for (const file of usable.slice(0, room)) {
      const each = fileProblem(file);
      if (each !== undefined) {
        problem = `${file.name}: ${each}`;
        continue;
      }
      kept.push(file);
    }
    this.#set({ fileError: problem ?? null });
    if (kept.length === 0) return;
    const added = kept.map((file) => ({
      key: `file-${this.#nextFileKey++}`,
      name: file.name,
      size: file.size,
      status: "uploading" as const,
      received: 0,
      file,
    }));
    this.#set({ fileEntries: [...this.#state.fileEntries, ...added] });
    for (const entry of added) void this.#startFile(entry.key, entry.file, undefined, 0);
  }

  retryFile(key: string): void {
    const entry = this.#state.fileEntries.find((candidate) => candidate.key === key);
    if (entry?.file === undefined) return;
    this.#patchFile(key, { status: "uploading", error: undefined });
    void this.#startFile(key, entry.file, entry.attachmentId, entry.received);
  }

  removeFile(key: string): void {
    this.#set({ fileEntries: this.#state.fileEntries.filter((entry) => entry.key !== key) });
  }

  restoreFiles(files: readonly UserAttachment[]): void {
    this.#set({
      fileEntries: files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((file) => ({
        key: `file-${this.#nextFileKey++}`,
        name: file.name,
        size: file.size,
        status: "done" as const,
        attachmentId: file.id,
        received: file.size,
      })),
      fileError:
        files.length > MAX_ATTACHMENTS_PER_MESSAGE
          ? `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`
          : null,
    });
  }

  clearFiles(): void {
    this.#set({ fileEntries: [], fileError: null });
  }

  get uploading(): boolean {
    return this.#state.fileEntries.some((entry) => entry.status === "uploading");
  }

  get failed(): boolean {
    return this.#state.fileEntries.some((entry) => entry.status === "failed");
  }

  ids(): string[] {
    return this.#state.fileEntries.flatMap((entry) =>
      entry.status === "done" && entry.attachmentId !== undefined ? [entry.attachmentId] : [],
    );
  }

  details(): UserAttachment[] {
    return this.#state.fileEntries.flatMap((entry) =>
      entry.status === "done" && entry.attachmentId !== undefined
        ? [{ id: entry.attachmentId, name: entry.name, size: entry.size }]
        : [],
    );
  }
}

export class HostComposerStore {
  readonly #slots = new Map<string, ComposerSlot>();
  #remote: RemoteDurable | undefined;

  setRemote(remote: RemoteDurable | undefined): void {
    this.#remote = remote;
  }

  get remote(): RemoteDurable | undefined {
    return this.#remote;
  }

  slot(key: string): ComposerSlot {
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = new ComposerSlot(this);
      this.#slots.set(key, slot);
    }
    return slot;
  }
}

export const newDraftKey = "new";
export const conversationDraftKey = (id: ConversationId): string => `conversation:${id}`;
