// The side panel is opened from its surface icons at the right of the chat
// header (ADR-0040): an icon opens its surface, the shown surface's icon
// closes the panel, and the Tasks icon carries the live-activity dot.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Workbench } from "./App.tsx";
import { HostsContext } from "./entities/host/host-store.ts";
import { fakeHosts, fakeRemote, fakeView, HOME_HOST, PARSER_ID } from "./test/story-fixtures.tsx";

function renderWorkbench() {
  const view = fakeView();
  const hosts = { ...fakeHosts([HOME_HOST], HOME_HOST.hostKey), focus: { hostKey: HOME_HOST.hostKey, conversationId: PARSER_ID } };
  render(
    <HostsContext.Provider value={hosts}>
      <Workbench remote={fakeRemote(view)} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
    </HostsContext.Provider>,
  );
}

describe("side panel surfaces", () => {
  it("opens Tasks from its header icon and closes from the same icon", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    expect(screen.queryByRole("complementary", { name: "Side panel" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Tasks" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    expect(panel).toHaveTextContent("Write regression tests");

    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByRole("complementary", { name: "Side panel" })).toBeNull();
  });

  it("lights the Tasks icon while foreground work runs out of sight", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    // The fixture's parser family has a running foreground subagent.
    expect(screen.getByRole("img", { name: "Live activity" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByRole("img", { name: "Live activity" })).toBeNull();
  });

  it("gives the panel its own top bar beside the chat header", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    // The header covers the chat column only; the panel's first row is its own.
    expect(within(panel).queryByRole("heading")).toBeNull();
    expect(within(panel).getByText("1 running")).toBeInTheDocument();
  });
});
