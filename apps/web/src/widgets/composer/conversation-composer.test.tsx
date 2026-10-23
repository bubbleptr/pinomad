// Send-time command handling (issue #254, ADR-0027) in the conversation
// composer: a disabled command isn't run, text is never a command before the
// host's list lands, and a pre-5.15 host keeps the old Compact item.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommandListing } from "@pinomad/protocol/commands.ts";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { ConversationComposer } from "./conversation-composer.tsx";

function setup(options: { listCommands?: () => Promise<CommandListing>; minor?: number } = {}) {
  const view = fakeView(options.minor === undefined ? {} : { host: { version: "0.8.0", protocol: { major: 5, minor: options.minor } } });
  const remote = fakeRemote(view, options.listCommands === undefined ? {} : { listCommands: vi.fn(options.listCommands) });
  render(<ConversationComposer view={view} remote={remote} conversation={view.conversation!} busy={false} narrow={false} />);
  const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
  const type = (text: string): void => {
    editable.textContent = text;
    fireEvent.input(editable);
  };
  return { remote, editable, type };
}

describe("ConversationComposer commands", () => {
  it("shows a disabled command's reason instead of running it, typed or in the + menu", async () => {
    const { remote, editable, type } = setup({
      listCommands: async () => ({
        commands: [{ name: "compact", description: "Compact", source: "builtin", disabled: "Busy compacting already" }],
      }),
    });
    await act(async () => {});
    // On an empty draft the + menu's Commands flyout greys it out with the same reason.
    const item = screen.getByRole("menuitem", { name: /^\/compact/, hidden: true });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Busy compacting already");
    type("/compact now");
    fireEvent.keyDown(editable, { key: "Enter" });
    const composer = within(document.querySelector<HTMLElement>('[data-slot="prompt-input"]')!);
    expect(await composer.findByRole("alert")).toHaveTextContent("Busy compacting already");
    expect(remote.controller.runCommand).not.toHaveBeenCalled();
    expect(remote.controller.submit).not.toHaveBeenCalled();
  });

  it("sends /text as a message while the command list hasn't loaded", async () => {
    const { remote, editable, type } = setup({ listCommands: () => new Promise(() => {}) });
    await act(async () => {});
    type("/compact");
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(remote.controller.runCommand).not.toHaveBeenCalled();
    expect(remote.controller.submit).toHaveBeenCalledWith("/compact", "steer", { images: [] });
  });

  it("keeps Compact conversation and asks for no commands on a pre-5.15 host", async () => {
    const { remote } = setup({ minor: 14 });
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: "Compact conversation", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Commands/, hidden: true })).toBeNull();
    expect(remote.controller.listCommands).not.toHaveBeenCalled();
  });

  it("offers a Commands row instead of Compact on a 5.15 host", async () => {
    setup();
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: /^Commands/, hidden: true })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Compact conversation", hidden: true })).toBeNull();
  });

  it("shows the Commands row disabled while the list loads", async () => {
    setup({ listCommands: () => new Promise(() => {}) });
    await act(async () => {});
    const row = screen.getByRole("menuitem", { name: /^Commands/, hidden: true });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("Loading…");
  });
});
