import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { useConversationFocus } from "./use-conversation-focus.ts";

const id = (value: number): ConversationId => value as ConversationId;

const view = (patch: {
  connection?: DurableView["connection"];
  conversation?: number;
  side?: number;
} = {}): DurableView =>
  ({
    connection: patch.connection ?? "connected",
    ...(patch.conversation === undefined
      ? {}
      : { conversation: { conversation: { id: id(patch.conversation) } } }),
    ...(patch.side === undefined ? {} : { side: { id: id(patch.side) } }),
  }) as unknown as DurableView;

const fakeRemote = () => {
  const switchConversation = vi.fn(async () => {});
  const clearConversation = vi.fn(async () => {});
  const close = vi.fn();
  return {
    remote: { controller: { switchConversation, clearConversation }, close } as unknown as RemoteDurable,
    switchConversation,
    clearConversation,
    close,
  };
};

describe("useConversationFocus", () => {
  it("subscribes the focused conversation and releases it when focus leaves", () => {
    const fake = fakeRemote();
    const { rerender } = renderHook(
      ({ target, current }) => useConversationFocus(fake.remote, current, target),
      { initialProps: { target: id(1) as ConversationId | undefined, current: view() } },
    );
    expect(fake.switchConversation).toHaveBeenCalledWith(id(1));

    // Same host, another conversation: switch once.
    rerender({ target: id(2), current: view({ conversation: 1 }) });
    expect(fake.switchConversation).toHaveBeenLastCalledWith(id(2));

    // Focus moved to another host (or the draft): release both slots.
    rerender({ target: undefined, current: view({ conversation: 2 }) });
    expect(fake.clearConversation).toHaveBeenCalledTimes(1);

    // And the connection itself is never closed by focusing.
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("does not clear a host that was already idle", () => {
    const fake = fakeRemote();
    renderHook(() => useConversationFocus(fake.remote, view(), undefined));
    expect(fake.clearConversation).not.toHaveBeenCalled();
  });

  it("waits for the connection before switching or releasing", () => {
    const fake = fakeRemote();
    const { rerender } = renderHook(
      ({ target, connection }) => useConversationFocus(fake.remote, view({ connection }), target),
      {
        initialProps: {
          target: id(1) as ConversationId | undefined,
          connection: "reconnecting" as DurableView["connection"],
        },
      },
    );
    expect(fake.switchConversation).not.toHaveBeenCalled();
    rerender({ target: id(1), connection: "connected" as DurableView["connection"] });
    expect(fake.switchConversation).toHaveBeenCalledWith(id(1));
  });

  it("clears focus when the shown conversation is archived instead of reopening it", () => {
    const fake = fakeRemote();
    const unavailable = vi.fn();
    const { rerender } = renderHook(
      ({ target, current }) => useConversationFocus(fake.remote, current, target, { onUnavailable: unavailable }),
      { initialProps: { target: id(5) as ConversationId | undefined, current: view({ conversation: 5 }) } },
    );
    // Shown already: no switch, just remember that this target landed.
    expect(fake.switchConversation).not.toHaveBeenCalled();

    // Archive/unsubscribe makes the host drop the conversation while focus
    // still points at it.
    rerender({ target: id(5), current: view() });
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(fake.switchConversation).not.toHaveBeenCalled();
  });

  it("does not re-switch the already shown conversation", () => {
    const fake = fakeRemote();
    const { rerender } = renderHook(
      ({ target }) => useConversationFocus(fake.remote, view({ conversation: 3 }), target),
      { initialProps: { target: id(3) as ConversationId | undefined } },
    );
    rerender({ target: id(3) });
    expect(fake.switchConversation).not.toHaveBeenCalled();
  });
});
