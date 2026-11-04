import type { QueueItem } from "@pinomad/client/chat.ts";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueuedList, reorderBefore } from "./queued-list.tsx";

const row = (id: number, mode: QueueItem["mode"] = "followUp"): QueueItem => ({
  id,
  mode,
  text: String(id),
  imageCount: 0,
  attachmentCount: 0,
  status: "sent",
});

describe("reorderBefore", () => {
  it("drops after a row as before the next queued input, skipping writes and the moved row", () => {
    const items = [row(1), row(2), row(3, "write"), row(4)];
    expect(reorderBefore(items, 1, 2, "after")).toBe(4);
    expect(reorderBefore(items, 4, 1, "after")).toBe(2);
  });

  it("drops after the last input with no before, so the host appends it", () => {
    const items = [row(1), row(2), row(3, "write")];
    expect(reorderBefore(items, 1, 2, "after")).toBeUndefined();
  });

  it("ignores local rows the host has not admitted", () => {
    const local: QueueItem = { ...row(0), id: undefined, requestId: "r", status: "unknown" };
    expect(reorderBefore([row(1), row(2), local], 1, 2, "after")).toBeUndefined();
  });
});

describe("QueuedList drag", () => {
  const dataTransfer = () => ({ effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn() });
  const renderList = () => {
    const onReorder = vi.fn();
    render(
      <QueuedList
        items={[{ ...row(1), text: "one" }, { ...row(2), text: "two" }]}
        canAct
        canReorder
        busy
        editDisabled={false}
        narrow={false}
        pendingIds={new Set()}
        pendingRequestIds={new Set()}
        onSteer={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onWithdraw={vi.fn()}
        onReorder={onReorder}
      />,
    );
    const [one, two] = screen.getAllByTestId("chat-queued-message");
    return { onReorder, one: one!, two: two! };
  };
  const dropOnTop = (target: HTMLElement, transfer: ReturnType<typeof dataTransfer>) => {
    // jsdom has no DragEvent (init clientY is dropped) and lays nothing out
    // (every box is 0×0), so set a clientY above the midline by hand.
    const over = createEvent.dragOver(target, { dataTransfer: transfer });
    Object.defineProperty(over, "clientY", { value: -1 });
    fireEvent(target, over);
    fireEvent.drop(target, { dataTransfer: transfer });
  };

  it("does not reorder when selected body text is dragged onto another card", () => {
    const { onReorder, two } = renderList();
    // A text-selection drag starts on the body and bubbles to the card.
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByText("two"), { dataTransfer: transfer });
    dropOnTop(screen.getAllByTestId("chat-queued-message")[0]!, transfer);
    expect(onReorder).not.toHaveBeenCalled();
    expect(transfer.setData).not.toHaveBeenCalled();
    expect(two.hasAttribute("data-dragging")).toBe(false);
  });

  it("reorders when the drag starts from the handle", () => {
    const { onReorder, one, two } = renderList();
    fireEvent.pointerDown(screen.getAllByRole("button", { name: "Reorder queued message" })[1]!);
    const transfer = dataTransfer();
    fireEvent.dragStart(two, { dataTransfer: transfer });
    dropOnTop(one, transfer);
    expect(onReorder).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 1);
  });
});
