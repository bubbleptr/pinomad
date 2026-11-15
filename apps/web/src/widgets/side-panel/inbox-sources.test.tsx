import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostInbox } from "@pinomad/protocol/inbox.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRemote, PINOMAD, PINOMAD_INBOX, WEBSITE_INBOX, withInbox } from "../../test/story-fixtures.tsx";
import * as stories from "./side-panel.stories.tsx";

const { InboxTasks } = composeStories(stories);

afterEach(cleanup);

const setup = (inbox?: HostInbox) => {
  const view = withInbox(undefined, inbox);
  const remote = fakeRemote(view);
  render(<InboxTasks view={view} remote={remote} />);
  return { remote, user: userEvent.setup() };
};

const sourcesList = () => screen.getByRole("list", { name: "Event sources" });
const dialog = () => screen.getByRole("dialog", { name: "Add an event source" });

describe("the Inbox's event sources on the Tasks page", () => {
  it("lists each source with what it does, its next run and its problem", () => {
    setup();
    const list = sourcesList();
    expect(within(list).getByText("Dependency check")).toBeInTheDocument();
    expect(within(list).getByText(/^Every day 08:00/)).toHaveTextContent(/· next /);
    expect(within(list).getByText(/New issues · github · kieran\/pinomad label:bug · Restricted tools/)).toBeInTheDocument();
    expect(within(list).getByText("GitHub answered 401: the token has expired")).toBeInTheDocument();
  });

  it("turns a source on with its switch, and holds the switch until the host answers", async () => {
    const { remote, user } = setup();
    vi.mocked(remote.controller.setInboxSourceEnabled).mockImplementation(() => new Promise(() => {}));
    const toggle = within(sourcesList()).getByRole("switch", { name: "NAS backups" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(remote.controller.setInboxSourceEnabled).toHaveBeenCalledWith("src-nas", true);
    expect(toggle).toHaveAttribute("aria-disabled", "true");
  });

  it("removes a source after a confirm", async () => {
    const { remote, user } = setup();
    await user.click(within(sourcesList()).getByRole("button", { name: "More for NAS backups" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove NAS backups?" });
    expect(remote.controller.removeInboxSource).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(remote.controller.removeInboxSource).toHaveBeenCalledWith("src-nas");
  });
});

describe("adding an event source", () => {
  it("won't send a schedule without a name and a note, then sends it trimmed and trusted", async () => {
    const { remote, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(remote.controller.addInboxSource).not.toHaveBeenCalled();
    expect(within(dialog()).getByText("Give it a name")).toBeInTheDocument();
    expect(within(dialog()).getByText("Say what each task should do")).toBeInTheDocument();

    await user.type(within(dialog()).getByRole("textbox", { name: "Name" }), "  Morning check  ");
    await user.type(within(dialog()).getByRole("textbox", { name: "Task" }), "Look at last night's CI runs.");
    const time = within(dialog()).getByLabelText("Time");
    await user.clear(time);
    await user.type(time, "07:30");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(remote.controller.addInboxSource).toHaveBeenCalledWith(PINOMAD.path, "Morning check", true, {
      kind: "schedule",
      schedule: { kind: "daily", time: "07:30", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      note: "Look at last night's CI runs.",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("checks a cron expression's shape and leaves the rest to the host, whose refusal keeps the form", async () => {
    const { remote, user } = setup();
    vi.mocked(remote.controller.addInboxSource).mockRejectedValueOnce(new Error("This schedule never fires"));
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "Name" }), "Leap day");
    await user.type(within(dialog()).getByRole("textbox", { name: "Task" }), "Celebrate.");
    await user.click(within(dialog()).getByRole("combobox", { name: "Repeat" }));
    await user.click(await screen.findByRole("option", { name: "Cron" }));
    const cron = within(dialog()).getByRole("textbox", { name: "Cron expression" });
    await user.type(cron, "0 9 *");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(within(dialog()).getByText("Five fields: minute hour day-of-month month day-of-week")).toBeInTheDocument();
    expect(remote.controller.addInboxSource).not.toHaveBeenCalled();

    await user.clear(cron);
    await user.type(cron, "0 9 30 2 *");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(remote.controller.addInboxSource).toHaveBeenCalledWith(PINOMAD.path, "Leap day", true, {
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 9 30 2 *", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      note: "Celebrate.",
    });
    expect(await within(dialog()).findByText("This schedule never fires")).toBeInTheDocument();
    expect(within(dialog()).getByRole("textbox", { name: "Name" })).toHaveValue("Leap day");
  });

  it("adds a plugin source with the plugin's filter, restricted unless you say otherwise", async () => {
    const { remote, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(within(dialog()).getByRole("radio", { name: "Plugin" }));
    expect(within(dialog()).getByRole("radio", { name: /Restricted tools/ })).toBeChecked();
    await user.type(within(dialog()).getByRole("textbox", { name: "Name" }), "Bugs");
    await user.type(within(dialog()).getByRole("textbox", { name: "Filter" }), "acme/web label:bug");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(remote.controller.addInboxSource).toHaveBeenCalledWith(PINOMAD.path, "Bugs", false, {
      kind: "plugin",
      plugin: "github",
      source: "issues",
      filter: "acme/web label:bug",
    });
  });

  it("shows a webhook's secret once: gone after Done, a new one only by resetting it", async () => {
    const { remote, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(within(dialog()).getByRole("radio", { name: "Webhook" }));
    await user.type(within(dialog()).getByRole("textbox", { name: "Name" }), "Deploys");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(remote.controller.addInboxSource).toHaveBeenCalledWith(PINOMAD.path, "Deploys", false, { kind: "webhook" });

    const shown = await screen.findByRole("dialog", { name: "Webhook added" });
    expect(within(shown).getByText("whsec_Hk2pQ9xN4vL7tR1sW8yB3mC6dF0gJ5aE")).toBeInTheDocument();
    expect(within(shown).getByText("src-new")).toBeInTheDocument();
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("whsec_Hk2pQ9xN4vL7tR1sW8yB3mC6dF0gJ5aE")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(screen.queryByText("whsec_Hk2pQ9xN4vL7tR1sW8yB3mC6dF0gJ5aE")).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));

    await user.click(within(sourcesList()).getByRole("button", { name: "More for NAS backups" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset secret" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Reset the secret of NAS backups?" });
    await user.click(within(confirm).getByRole("button", { name: "Reset secret" }));
    expect(remote.controller.resetInboxWebhookSecret).toHaveBeenCalledWith("src-nas");
    const reset = await screen.findByRole("dialog", { name: "New secret for NAS backups" });
    expect(within(reset).getByText("whsec_new7Qp2Lx9Vb4Nc1Md8Rf3Tg6Yh0Jk5Ws")).toBeInTheDocument();
  });

  it("offers only schedules on a host without a sandbox for Inbox runs", async () => {
    const { user } = setup({ inboxes: [PINOMAD_INBOX, WEBSITE_INBOX], externalSources: false });
    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(within(dialog()).queryByRole("radio", { name: "Plugin" })).toBeNull();
    expect(within(dialog()).queryByRole("radio", { name: "Webhook" })).toBeNull();
    expect(within(dialog()).getByText(/need a sandbox/)).toBeInTheDocument();
    expect(within(dialog()).getByRole("textbox", { name: "Task" })).toBeInTheDocument();
  });

  it("isn't offered by a host from before event sources", () => {
    const view = withInbox(undefined, { inboxes: [{ ...PINOMAD_INBOX, sources: undefined }, WEBSITE_INBOX] });
    render(<InboxTasks view={view} remote={fakeRemote(view)} inbox={{ ...PINOMAD_INBOX, sources: undefined }} />);
    expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Event sources" })).toBeNull();
  });
});
