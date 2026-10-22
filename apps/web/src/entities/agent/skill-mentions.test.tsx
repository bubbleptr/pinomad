// The `$` skill-mention surface (issue #143): the scope-keyed cache (one
// request while many callers wait, stale-while-revalidate, failures never
// cached), the trigger's synchronous search over the known list, and the
// highlight plumbing that paints DOM ranges without touching the editable.
import { act, render, renderHook } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SkillListing, SkillScope } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { ChatPromptInput, type ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import {
  SkillMentionText,
  skillItems,
  useSkillHighlight,
  useSkillMentions,
  useSkillNames,
} from "./skill-mentions.tsx";
import { SKILL_HIGHLIGHT_NAME } from "./skill-highlight.ts";
import { SkillMentionCache } from "./skill-list.ts";

const scope: SkillScope = { kind: "conversation", conversationId: 1 as ConversationId };
const chat: SkillScope = { kind: "chat" };

const listing = (skills: Partial<SkillListing["skills"][number]>[]): SkillListing => ({
  skills: skills.map((skill) => ({ name: "skill", description: "", source: "user", ...skill })),
});

/** A remote good enough for the cache — the only call it ever makes is listSkills. */
const remoteWith = (list: (scope: SkillScope) => Promise<SkillListing>): RemoteDurable =>
  ({ controller: { listSkills: (scope: SkillScope) => list(scope) } }) as unknown as RemoteDurable;

describe("SkillMentionCache", () => {
  it("answers once for a scope and notifies subscribers", async () => {
    const cache = new SkillMentionCache(() => Promise.resolve(listing([{ name: "review" }])));
    const notified = vi.fn();
    cache.subscribe(scope, notified);
    cache.request(scope);
    cache.request(scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.snapshot(scope)?.map((s) => s.name)).toEqual(["review"]);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("keeps scopes apart — another scope never serves this one's list", async () => {
    const cache = new SkillMentionCache((scope) => Promise.resolve(listing([{ name: scope.kind }])));
    cache.request(scope);
    cache.request(chat);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.snapshot(scope)?.[0]?.name).toBe("conversation");
    expect(cache.snapshot(chat)?.[0]?.name).toBe("chat");
  });

  it("reuses a fresh answer and refetches a stale one", async () => {
    let now = 1_000;
    let calls = 0;
    const cache = new SkillMentionCache(
      () => (calls += 1, Promise.resolve(listing([{ name: `s${calls}` }]))),
      { now: () => now },
    );
    cache.request(scope);
    await Promise.resolve();
    await Promise.resolve();
    now += SKILL_TTL_MS_FOR_TEST - 1;
    cache.request(scope);
    expect(calls).toBe(1);
    now += 1;
    cache.request(scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    // The new answer replaced the old one in place.
    expect(cache.snapshot(scope)?.[0]?.name).toBe("s2");

    // A reconnect refreshes regardless of the TTL.
    now += 1;
    cache.request(scope, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(3);
  });

  it("never caches a failure — the next request retries", async () => {
    let attempts = 0;
    const cache = new SkillMentionCache(() =>
      ++attempts === 1 ? Promise.reject(new Error("host gone")) : Promise.resolve(listing([{ name: "back" }])),
    );
    const notified = vi.fn();
    cache.subscribe(scope, notified);
    cache.request(scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.snapshot(scope)).toBeUndefined();
    expect(notified).not.toHaveBeenCalled();
    cache.request(scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.snapshot(scope)?.[0]?.name).toBe("back");
    expect(attempts).toBe(2);
  });

  it("merges concurrent requests into one host call", async () => {
    let calls = 0;
    let resolve: (listing: SkillListing) => void;
    const gate = new Promise<SkillListing>((done) => {
      resolve = done;
    });
    const cache = new SkillMentionCache(() => (calls += 1, gate));
    cache.request(scope);
    cache.request(scope);
    expect(calls).toBe(1);
    resolve!(listing([{ name: "review" }]));
    await gate;
    await Promise.resolve();
    expect(cache.snapshot(scope)?.[0]?.name).toBe("review");
  });
});

const SKILL_TTL_MS_FOR_TEST = 5_000;

describe("skillItems", () => {
  const skills = listing([
    { name: "review", description: "Check the diff", source: "project" },
    { name: "deep-review", description: "Slow pass", source: "user" },
    { name: "code-sweep", description: "review the repo", source: "user" },
  ]).skills;

  it("ranks name prefix, then name substring, then description", () => {
    const items = skillItems(skills, "rev");
    expect(items.map((item) => item.id)).toEqual(["skill:review", "skill:deep-review", "skill:code-sweep"]);
  });

  it("is case-insensitive and lists everything on an empty query", () => {
    expect(skillItems(skills, "REV").length).toBe(3);
    expect(skillItems(skills, "").map((item) => item.id)).toEqual(["skill:review", "skill:deep-review", "skill:code-sweep"]);
  });

  it("groups by the entry that supplied the skill", () => {
    const [project, user] = skillItems(skills, "rev");
    expect((project!.auxiliaryData as { group: string }).group).toBe("Project");
    expect((user!.auxiliaryData as { group: string }).group).toBe("User");
  });
});

const search = (trigger: ChatComposerTrigger, query: string): ChatComposerTriggerItem[] =>
  trigger.searchSource.search(query) as ChatComposerTriggerItem[];

const ids = (items: readonly ChatComposerTriggerItem[]): string[] => items.map((item) => item.id);

const noHandle: RefObject<ChatPromptInputHandle | null> = { current: null };

describe("useSkillMentions", () => {
  it("offers no trigger while disabled or scopeless", () => {
    const remote = remoteWith(() => Promise.resolve(listing([{ name: "review" }])));
    const off = renderHook(() => useSkillMentions(remote, scope, noHandle, false));
    expect(off.result.current.trigger).toBeUndefined();
    const noScope = renderHook(() => useSkillMentions(remote, undefined, noHandle, true));
    expect(noScope.result.current.trigger).toBeUndefined();
  });

  it("answers from the landed listing and inserts $name on select", async () => {
    const remote = remoteWith(() => Promise.resolve(listing([{ name: "review" }, { name: "deep-review" }])));
    const { result } = renderHook(() => useSkillMentions(remote, scope, noHandle, true));
    const trigger = () => result.current.trigger!;
    expect(trigger().character).toBe("$");
    expect(trigger().menuLabel).toBe("Skills");
    expect(trigger().emptySearchResultsText).toBe("No matching skills");
    // Before the listing lands the search still answers synchronously — empty.
    expect(ids(search(trigger(), "rev"))).toEqual([]);
    await act(async () => {});
    expect(ids(search(trigger(), "rev"))).toEqual(["skill:review", "skill:deep-review"]);
    expect(trigger().onSelect(search(trigger(), "rev")[0]!)).toBe("$review ");
  });

  it("merges the menu's repeated searches into one in-flight host call", async () => {
    let calls = 0;
    const gate = new Promise<SkillListing>(() => {});
    const remote = remoteWith(() => (calls += 1, gate));
    const { result } = renderHook(() => useSkillMentions(remote, scope, noHandle, true));
    // Mount already requested once; every `$` keystroke re-asks but the
    // in-flight answer absorbs them all.
    search(result.current.trigger!, "r");
    search(result.current.trigger!, "re");
    search(result.current.trigger!, "rev");
    expect(calls).toBe(1);
  });

  it("swaps lists when the scope changes", async () => {
    const remote = remoteWith((scope) =>
      Promise.resolve(listing([{ name: scope.kind === "chat" ? "user-skill" : "conv-skill" }])),
    );
    const { result, rerender } = renderHook(
      ({ s }: { s: SkillScope }) => useSkillMentions(remote, s, noHandle, true),
      { initialProps: { s: scope as SkillScope } },
    );
    await act(async () => {});
    expect(ids(search(result.current.trigger!, ""))).toEqual(["skill:conv-skill"]);
    rerender({ s: chat });
    // The new scope's search never shows the old scope's skills.
    expect(ids(search(result.current.trigger!, ""))).toEqual([]);
    await act(async () => {});
    expect(ids(search(result.current.trigger!, ""))).toEqual(["skill:user-skill"]);
  });

  it("re-emits input through the composer's handle when a listing lands", async () => {
    const emitInput = vi.fn();
    const handle: RefObject<ChatPromptInputHandle | null> = {
      current: { focus: vi.fn(), focusAtEnd: vi.fn(), emitInput, editable: () => null, openTrigger: vi.fn() },
    };
    const remote = remoteWith(() => Promise.resolve(listing([{ name: "review" }])));
    renderHook(() => useSkillMentions(remote, scope, handle, true));
    await act(async () => {});
    expect(emitInput).toHaveBeenCalled();
  });
});

describe("useSkillNames", () => {
  it("hands the scope's names to the bubbles once the listing lands", async () => {
    const remote = remoteWith(() => Promise.resolve(listing([{ name: "review" }, { name: "ship" }])));
    const { result } = renderHook(() => useSkillNames(remote, scope, true));
    await act(async () => {});
    expect(result.current).toEqual(["review", "ship"]);
  });

  it("stays undefined while disabled", async () => {
    const remote = remoteWith(() => Promise.resolve(listing([{ name: "review" }])));
    const { result } = renderHook(() => useSkillNames(remote, scope, false));
    await act(async () => {});
    expect(result.current).toBeUndefined();
  });
});

// The Custom Highlight API is absent from jsdom — stand in a Set-backed
// registry so the range bookkeeping is exercised for real.
function fakeHighlightApi(): Map<string, Highlight> {
  const registry = new Map<string, Highlight>();
  class FakeHighlight extends Set<Range> {
    add(range: Range): this {
      super.add(range);
      return this;
    }
  }
  vi.stubGlobal("Highlight", FakeHighlight);
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: { ...(typeof CSS === "object" ? CSS : {}), highlights: registry },
  });
  return registry;
}

describe("useSkillHighlight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { CSS?: object }).CSS;
  });

  it("registers ranges for the mentions without touching the editable's DOM", async () => {
    const registry = fakeHighlightApi();
    function Composer() {
      const inputRef = useRef<ChatPromptInputHandle | null>(null);
      useSkillHighlight(inputRef, "run $review on it", ["review"]);
      return <ChatPromptInput value="run $review on it" inputRef={inputRef} onValueChange={() => {}} />;
    }
    const { container, unmount } = render(<Composer />);
    const editable = container.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    const before = editable.innerHTML;
    await act(async () => {});
    const highlight = registry.get(SKILL_HIGHLIGHT_NAME);
    expect(highlight).toBeDefined();
    expect(highlight!.size).toBe(1);
    const range = [...highlight!][0]!;
    expect(range.toString()).toBe("$review");
    // The contentEditable was never mutated.
    expect(editable.innerHTML).toBe(before);
    unmount();
    expect(registry.get(SKILL_HIGHLIGHT_NAME)!.size).toBe(0);
  });

  it("is a no-op without names or browser support", async () => {
    const registry = fakeHighlightApi();
    function Composer() {
      const inputRef = useRef<ChatPromptInputHandle | null>(null);
      useSkillHighlight(inputRef, "run $review", undefined);
      return <ChatPromptInput value="run $review" inputRef={inputRef} onValueChange={() => {}} />;
    }
    render(<Composer />);
    await act(async () => {});
    expect(registry.size).toBe(0);
  });
});

describe("SkillMentionText", () => {
  it("wraps mentions in marks and leaves the rest of the text alone", () => {
    const { container } = render(
      <SkillMentionText text="run $review and keep $wrong as text" names={["review"]} />,
    );
    const marks = container.querySelectorAll("mark.chat-skill-mention");
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe("$review");
    expect(container.textContent).toBe("run $review and keep $wrong as text");
  });

  it("renders the text verbatim without names", () => {
    const { container } = render(<SkillMentionText text="run $review" names={undefined} />);
    expect(container.querySelectorAll("mark").length).toBe(0);
    expect(container.textContent).toBe("run $review");
  });
});
