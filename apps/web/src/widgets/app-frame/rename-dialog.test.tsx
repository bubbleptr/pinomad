import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { RenameConversationDialog } from "./rename-dialog.tsx";

const remote = { controller: { renameConversation: async () => {} } } as unknown as RemoteDurable;

describe("RenameConversationDialog", () => {
  it("opens with the old title selected, so typing replaces it", async () => {
    const title = "Fix the parser's trailing-comma bug";
    render(
      <RenameConversationDialog
        summary={{ id: 1 as ConversationId, kind: "conversation", title } as never}
        remote={remote}
        connected
        onClose={() => {}}
      />,
    );
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Title" });
    await waitFor(() => expect(input).toHaveFocus());
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, title.length]);
  });

  it("marks an over-long title invalid without asking the host, until it is edited", async () => {
    let calls = 0;
    const counting = { controller: { renameConversation: async () => void calls++ } } as unknown as RemoteDurable;
    render(
      <RenameConversationDialog
        summary={{ id: 1 as ConversationId, kind: "conversation", title: "old" } as never}
        remote={counting}
        connected
        onClose={() => {}}
      />,
    );
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "x".repeat(201) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Title is too long (200 characters at most)");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Title is too long (200 characters at most)");
    expect(calls).toBe(0);

    fireEvent.change(input, { target: { value: "shorter" } });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the host's refusal for the whole dialog, not on the title", async () => {
    const refusing = {
      controller: {
        renameConversation: async () => Promise.reject(new Error("Subagent conversations are named by the call that started them")),
      },
    } as unknown as RemoteDurable;
    render(
      <RenameConversationDialog
        summary={{ id: 1 as ConversationId, kind: "conversation", title: "old" } as never}
        remote={refusing}
        connected
        onClose={() => {}}
      />,
    );
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Subagent conversations are named by the call that started them");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAccessibleDescription(/Subagent/);
  });
});
