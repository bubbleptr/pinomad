// The mention trigger's merge semantics: agents filter locally and answer on
// the same search call, file candidates arrive keyed by scope+query and
// append on the next search — a failed listing never clears the agents. A
// landed answer also re-dispatches `input`, but only into the composer's own
// editable through its handle.
import { act, render, renderHook } from "@testing-library/react";
import { useEffect, useRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import type { FileListing } from "@pinomad/protocol/organization.ts";
import { ChatPromptInput, type ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { MENTION_LISTING_TTL_MS, useAtMentions, type MentionFiles } from "./agent-mentions.tsx";
import { MENTION_FETCH_DEBOUNCE_MS } from "./mention-fetcher.ts";

const roles = (names: readonly string[]): AgentRoles => ({
  roles: names.map((name) => ({ name, description: `${name} does work`, prompt: "Be helpful." })),
  problems: [],
});

const listing = (files: string[]): FileListing => ({ files, truncated: false });

const search = (trigger: ChatComposerTrigger, query: string): ChatComposerTriggerItem[] =>
  trigger.searchSource.search(query) as ChatComposerTriggerItem[];

const ids = (items: readonly ChatComposerTriggerItem[]): string[] => items.map((item) => item.id);

const noHandle: RefObject<ChatPromptInputHandle | null> = { current: null };

describe("useAtMentions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns no trigger at all when there is nothing to suggest", () => {
    const { result } = renderHook(() => useAtMentions({ roles: [], problems: [] }, noHandle));
    expect(result.current).toBeUndefined();
    const withNull = renderHook(() => useAtMentions(null, noHandle));
    expect(withNull.result.current).toBeUndefined();
  });

  it("answers agents synchronously and appends the listing once it resolves", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing(["src/review.ts"])));
    const files: MentionFiles = { key: "project:/p:worktree", list };
    const { result } = renderHook(() => useAtMentions(roles(["reviewer", "planner"]), noHandle, files));
    const trigger = () => result.current![0]!;

    // Agents answer on the search call itself; the listing is still pending.
    expect(ids(search(trigger(), "rev"))).toEqual(["agent:reviewer"]);
    expect(list).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(list).toHaveBeenCalledWith("rev");
    const items = search(trigger(), "rev");
    expect(ids(items)).toEqual(["agent:reviewer", "file:src/review.ts"]);
    expect(trigger().onSelect(items[0]!)).toBe("@reviewer ");
    expect(trigger().onSelect(items[1]!)).toBe("@./src/review.ts ");
  });

  it("keeps the agent candidates when the listing fails", async () => {
    let attempts = 0;
    const files: MentionFiles = {
      key: "project:/p:worktree",
      list: () => (attempts += 1, Promise.reject(new Error("checkout is unavailable"))),
    };
    const { result } = renderHook(() => useAtMentions(roles(["reviewer"]), noHandle, files));
    const trigger = () => result.current![0]!;
    search(trigger(), "re");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(attempts).toBe(1);
    expect(ids(search(trigger(), "re"))).toEqual(["agent:reviewer"]);
  });

  it("lists only agents without a files source", () => {
    const { result } = renderHook(() => useAtMentions(roles(["reviewer"]), noHandle));
    const trigger = result.current![0]!;
    expect(ids(search(trigger, ""))).toEqual(["agent:reviewer"]);
    expect(trigger.menuLabel).toBe("Named agents");
  });

  it("offers files even when no agents exist, and strips the ./ sigil from the query", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing(["src/a.ts"])));
    const { result } = renderHook(() =>
      useAtMentions({ roles: [], problems: [] }, noHandle, { key: "conversation:3", list }),
    );
    const trigger = () => result.current![0]!;
    expect(ids(search(trigger(), "./sr"))).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(list).toHaveBeenCalledWith("sr");
    expect(ids(search(trigger(), "./sr"))).toEqual(["file:src/a.ts"]);
  });

  it("keeps the previous same-scope candidates while a new query's answer is in flight", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing([`hit-${query}.ts`])));
    const { result } = renderHook(() =>
      useAtMentions(roles(["reviewer"]), noHandle, { key: "conversation:1", list }),
    );
    const trigger = () => result.current![0]!;
    search(trigger(), "h");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(trigger(), "h"))).toEqual(["file:hit-h.ts"]);

    // Narrowing the query must not blank the Files group between keystroke
    // and answer — the previous same-scope listing stays on screen.
    expect(ids(search(trigger(), "hit"))).toEqual(["file:hit-h.ts"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(list).toHaveBeenLastCalledWith("hit");
    expect(ids(search(trigger(), "hit"))).toEqual(["file:hit-hit.ts"]);
  });

  it("refetches a query whose cached answer has aged out", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing([`${query}.ts`])));
    const { result } = renderHook(() =>
      useAtMentions(roles([]), noHandle, { key: "conversation:1", list }),
    );
    const trigger = () => result.current![0]!;
    search(trigger(), "a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(trigger(), "a"))).toEqual(["file:a.ts"]);
    expect(list).toHaveBeenCalledTimes(1);

    // Inside the TTL the cached answer serves the same query, no new call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_LISTING_TTL_MS - 1_000);
    });
    expect(ids(search(trigger(), "a"))).toEqual(["file:a.ts"]);
    expect(list).toHaveBeenCalledTimes(1);

    // Past it, the next search re-asks the host (the stale answer still
    // shows while the refetch is in flight).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(ids(search(trigger(), "a"))).toEqual(["file:a.ts"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refetches under a new scope key instead of serving the old scope's cache", async () => {
    const project = (key: string): MentionFiles => ({
      key,
      list: (query: string) => Promise.resolve(listing([`${key}.ts`])),
    });
    const { result, rerender } = renderHook(
      ({ files }: { files: MentionFiles }) => useAtMentions(roles([]), noHandle, files),
      {
        initialProps: { files: project("project:/a:worktree") },
      },
    );
    search(result.current![0]!, "q");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(result.current![0]!, "q"))).toEqual(["file:project:/a:worktree.ts"]);

    rerender({ files: project("project:/b:worktree") });
    // A scope change hides the old root's paths immediately — nothing is
    // shown until the new scope's own answer lands.
    expect(ids(search(result.current![0]!, "q"))).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(result.current![0]!, "q"))).toEqual(["file:project:/b:worktree.ts"]);
  });

  it("re-emits input through the composer's handle when a listing lands", async () => {
    const emitInput = vi.fn();
    const handle: RefObject<ChatPromptInputHandle | null> = {
      current: { focus: vi.fn(), focusAtEnd: vi.fn(), emitInput },
    };
    const { result } = renderHook(() =>
      useAtMentions(roles([]), handle, {
        key: "conversation:1",
        list: () => Promise.resolve(listing(["a.ts"])),
      }),
    );
    search(result.current![0]!, "q");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(emitInput).toHaveBeenCalledTimes(1);
  });
});

// The emitInput handle's focus gate, against real mounted composers: a
// listing may land while a sibling composer holds the focus.
function MountedComposer({
  files,
  onTriggers,
}: {
  files: MentionFiles;
  onTriggers: (triggers: ChatComposerTrigger[] | undefined) => void;
}) {
  const inputRef = useRef<ChatPromptInputHandle | null>(null);
  const triggers = useAtMentions({ roles: [], problems: [] }, inputRef, files);
  useEffect(() => onTriggers(triggers), [onTriggers, triggers]);
  return <ChatPromptInput value="" inputRef={inputRef} onValueChange={() => {}} triggers={triggers} />;
}

describe("ChatPromptInputHandle.emitInput", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispatches only into its own editable, and only while it is focused", async () => {
    let b: ChatComposerTrigger[] | undefined;
    const { container } = render(
      <>
        <MountedComposer
          files={{ key: "scope:a", list: () => Promise.resolve(listing(["a.ts"])) }}
          onTriggers={() => {}}
        />
        <MountedComposer
          files={{ key: "scope:b", list: () => Promise.resolve(listing(["b.ts"])) }}
          onTriggers={(triggers) => {
            b = triggers;
          }}
        />
      </>,
    );
    const [editableA, editableB] = [...container.querySelectorAll<HTMLElement>('[aria-multiline="true"]')];
    expect(editableA).toBeDefined();
    expect(editableB).toBeDefined();
    const inputsA = vi.fn();
    const inputsB = vi.fn();
    editableA!.addEventListener("input", inputsA);
    editableB!.addEventListener("input", inputsB);

    // B's editable is focused: B's landed listing re-dispatches there only.
    act(() => editableB!.focus());
    expect(document.activeElement).toBe(editableB);
    act(() => {
      b![0]!.searchSource.search("q");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(inputsB).toHaveBeenCalled();
    expect(inputsA).not.toHaveBeenCalled();

    // Focus moves to the sibling composer: B's next answer must not land an
    // event in A's editable — it would re-activate A's menu against B's list.
    inputsA.mockClear();
    inputsB.mockClear();
    act(() => editableA!.focus());
    expect(document.activeElement).toBe(editableA);
    act(() => {
      b![0]!.searchSource.search("r");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(inputsA).not.toHaveBeenCalled();
    expect(inputsB).not.toHaveBeenCalled();
  });
});
