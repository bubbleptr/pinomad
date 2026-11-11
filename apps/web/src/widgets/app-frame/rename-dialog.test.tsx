import { render, screen, waitFor } from "@testing-library/react";
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
});
