import { composeStories } from "@storybook/react-vite";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import * as stories from "./inbox-settings.stories.tsx";

const { Defaults, Custom } = composeStories(stories);

afterEach(cleanup);

describe("Inbox settings", () => {
  it("turns quiet hours on with an overnight window", async () => {
    const view = fakeView();
    const remote = fakeRemote(view);
    render(<Defaults view={view} remote={remote} />);
    await userEvent.setup().click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(remote.controller.updateSettings).toHaveBeenCalledWith({ inboxQuietHours: { start: 1320, end: 480 } });
  });

  it("moves one end of quiet hours and turns them off", async () => {
    render(<Custom />);
    fireEvent.change(screen.getByLabelText("Quiet hours end"), { target: { value: "06:45" } });
    expect(Custom.args.remote!.controller.updateSettings).toHaveBeenCalledWith({ inboxQuietHours: { start: 1320, end: 405 } });
    await userEvent.setup().click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(Custom.args.remote!.controller.updateSettings).toHaveBeenLastCalledWith({ inboxQuietHours: null });
  });

  it("picks a worker model, and resets both models to the default", async () => {
    const user = userEvent.setup();
    const view = fakeView();
    const remote = fakeRemote(view);
    render(<Defaults view={view} remote={remote} />);
    expect(screen.queryByRole("button", { name: "Use the default model" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Worker model" }));
    await user.click(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(remote.controller.updateSettings).toHaveBeenCalledWith({ inboxWorkerModel: { provider: "openai", modelId: "gpt-5" } });

    cleanup();
    render(<Custom />);
    await user.click(screen.getByRole("button", { name: "Use the default model" }));
    expect(Custom.args.remote!.controller.updateSettings).toHaveBeenCalledWith({ inboxIntakeModel: null, inboxWorkerModel: null });
  });

  it("offers no model rows on a 5.39 host, and nothing before the Inbox", () => {
    const v39 = fakeView({ host: { version: "0.18.0", protocol: { major: 5, minor: 39 } } });
    render(<Defaults view={v39} remote={fakeRemote(v39)} />);
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Worker model" })).toBeNull();
    cleanup();
    const v37 = fakeView({ host: { version: "0.8.0", protocol: { major: 5, minor: 37 } } });
    const { container } = render(<Defaults view={v37} remote={fakeRemote(v37)} />);
    expect(container.querySelector('[data-slot="switch"]')).toBeNull();
  });
});
