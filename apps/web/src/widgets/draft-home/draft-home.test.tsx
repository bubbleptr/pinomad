// The draft screen's send path (issue #321): a file still uploading blocks
// both Enter and the button, and the eventual create carries its id.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { DraftHome } from "./draft-home.tsx";

describe("DraftHome attachment uploads", () => {
  it("blocks Enter and Send until every file is uploaded, then creates with their ids", async () => {
    let finish!: (value: { received: number; complete: boolean }) => void;
    const appendAttachment = vi.fn(
      () =>
        new Promise<{ received: number; complete: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const view = fakeView();
    const remote = fakeRemote(view, {
      beginAttachment: vi.fn(async () => "B".repeat(22)),
      appendAttachment,
    });
    render(
      <DraftHome
        view={view}
        remote={remote}
        draft={{ kind: "chat" }}
        onDraft={() => {}}
        onCreated={() => {}}
        connected
      />,
    );
    const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    fireEvent.change(picker, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(appendAttachment).toHaveBeenCalled());
    expect(screen.getByText("Uploading files…")).toBeInTheDocument();

    editable.textContent = "look";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(remote.controller.createConversation).not.toHaveBeenCalled();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(remote.controller.createConversation).not.toHaveBeenCalled();

    await act(async () => finish({ received: 5, complete: true }));
    await waitFor(() =>
      expect(screen.getByTestId("file-attachment-chip").getAttribute("data-status")).toBe("done"),
    );
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(remote.controller.createConversation).toHaveBeenCalledWith(
      { kind: "chat" },
      "look",
      expect.objectContaining({ attachments: ["B".repeat(22)] }),
    );
  });
});
