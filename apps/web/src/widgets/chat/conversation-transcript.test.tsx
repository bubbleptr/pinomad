import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ConversationTranscript } from "./conversation-transcript.tsx";

function userView(timestamp: number): ConversationView {
  return {
    conversation: { id: 0 },
    entries: [
      {
        id: 1,
        conversationId: 0,
        kind: "pi.user",
        model: [{ role: "user", content: "hi", timestamp }],
      },
    ],
    docs: { "pi.live": {} },
  } as unknown as ConversationView;
}

function renderTranscript(timestamp: number) {
  return render(
    <ConversationTranscript
      conversation={userView(timestamp)}
      toolPresentations={{}}
      connected
      canFork
      openInPanel={() => {}}
      onFork={() => {}}
    />,
  );
}

function timeLabel(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="chat-message-time"]')!;
}

const monthOf = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, { month: "short" }).format(timestamp);

describe("transcript message times", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds the date after the shared clock crosses midnight", () => {
    vi.useFakeTimers();
    const sentAt = new Date(2026, 9, 28, 23, 59).getTime();
    vi.setSystemTime(sentAt);
    const { container } = renderTranscript(sentAt);

    expect(timeLabel(container).textContent).not.toContain(monthOf(sentAt));

    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });

    expect(timeLabel(container).textContent).toContain(monthOf(sentAt));
  });

  it("rechecks the day when a suspended tab becomes visible", () => {
    vi.useFakeTimers();
    const sentAt = new Date(2026, 9, 28, 23, 59).getTime();
    vi.setSystemTime(sentAt);
    const { container } = renderTranscript(sentAt);

    expect(timeLabel(container).textContent).not.toContain(monthOf(sentAt));

    vi.setSystemTime(new Date(2026, 9, 29, 0, 1));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(timeLabel(container).textContent).toContain(monthOf(sentAt));
  });
});
