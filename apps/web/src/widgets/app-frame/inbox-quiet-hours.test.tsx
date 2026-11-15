import { composeStories } from "@storybook/react-vite";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import * as stories from "./inbox-quiet-hours.stories.tsx";

const { Off, On } = composeStories(stories);

afterEach(cleanup);

describe("Inbox quiet hours", () => {
  it("turns on with an overnight window", async () => {
    const view = fakeView();
    const remote = fakeRemote(view);
    render(<Off view={view} remote={remote} />);
    await userEvent.setup().click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(remote.controller.updateSettings).toHaveBeenCalledWith({ inboxQuietHours: { start: 1320, end: 480 } });
  });

  it("moves one end and turns off", async () => {
    render(<On />);
    fireEvent.change(screen.getByLabelText("Quiet hours end"), { target: { value: "06:45" } });
    expect(On.args.remote!.controller.updateSettings).toHaveBeenCalledWith({ inboxQuietHours: { start: 1320, end: 405 } });
    await userEvent.setup().click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(On.args.remote!.controller.updateSettings).toHaveBeenLastCalledWith({ inboxQuietHours: null });
  });

  it("is not offered by a host before the Inbox", () => {
    const view = fakeView({ host: { version: "0.8.0", protocol: { major: 5, minor: 37 } } });
    const { container } = render(<Off view={view} remote={fakeRemote(view)} />);
    expect(container.querySelector('[data-slot="switch"]')).toBeNull();
  });
});
