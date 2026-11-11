import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@pinomad/protocol/terminals.ts";
import { RenameTerminalDialog } from "./rename-terminal-dialog.tsx";

describe("RenameTerminalDialog", () => {
  it("opens with the current name selected, so typing replaces it", async () => {
    const terminal = { id: "t1", name: "build", renamed: true } as unknown as TerminalInfo;
    render(<RenameTerminalDialog terminal={terminal} terminals={{ rename: async () => {} }} connected onClose={() => {}} />);
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
    await waitFor(() => expect(input).toHaveFocus());
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "build".length]);
  });
});
