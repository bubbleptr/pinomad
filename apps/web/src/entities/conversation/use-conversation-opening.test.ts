import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { useConversationOpening } from "./use-conversation-opening.ts";

const id = (n: number): ConversationId => n as ConversationId;

// A remote whose switches settle when the test says so, showing whatever
// conversation the test leaves current — like the real one, a failed switch
// resolves too (the controller turns the error into a notice).
function deferredRemote(shown: ConversationId) {
  let current = shown;
  const pending: (() => void)[] = [];
  const remote = {
    view: { current: () => ({ conversation: { conversation: { id: current } } }) as DurableView, subscribe: () => () => {} },
    controller: { switchConversation: () => new Promise<void>((resolve) => pending.push(resolve)) },
  } as unknown as RemoteDurable;
  const settle = async (lands: ConversationId | undefined): Promise<void> => {
    if (lands !== undefined) current = lands;
    await act(async () => pending.shift()?.());
  };
  return { remote, settle };
}

describe("useConversationOpening", () => {
  it("marks the conversation opening at once and clears it when its view lands", async () => {
    const { remote, settle } = deferredRemote(id(1));
    const { result } = renderHook(() => useConversationOpening(remote));
    act(() => result.current.open(id(2)));
    expect(result.current.opening).toEqual({ id: id(2), failed: false });
    await settle(id(2));
    expect(result.current.opening).toBeUndefined();
  });

  it("fails the opening when the switch settles without showing it", async () => {
    const { remote, settle } = deferredRemote(id(1));
    const { result } = renderHook(() => useConversationOpening(remote));
    act(() => result.current.open(id(2)));
    await settle(undefined);
    expect(result.current.opening).toEqual({ id: id(2), failed: true });
  });

  it("keeps the latest click opening while an earlier switch lands", async () => {
    const { remote, settle } = deferredRemote(id(1));
    const { result } = renderHook(() => useConversationOpening(remote));
    act(() => result.current.open(id(2)));
    act(() => result.current.open(id(3)));
    await settle(id(2));
    expect(result.current.opening).toEqual({ id: id(3), failed: false });
    await settle(id(3));
    expect(result.current.opening).toBeUndefined();
  });

  it("forgets an opening the reader left before it landed", async () => {
    const { remote, settle } = deferredRemote(id(1));
    const { result } = renderHook(() => useConversationOpening(remote));
    act(() => result.current.open(id(2)));
    act(() => result.current.cancel());
    await settle(undefined);
    expect(result.current.opening).toBeUndefined();
  });
});
