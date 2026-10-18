// The mention trigger's merge semantics: agents filter locally and answer on
// the same search call, file candidates arrive keyed by scope+query and
// append on the next search — a failed listing never clears the agents.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import type { FileListing } from "@pinomad/protocol/organization.ts";
import { useAtMentions, type MentionFiles } from "./agent-mentions.tsx";
import { MENTION_FETCH_DEBOUNCE_MS } from "./mention-fetcher.ts";

const roles = (names: readonly string[]): AgentRoles => ({
  roles: names.map((name) => ({ name, description: `${name} does work`, prompt: "Be helpful." })),
  problems: [],
});

const listing = (files: string[]): FileListing => ({ files, truncated: false });

const search = (trigger: ChatComposerTrigger, query: string): ChatComposerTriggerItem[] =>
  trigger.searchSource.search(query) as ChatComposerTriggerItem[];

const ids = (items: readonly ChatComposerTriggerItem[]): string[] => items.map((item) => item.id);

describe("useAtMentions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns no trigger at all when there is nothing to suggest", () => {
    const { result } = renderHook(() => useAtMentions({ roles: [], problems: [] }));
    expect(result.current).toBeUndefined();
    const withNull = renderHook(() => useAtMentions(null));
    expect(withNull.result.current).toBeUndefined();
  });

  it("answers agents synchronously and appends the listing once it resolves", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing(["src/review.ts"])));
    const files: MentionFiles = { key: "project:/p:worktree", list };
    const { result } = renderHook(() => useAtMentions(roles(["reviewer", "planner"]), files));
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
    const { result } = renderHook(() => useAtMentions(roles(["reviewer"]), files));
    const trigger = () => result.current![0]!;
    search(trigger(), "re");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(attempts).toBe(1);
    expect(ids(search(trigger(), "re"))).toEqual(["agent:reviewer"]);
  });

  it("lists only agents without a files source", () => {
    const { result } = renderHook(() => useAtMentions(roles(["reviewer"])));
    const trigger = result.current![0]!;
    expect(ids(search(trigger, ""))).toEqual(["agent:reviewer"]);
    expect(trigger.menuLabel).toBe("Named agents");
  });

  it("offers files even when no agents exist, and strips the ./ sigil from the query", async () => {
    const list = vi.fn((query: string) => Promise.resolve(listing(["src/a.ts"])));
    const { result } = renderHook(() =>
      useAtMentions({ roles: [], problems: [] }, { key: "conversation:3", list }),
    );
    const trigger = () => result.current![0]!;
    expect(ids(search(trigger(), "./sr"))).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(list).toHaveBeenCalledWith("sr");
    expect(ids(search(trigger(), "./sr"))).toEqual(["file:src/a.ts"]);
  });

  it("refetches under a new scope key instead of serving the old scope's cache", async () => {
    const project = (key: string): MentionFiles => ({
      key,
      list: (query: string) => Promise.resolve(listing([`${key}.ts`])),
    });
    const { result, rerender } = renderHook(({ files }: { files: MentionFiles }) => useAtMentions(roles([]), files), {
      initialProps: { files: project("project:/a:worktree") },
    });
    search(result.current![0]!, "q");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(result.current![0]!, "q"))).toEqual(["file:project:/a:worktree.ts"]);

    rerender({ files: project("project:/b:worktree") });
    // The same query under a new scope answers with the new scope's listing.
    expect(ids(search(result.current![0]!, "q"))).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    });
    expect(ids(search(result.current![0]!, "q"))).toEqual(["file:project:/b:worktree.ts"]);
  });
});
