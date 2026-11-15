import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fn } from "storybook/test";
import { fakeRemote, PINOMAD, TASK, WEBSITE, withInbox } from "../../test/story-fixtures.tsx";
import * as stories from "./inbox-screen.stories.tsx";

const { IntakeDraft, QueuedTask } = composeStories(stories);

afterEach(cleanup);

const typeAndSend = async (text: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard(text);
  await user.keyboard("{Enter}");
};

describe("the intake before its first message", () => {
  it("sends the message to the project's intake, then opens the intake", async () => {
    const view = withInbox();
    const remote = fakeRemote(view);
    vi.mocked(remote.controller.sendToIntake).mockResolvedValueOnce(77 as ConversationId);
    const onOpened = fn();
    render(<IntakeDraft view={view} remote={remote} onOpened={onOpened} />);
    await typeAndSend("Export is broken");
    expect(remote.controller.sendToIntake).toHaveBeenCalledWith(WEBSITE.path, "Export is broken");
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(77, WEBSITE.path));
  });

  it("keeps the message and shows why when the host refuses it", async () => {
    const view = withInbox();
    const remote = fakeRemote(view);
    vi.mocked(remote.controller.sendToIntake).mockRejectedValueOnce(new Error("The Inbox is still starting"));
    const onOpened = fn();
    render(<IntakeDraft view={view} remote={remote} onOpened={onOpened} />);
    await typeAndSend("Export is broken");
    expect(await screen.findByText("The Inbox is still starting")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("Export is broken");
    expect(onOpened).not.toHaveBeenCalled();
  });
});

describe("a queued task", () => {
  it("shows its place in the queue and skips it", async () => {
    const view = withInbox();
    const remote = fakeRemote(view);
    render(<QueuedTask view={view} remote={remote} />);
    expect(screen.getByText(/#2 in queue/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Skip" }));
    expect(remote.controller.skipInboxTask).toHaveBeenCalledWith(PINOMAD.path, TASK.queuedSecond);
  });
});
