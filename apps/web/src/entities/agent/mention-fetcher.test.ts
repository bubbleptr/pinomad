// The mention fetcher's contract: debounce once, dedupe per cache key, and
// never let a late answer clobber the slot a newer query already filled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMentionFetcher, MENTION_FETCH_DEBOUNCE_MS } from "./mention-fetcher.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const listing = (files: string[]) => ({ files, truncated: false });

describe("createMentionFetcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces bursts into one request for the latest key", () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    const list = vi.fn(() => Promise.resolve(listing([])));
    fetcher.request("s:a", "s", list);
    fetcher.request("s:ab", "s", list);
    fetcher.request("s:abc", "s", list);
    expect(list).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MENTION_FETCH_DEBOUNCE_MS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("delivers the answer keyed, after the debounce", async () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    fetcher.request("s:q", "s", () => Promise.resolve(listing(["a.ts", "b.ts"])));
    await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    expect(onItems).toHaveBeenCalledWith("s:q", "s", ["a.ts", "b.ts"]);
  });

  it("does not start a second fetch for a key already in flight", () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    const first = deferred<ReturnType<typeof listing>>();
    const second = vi.fn(() => Promise.resolve(listing([])));
    fetcher.request("s:q", "s", () => first.promise);
    vi.advanceTimersByTime(MENTION_FETCH_DEBOUNCE_MS);
    fetcher.request("s:q", "s", second);
    vi.advanceTimersByTime(MENTION_FETCH_DEBOUNCE_MS);
    expect(second).not.toHaveBeenCalled();
  });

  it("drops an in-flight answer that resolves after cancel", async () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    const slow = deferred<ReturnType<typeof listing>>();
    fetcher.request("s:a", "s", () => slow.promise);
    await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    fetcher.cancel();
    fetcher.request("s:ab", "s", () => Promise.resolve(listing(["new.ts"])));
    await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    slow.resolve(listing(["old.ts"]));
    await Promise.resolve();
    // Only the post-cancel query delivered; "old.ts" arrived too late to matter.
    expect(onItems).toHaveBeenCalledTimes(1);
    expect(onItems).toHaveBeenCalledWith("s:ab", "s", ["new.ts"]);
  });

  it("leaves a failed query unanswered so the next request retries", async () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    const failed = deferred<ReturnType<typeof listing>>();
    fetcher.request("s:q", "s", () => failed.promise);
    await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    failed.reject(new Error("checkout is unavailable"));
    await Promise.resolve();
    expect(onItems).not.toHaveBeenCalled();

    const retry = vi.fn(() => Promise.resolve(listing(["back.ts"])));
    fetcher.request("s:q", "s", retry);
    await vi.advanceTimersByTimeAsync(MENTION_FETCH_DEBOUNCE_MS);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onItems).toHaveBeenCalledWith("s:q", "s", ["back.ts"]);
  });

  it("clears a pending request on cancel before it ever fires", () => {
    const onItems = vi.fn();
    const fetcher = createMentionFetcher(onItems);
    const list = vi.fn(() => Promise.resolve(listing([])));
    fetcher.request("s:q", "s", list);
    fetcher.cancel();
    vi.advanceTimersByTime(MENTION_FETCH_DEBOUNCE_MS * 2);
    expect(list).not.toHaveBeenCalled();
  });
});
