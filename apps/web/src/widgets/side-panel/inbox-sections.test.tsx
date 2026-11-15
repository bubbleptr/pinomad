import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRemote, PINOMAD, PINOMAD_INBOX, WEBSITE_INBOX, withInbox } from "../../test/story-fixtures.tsx";
import { InboxSections } from "./inbox-sections.tsx";
import * as stories from "./side-panel.stories.tsx";

const { InboxTasks } = composeStories(stories);

afterEach(cleanup);

const setup = () => {
  const view = withInbox();
  const remote = fakeRemote(view);
  render(<InboxTasks view={view} remote={remote} />);
  return { remote, user: userEvent.setup() };
};

describe("the Inbox's follow-ups on the Tasks page", () => {
  it("cancels a follow-up but never the daily tidy-up", async () => {
    const { remote, user } = setup();
    const list = screen.getByRole("list", { name: "Follow-ups" });
    expect(within(list).getByText("Daily memory tidy-up")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Daily memory tidy-up/ })).toBeNull();
    await user.click(within(list).getByRole("button", { name: "Cancel follow-up: Check whether #409 got a review" }));
    expect(remote.controller.cancelFollowUp).toHaveBeenCalledWith("wake:1");
  });
});

describe("the Inbox's rules on the Tasks page", () => {
  it("saves the edited rules", async () => {
    const { remote, user } = setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Rules" });
    await user.clear(box);
    await user.type(box, "Ask before touching CI.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(remote.controller.setInboxRules).toHaveBeenCalledWith(PINOMAD.path, "Ask before touching CI.");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("keeps the draft and says why when the host refuses it", async () => {
    const { remote, user } = setup();
    vi.mocked(remote.controller.setInboxRules).mockRejectedValueOnce(new Error("The rules are too long: at most 16 KB"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByRole("textbox", { name: "Rules" }), " More.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The rules are too long");
    expect((screen.getByRole("textbox", { name: "Rules" }) as HTMLTextAreaElement).value).toMatch(/More\.$/);
  });
});

describe("the Inbox's base branch on the Tasks page (#846)", () => {
  it("picks another branch, and goes back to the default when left empty", async () => {
    const { remote, user } = setup();
    const section = screen.getByRole("region", { name: "Base branch" });
    expect(within(section).getByText("main")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Change" }));
    const box = within(section).getByRole("textbox", { name: "Base branch" });
    await user.clear(box);
    await user.type(box, "release");
    await user.click(within(section).getByRole("button", { name: "Save" }));
    expect(remote.controller.setInboxBaseBranch).toHaveBeenCalledWith(PINOMAD.path, "release");

    await user.click(await within(section).findByRole("button", { name: "Change" }));
    await user.clear(within(section).getByRole("textbox", { name: "Base branch" }));
    await user.click(within(section).getByRole("button", { name: "Save" }));
    expect(remote.controller.setInboxBaseBranch).toHaveBeenLastCalledWith(PINOMAD.path, null);
  });

  it("drops a draft when the panel moves to another project, so Save cannot change that one", async () => {
    const remote = fakeRemote(withInbox());
    const user = userEvent.setup();
    const props = { remote, connected: true, plugins: [], externalSources: true };
    const { rerender } = render(<InboxSections inbox={PINOMAD_INBOX} {...props} />);
    await user.click(within(screen.getByRole("region", { name: "Base branch" })).getByRole("button", { name: "Change" }));
    await user.type(screen.getByRole("textbox", { name: "Base branch" }), "-next");
    rerender(<InboxSections inbox={{ ...WEBSITE_INBOX, baseBranch: "trunk" }} {...props} />);
    const section = screen.getByRole("region", { name: "Base branch" });
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(within(section).getByText("trunk")).toBeInTheDocument();
  });

  it("keeps the draft and says why when the branch does not exist", async () => {
    const { remote, user } = setup();
    vi.mocked(remote.controller.setInboxBaseBranch).mockRejectedValueOnce(new Error('The Inbox\'s base branch "nope" does not exist'));
    const section = screen.getByRole("region", { name: "Base branch" });
    await user.click(within(section).getByRole("button", { name: "Change" }));
    const box = within(section).getByRole("textbox", { name: "Base branch" });
    await user.clear(box);
    await user.type(box, "nope");
    await user.click(within(section).getByRole("button", { name: "Save" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent('"nope" does not exist');
    expect((within(section).getByRole("textbox", { name: "Base branch" }) as HTMLInputElement).value).toBe("nope");
  });
});
