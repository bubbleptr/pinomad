// The `/` menu's trigger (issue #254, ADR-0027): present only while the draft
// is a leading `/` plus its first token, prefix-filtered over the host's list,
// and a disabled command can't be picked.
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { describe, expect, it } from "vitest";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CommandListing } from "@pinomad/protocol/commands.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { useSlashCommands } from "./slash-commands.tsx";

const id = 1 as ConversationId;
const noHandle: RefObject<ChatPromptInputHandle | null> = { current: null };
const remoteWith = (listing: CommandListing): RemoteDurable =>
  ({ controller: { listCommands: () => Promise.resolve(listing) } }) as unknown as RemoteDurable;
const LISTING: CommandListing = {
  commands: [
    { name: "compact", description: "Summarize older context", argumentHint: "[instructions]", source: "builtin" },
    { name: "clear", description: "Start over", source: "builtin", disabled: "Not while a run is going" },
  ],
};

const search = (trigger: ChatComposerTrigger, query: string): ChatComposerTriggerItem[] =>
  trigger.searchSource!.search(query) as ChatComposerTriggerItem[];

describe("useSlashCommands", () => {
  it("offers the trigger only while the draft is a leading / and its first token", async () => {
    const remote = remoteWith(LISTING);
    const { result, rerender } = renderHook(({ value }) => useSlashCommands(remote, id, noHandle, true, value), {
      initialProps: { value: "" },
    });
    await act(async () => {});
    expect(result.current.trigger).toBeUndefined();
    rerender({ value: "/" });
    expect(result.current.trigger?.character).toBe("/");
    rerender({ value: "/com" });
    expect(result.current.trigger).toBeDefined();
    for (const value of ["see /etc/hosts", " /compact", "/compact now", "/compact\n"]) {
      rerender({ value });
      expect(result.current.trigger).toBeUndefined();
    }
  });

  it("filters by name prefix and inserts /name, but never picks a disabled command", async () => {
    const remote = remoteWith(LISTING);
    const { result } = renderHook(() => useSlashCommands(remote, id, noHandle, true, "/c"));
    await act(async () => {});
    const trigger = result.current.trigger!;
    expect(search(trigger, "co").map((item) => item.label)).toEqual(["compact"]);
    const [compact, clear] = search(trigger, "c");
    expect(trigger.onSelect(compact!)).toBe("/compact ");
    // Picking the greyed command puts back what was typed instead.
    expect(trigger.onSelect(clear!)).toBe("/c");
  });

  it("has no list or trigger while disabled — a pre-5.15 host or no connection", async () => {
    const remote = remoteWith(LISTING);
    const { result } = renderHook(() => useSlashCommands(remote, id, noHandle, false, "/"));
    await act(async () => {});
    expect(result.current.trigger).toBeUndefined();
    expect(result.current.commands).toBeUndefined();
  });
});
