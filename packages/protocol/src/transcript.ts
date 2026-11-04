import type { ConversationView, EntryId, EntryRecord } from "@earendil-works/pi-durable";

/** A conversation subscribe's window (5.28): what the first snapshot holds. */
export interface TranscriptWindow {
  /**
   * The newest entries the first snapshot holds, extended back to the turn
   * the oldest falls in. The host clamps it to MAX_TRANSCRIPT_PAGE.
   */
  readonly limit: number;
  /**
   * Start the first snapshot here instead, inclusive, however many entries
   * follow: a resubscribe keeping everything the client had loaded.
   */
  readonly from?: EntryId;
}

/** Entries oldest first; `before` is the entry just ahead of them, absent at the transcript's start. */
export interface TranscriptPage {
  readonly entries: readonly EntryRecord[];
  readonly before?: EntryId;
}

/** How many entries a client asks for per window or page. */
export const TRANSCRIPT_PAGE = 50;
/** The most entries a host puts in one page or one window start, turn extension included. */
export const MAX_TRANSCRIPT_PAGE = 500;

/**
 * The view a client shows: the pages it loaded with `earlierEntries` ahead of
 * the stream's window. Every derivation reads this, never the bare window.
 */
export function withEarlier(view: ConversationView, earlier: TranscriptPage | undefined): ConversationView {
  if (earlier === undefined) return view;
  const { before: _window, ...rest } = view;
  return {
    ...rest,
    entries: [...earlier.entries, ...view.entries],
    ...(earlier.before === undefined ? {} : { before: earlier.before }),
  };
}

/**
 * `earlier` with `page` ahead of it. A page asked for a `before` that the
 * shown view no longer has (it was requested before a resubscribe replaced
 * the window) would leave a gap or an overlap, so it is dropped.
 */
export function addEarlier(
  shown: ConversationView,
  earlier: TranscriptPage | undefined,
  requested: EntryId,
  page: TranscriptPage,
): TranscriptPage | undefined {
  if (shown.before !== requested) return earlier;
  return {
    entries: [...page.entries, ...(earlier?.entries ?? [])],
    ...(page.before === undefined ? {} : { before: page.before }),
  };
}

export type TranscriptLine =
  | { readonly role: "user"; readonly text: string }
  /** `aborted` marks a partial an interrupted attempt left behind; it stays in the transcript but out of model context. */
  | { readonly role: "assistant"; readonly text: string; readonly stopReason: string };

type ContentBlock = { readonly type: string; readonly text?: string };
type MessageLike = { readonly role: string; readonly content: string | readonly ContentBlock[]; readonly stopReason?: string };

function textOf(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

function lineOf(entry: EntryRecord): TranscriptLine | undefined {
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return undefined;
  const message = entry.model?.[0] as MessageLike | undefined;
  if (message === undefined) return undefined;
  if (entry.kind === "pi.user") return { role: "user", text: textOf(message) };
  return { role: "assistant", text: textOf(message), stopReason: message.stopReason ?? "stop" };
}

/** The user and assistant text of the active transcript, oldest first. */
export function transcript(view: ConversationView): TranscriptLine[] {
  return view.entries.flatMap((entry) => {
    const line = lineOf(entry);
    return line === undefined ? [] : [line];
  });
}

/** Text of the in-flight response, from the committed `pi.live` partial; absent when nothing streams. */
export function streamingText(view: ConversationView): string | undefined {
  const live = view.docs["pi.live"] as { generation?: { message?: MessageLike } } | undefined;
  const message = live?.generation?.message;
  return message === undefined ? undefined : textOf(message);
}

/** Whether the conversation has a run in flight. */
export function isBusy(view: ConversationView): boolean {
  const live = view.docs?.["pi.live"] as { run?: unknown } | undefined;
  return live?.run !== undefined;
}
