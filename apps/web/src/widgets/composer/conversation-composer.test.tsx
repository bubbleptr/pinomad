// Send-time command handling (issue #254, ADR-0027) in the conversation
// composer: a disabled command isn't run, text is never a command before the
// host's list lands, and a pre-5.15 host keeps the old Compact item.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CommandListing } from "@pinomad/protocol/commands.ts";
import type { ConversationSummary, DurableController } from "@pinomad/protocol/view.ts";
import { fakeRemote, fakeView, PARSER_ID, PINOMAD } from "../../test/story-fixtures.tsx";
import { ConversationComposer } from "./conversation-composer.tsx";

function setup(options: {
  listCommands?: () => Promise<CommandListing>;
  minor?: number;
  summary?: ConversationSummary;
  controller?: Partial<DurableController>;
} = {}) {
  const base = fakeView(options.minor === undefined ? {} : { host: { version: "0.8.0", protocol: { major: 5, minor: options.minor } } });
  const view = options.summary === undefined
    ? base
    : {
        ...base,
        organized: {
          chats: [],
          projects: [{ project: PINOMAD, conversations: [{ summary: options.summary, children: [] }] }],
          archived: [],
        },
      };
  const remote = fakeRemote(view, {
    ...(options.listCommands === undefined ? {} : { listCommands: vi.fn(options.listCommands) }),
    ...options.controller,
  });
  render(<ConversationComposer view={view} remote={remote} conversation={view.conversation!} busy={false} narrow={false} />);
  const editable = document.querySelector<HTMLElement>('[aria-multiline="true"]')!;
  const type = (text: string): void => {
    editable.textContent = text;
    fireEvent.input(editable);
  };
  return { remote, editable, type };
}

describe("ConversationComposer commands", () => {
  it("shows a disabled command's reason instead of running it", async () => {
    const { remote, editable, type } = setup({
      listCommands: async () => ({
        commands: [{ name: "compact", description: "Compact", source: "builtin", disabled: "Busy compacting already" }],
      }),
    });
    await act(async () => {});
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
    expect(remote.controller.submit).toHaveBeenCalledWith("/compact", "steer", { images: [], skills: [] });
  });

  it("keeps Compact conversation and asks for no commands on a pre-5.15 host", async () => {
    const { remote } = setup({ minor: 14 });
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: /^Compact conversation/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Run a command/, hidden: true })).toBeNull();
    expect(remote.controller.listCommands).not.toHaveBeenCalled();
  });

  it("offers Run a command… instead of Compact on a 5.15 host", async () => {
    setup();
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: /^Run a command/, hidden: true })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: /^Compact conversation/, hidden: true })).toBeNull();
  });

  it("shows Run a command… disabled while the list loads", async () => {
    setup({ listCommands: () => new Promise(() => {}) });
    await act(async () => {});
    const row = screen.getByRole("menuitem", { name: /^Run a command/, hidden: true });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("Loading…");
  });

  it("offers Attach files… only on a 5.19 host", async () => {
    setup();
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: /^Attach files/, hidden: true })).toBeInTheDocument();
  });

  it("hides Attach files… on a pre-5.19 host", async () => {
    setup({ minor: 18 });
    await act(async () => {});
    expect(screen.queryByRole("menuitem", { name: /^Attach files/, hidden: true })).toBeNull();
  });
});

describe("ConversationComposer attachment uploads", () => {
  it("blocks Enter and Send until every file is uploaded, then sends their ids", async () => {
    let finish!: (value: { received: number; complete: boolean }) => void;
    const appendAttachment = vi.fn(
      () =>
        new Promise<{ received: number; complete: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const { remote, editable, type } = setup({
      controller: {
        beginAttachment: vi.fn(async () => "A".repeat(22)),
        appendAttachment,
      },
    });
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    fireEvent.change(picker, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(appendAttachment).toHaveBeenCalled());
    expect(screen.getByText("Uploading files…")).toBeInTheDocument();

    type("look");
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(remote.controller.submit).not.toHaveBeenCalled();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(remote.controller.submit).not.toHaveBeenCalled();

    await act(async () => finish({ received: 5, complete: true }));
    await waitFor(() =>
      expect(screen.getByTestId("file-attachment-chip").getAttribute("data-status")).toBe("done"),
    );
    expect(send).not.toBeDisabled();
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(remote.controller.submit).toHaveBeenCalledWith("look", "steer", {
      images: [],
      skills: [],
      attachments: ["A".repeat(22)],
      attachmentDetails: [{ id: "A".repeat(22), name: "notes.txt", size: 5 }],
    });
  });
});

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: PARSER_ID,
  kind: "conversation",
  title: "Fix the parser's trailing-comma bug",
  ...overrides,
});

async function openAgentPopover(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByTestId("model-thinking-trigger"));
  return screen.getByTestId("model-thinking-popover");
}

describe("ConversationComposer agent switching", () => {
  it("calls setAgent with the picked role and shows currentAgent over role", async () => {
    const { remote } = setup({ summary: summary({ role: "reviewer", currentAgent: "tester" }) });
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("@tester");

    const popover = await openAgentPopover();
    await userEvent.setup().click(within(popover).getByRole("button", { name: /reviewer/ }));
    expect(remote.controller.setAgent).toHaveBeenCalledWith("reviewer");
  });

  it("calls setAgent(null) for No agent", async () => {
    const { remote } = setup({ summary: summary({ currentAgent: "tester" }) });
    const popover = await openAgentPopover();
    await userEvent.setup().click(within(popover).getByRole("button", { name: /No agent/ }));
    expect(remote.controller.setAgent).toHaveBeenLastCalledWith(null);
  });

  it("treats a present null currentAgent as no agent, not the creation role", async () => {
    setup({ summary: summary({ role: "reviewer", currentAgent: null }) });
    expect(screen.getByTestId("model-thinking-trigger")).not.toHaveTextContent("@");

    const popover = await openAgentPopover();
    expect(within(popover).getByText("Agent · sets the system prompt")).toBeInTheDocument();
    const noAgent = within(popover).getByRole("button", { name: /No agent/ }).closest("li")!;
    expect(noAgent).toHaveAttribute("aria-current", "true");
  });

  it("keeps a pre-5.18 host read-only", async () => {
    const { remote } = setup({ minor: 17, summary: summary({ role: "reviewer" }) });
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("@reviewer");

    const popover = await openAgentPopover();
    expect(within(popover).getByText("Agent · fixed at creation")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /No agent/ })).toBeNull();
    expect(remote.controller.setAgent).not.toHaveBeenCalled();
  });

  it("keeps a subagent read-only on a 5.18 host", async () => {
    const { remote } = setup({ summary: summary({ kind: "subagent", role: "tester", currentAgent: "tester" }) });
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("@tester");

    const popover = await openAgentPopover();
    expect(within(popover).getByText("Agent · fixed at creation")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /No agent/ })).toBeNull();
    expect(remote.controller.setAgent).not.toHaveBeenCalled();
  });

  it("keeps a current agent the host no longer lists selected and unavailable", async () => {
    setup({ summary: summary({ currentAgent: "deleted" }) });
    const popover = await openAgentPopover();
    const row = within(popover).getByText("deleted").closest("li")!;
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("No longer available");
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
