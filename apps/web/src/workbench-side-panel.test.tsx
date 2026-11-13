// The side panel is opened from its surface icons at the right of the chat
// header (ADR-0040): an icon opens its surface, the shown surface's icon
// closes the panel, and the Tasks icon carries the live-activity dot.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Workbench } from "./App.tsx";
import { HostsContext } from "./entities/host/host-store.ts";
import {
  DARK_MODE_ID,
  fakeHosts,
  fakeProcesses,
  fakeRemote,
  fakeView,
  HOME_HOST,
  PARSER_ID,
  settledConversation,
} from "./test/story-fixtures.tsx";

/** `conversationId: undefined` puts the host's new-chat draft on screen. */
function workbench(view: ReturnType<typeof fakeView>, remote: ReturnType<typeof fakeRemote>, conversationId: typeof PARSER_ID | undefined) {
  const hosts = { ...fakeHosts([HOME_HOST], HOME_HOST.hostKey), focus: { hostKey: HOME_HOST.hostKey, conversationId } };
  return (
    <HostsContext.Provider value={hosts}>
      <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
    </HostsContext.Provider>
  );
}

function renderWorkbench(
  view = fakeView(),
  remote = fakeRemote(view),
  conversationId: typeof PARSER_ID | undefined = PARSER_ID,
) {
  return render(workbench(view, remote, conversationId));
}

describe("side panel surfaces", () => {
  afterEach(() => window.localStorage.clear());

  it("hides the built-in surfaces while drafting, and brings the open panel back after", async () => {
    const user = userEvent.setup();
    const view = fakeView();
    const remote = fakeRemote(view);
    const { rerender } = renderWorkbench(view, remote);
    await user.click(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByRole("complementary", { name: "Side panel" })).toBeInTheDocument();

    rerender(workbench(view, remote, undefined));
    for (const name of ["Tasks", "Changes", "Terminal"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Side panel" })).toBeNull();

    rerender(workbench(view, remote, PARSER_ID));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    expect(await within(panel).findByText("src/parser.ts")).toBeInTheDocument();
  });

  it("opens Changes from its icon, then switches to Tasks rather than closing", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "Changes" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    expect(await within(panel).findByText("src/parser.ts")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByRole("complementary", { name: "Side panel" })).toHaveTextContent("Write regression tests");
  });

  it("opens the overview's Changes row in the panel, not a dialog", async () => {
    window.localStorage.setItem("pinomad.overview.open", "true");
    const user = userEvent.setup();
    renderWorkbench();
    const overview = screen.getByRole("complementary", { name: "Overview" });
    await user.click(await within(overview).findByRole("button", { name: /Changes/ }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    expect(await within(panel).findByText("src/parser.ts")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

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

  it("lights the Tasks icon for a running background process alone", async () => {
    // The dark-mode family has no subagents: only the process can light it.
    const view = fakeView({ conversation: settledConversation(DARK_MODE_ID) });
    const remote = fakeRemote(
      view,
      {},
      fakeProcesses({
        lists: {
          [DARK_MODE_ID]: [
            {
              id: "p-dev",
              owner: DARK_MODE_ID,
              name: "dev server",
              command: "bun run dev",
              startedAt: Date.now(),
              state: "running",
            },
          ],
        },
      }),
    );
    renderWorkbench(view, remote, DARK_MODE_ID);
    expect(await screen.findByRole("img", { name: "Live activity" })).toBeInTheDocument();
  });

  it("leaves the Tasks icon dark when only a finished process is listed", async () => {
    const view = fakeView({ conversation: settledConversation(DARK_MODE_ID) });
    const remote = fakeRemote(
      view,
      {},
      fakeProcesses({
        lists: {
          [DARK_MODE_ID]: [
            {
              id: "p-done",
              owner: DARK_MODE_ID,
              name: "build",
              command: "bun run build",
              startedAt: Date.now() - 60_000,
              endedAt: Date.now(),
              state: { exited: 0 },
            },
          ],
        },
      }),
    );
    renderWorkbench(view, remote, DARK_MODE_ID);
    await screen.findByRole("button", { name: "Tasks" });
    expect(screen.queryByRole("img", { name: "Live activity" })).toBeNull();
  });

  it("gives the panel its own top bar beside the chat header", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    const panel = screen.getByRole("complementary", { name: "Side panel" });
    // The header covers the chat column only; the panel's first row is its own.
    expect(within(panel).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Tasks"]);
    expect(within(panel).getByText("1 running")).toBeInTheDocument();
  });
});
