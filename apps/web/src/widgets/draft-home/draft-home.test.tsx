// The draft screen's send path (issue #321): a file still uploading blocks
// both Enter and the button, and the eventual create carries its id.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { HostComposerContext } from "../../entities/composer/composer-context.tsx";
import { HostComposerStore } from "../../entities/composer/composer-store.ts";
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

  it("does not create twice when the screen unmounts during submit", async () => {
    let resolveCreate!: () => void;
    const createConversation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const view = fakeView();
    const remote = fakeRemote(view, { createConversation });
    const store = new HostComposerStore();
    const renderDraft = () =>
      render(
        <HostComposerContext.Provider value={store}>
          <DraftHome
            view={view}
            remote={remote}
            draft={store.slot("new").snapshot().home}
            onDraft={() => {}}
            onCreated={() => {}}
            connected
          />
        </HostComposerContext.Provider>,
      );
    const first = renderDraft();
    const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    editable.textContent = "send exactly once";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(createConversation).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderDraft();
    const again = second.container.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    fireEvent.keyDown(again, { key: "Enter" });
    expect(createConversation).toHaveBeenCalledTimes(1);
    await act(async () => resolveCreate());
  });

  it("keeps a half-written draft and its upload after the screen unmounts", async () => {
    let finish!: (value: { received: number; complete: boolean }) => void;
    const appendAttachment = vi.fn(
      () =>
        new Promise<{ received: number; complete: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const view = fakeView();
    const remote = fakeRemote(view, {
      beginAttachment: vi.fn(async () => "C".repeat(22)),
      appendAttachment,
    });
    const store = new HostComposerStore();
    const renderDraft = () =>
      render(
        <HostComposerContext.Provider value={store}>
          <DraftHome
            view={view}
            remote={remote}
            draft={store.slot("new").snapshot().home}
            onDraft={() => {}}
            onCreated={() => {}}
            connected
          />
        </HostComposerContext.Provider>,
      );
    const first = renderDraft();
    const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    fireEvent.change(picker, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(appendAttachment).toHaveBeenCalled());
    editable.textContent = "half-written prompt";
    fireEvent.input(editable);
    first.unmount();

    await act(async () => finish({ received: 5, complete: true }));
    const second = renderDraft();
    await waitFor(() =>
      expect(screen.getByTestId("file-attachment-chip").getAttribute("data-status")).toBe("done"),
    );
    expect(second.container.querySelector<HTMLElement>('[aria-multiline="true"]')!.textContent).toBe(
      "half-written prompt",
    );
  });
});

describe("DraftHome machine picker", () => {
  const options = [
    { value: "home", label: "kieran-mbp" },
    { value: "devbox", label: "omarchy" },
  ];
  const renderWith = (machine?: Parameters<typeof DraftHome>[0]["machine"]) => {
    const view = fakeView();
    return render(
      <DraftHome
        view={view}
        remote={fakeRemote(view)}
        draft={{ kind: "chat" }}
        onDraft={() => {}}
        onCreated={() => {}}
        connected
        {...(machine === undefined ? {} : { machine })}
      />,
    );
  };

  it("stays hidden with a single paired machine", () => {
    renderWith({ value: "home", options: options.slice(0, 1), onChange: () => {} });
    expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
  });

  it("hands another machine's key to the caller instead of editing this draft", async () => {
    const onChange = vi.fn();
    renderWith({ value: "home", options, onChange });
    await userEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    await userEvent.click(await screen.findByRole("option", { name: "omarchy" }));
    expect(onChange).toHaveBeenCalledWith("devbox");
  });
});
