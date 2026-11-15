import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { fakeMachines, HOME_HOST, PINOMAD, RUNNING_TASK_ID, TASK, WEBSITE, withInbox, INTAKE_ID } from "../../test/story-fixtures.tsx";
import * as stories from "./sidebar.stories.tsx";
import * as frameStories from "./app-frame.stories.tsx";

const { CodingWithInbox, InboxMode, InboxQueuedTaskShown } = composeStories(stories);
const { Conversation, InboxTaskShown } = composeStories(frameStories);

describe("the sidebar's mode", () => {
  it("follows an Inbox conversation into main, and is remembered", async () => {
    window.localStorage.setItem("pinomad.sidebar.mode", "coding");
    render(<InboxTaskShown />);
    expect(screen.getByRole("radio", { name: "Inbox" })).toBeChecked();
    expect(window.localStorage.getItem("pinomad.sidebar.mode")).toBe("inbox");
    cleanup();

    // A coding conversation in main leaves the user's choice alone.
    render(<Conversation />);
    expect(screen.getByRole("radio", { name: "Inbox" })).toBeChecked();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Coding" }));
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("coding mode", () => {
  it("leaves the Inbox's conversations to Inbox mode", () => {
    render(<CodingWithInbox />);
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inbox intake" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Avatar sometimes missing after sign-in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Memory tidy-up" })).toBeNull();
  });

  it("switches to Inbox mode from the switch", async () => {
    const user = userEvent.setup();
    render(<CodingWithInbox />);
    await user.click(screen.getByRole("radio", { name: "Inbox" }));
    expect(CodingWithInbox.args.onModeChange).toHaveBeenCalledWith("inbox");
  });
});

describe("Inbox mode", () => {
  const group = (name: string) => screen.getByRole("group", { name: `pinomad: ${name}` });

  it("groups each project's tasks, queued ones in the worker's order", () => {
    render(<InboxMode />);
    expect(within(group("Waiting for you")).getByRole("button", { name: /Settings button hidden on mobile/ })).toBeInTheDocument();
    expect(within(group("In progress")).getByRole("button", { name: /Avatar sometimes missing/ })).toHaveAttribute("aria-current", "page");
    const queued = within(group("Queued")).getAllByRole("button", { name: /^(CSV export|Order filters)/ });
    expect(queued.map((each) => each.textContent)).toEqual([
      expect.stringContaining("#1 in queue"),
      expect.stringContaining("#2 in queue"),
    ]);
    expect(queued[0]).toHaveTextContent("CSV export garbles Chinese text");
    expect(within(group("Done")).getByRole("button", { name: /Memory tidy-up/ })).toBeInTheDocument();
    // An empty Inbox keeps its project row and lists nothing under it.
    expect(screen.getByRole("button", { name: /website/ })).toHaveTextContent("Empty");
    expect(screen.queryByRole("group", { name: /^website: / })).toBeNull();
  });

  it("opens an intake that exists, and the intake screen of one that does not yet", async () => {
    const user = userEvent.setup();
    render(<InboxMode />);
    await user.click(screen.getByRole("button", { name: /^pinomad/ }));
    expect(InboxMode.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, INTAKE_ID);
    await user.click(screen.getByRole("button", { name: /^website/ }));
    expect(InboxMode.args.onInboxTarget).toHaveBeenCalledWith(HOME_HOST.hostKey, { project: WEBSITE.path });
  });

  it("opens a task's conversation, or its queued screen before the worker takes it", async () => {
    const user = userEvent.setup();
    render(<InboxMode />);
    await user.click(screen.getByRole("button", { name: /Settings button hidden on mobile/ }));
    expect(InboxMode.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, expect.any(Number));
    await user.click(screen.getByRole("button", { name: /^CSV export garbles Chinese text/ }));
    expect(InboxMode.args.onInboxTarget).toHaveBeenCalledWith(HOME_HOST.hostKey, { project: PINOMAD.path, task: TASK.queued });
  });

  it("selects the queued task whose screen is shown", () => {
    render(<InboxQueuedTaskShown />);
    expect(screen.getByRole("button", { name: /^CSV export garbles Chinese text/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^pinomad/ })).not.toHaveAttribute("aria-current");
  });

  it("offers Skip on queued tasks only", async () => {
    const user = userEvent.setup();
    const machines = fakeMachines({ home: withInbox() });
    render(<InboxMode machines={machines} />);
    expect(screen.queryByRole("button", { name: "Task actions for Avatar sometimes missing after sign-in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Task actions for Settings button hidden on mobile" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Task actions for CSV export garbles Chinese text" }));
    await user.click(await screen.findByRole("menuitem", { name: "Skip" }));
    expect(machines[0]!.remote!.controller.skipInboxTask).toHaveBeenCalledWith(PINOMAD.path, TASK.queued);
  });

  it("selects the running task's row when its conversation is shown", () => {
    render(<InboxMode shownId={RUNNING_TASK_ID} />);
    expect(screen.getByRole("button", { name: /Avatar sometimes missing/ })).toHaveAttribute("aria-current", "page");
  });
});
