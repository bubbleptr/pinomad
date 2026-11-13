// The side panel belongs to the family the main column shows. It lists only
// Foreground Tasks; Forks are independent conversations in the sidebar now.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isProcessActive } from "@pinomad/protocol/processes.ts";
import {
  DARK_MODE_ID,
  fakeProcesses,
  fakeRemote,
  fakeView,
  FORK_ID,
  forkConversation,
  MIXED_SUBAGENTS,
  PARSER_ID,
  PROCESSES,
  SUBAGENT_ID,
  subagentConversation,
  withBackgroundSubagents,
  withSubagents,
  withSummary,
} from "../../test/story-fixtures.tsx";
import { SidePanel } from "./side-panel.tsx";

// xterm parses host output asynchronously; these tests only need the id it
// was fed, and a way to say the host no longer has the output.
vi.mock("./lazy-xterm-view.tsx", async () => {
  const { useEffect } = await import("react");
  return {
    LazyXtermView: ({ processId, onEnded }: { processId: string; onEnded?: (reason: string) => void }) => {
      useEffect(() => {
        if (processId === "p-released") onEnded?.("The output of this process is no longer available");
      }, [processId, onEnded]);
      return <div data-testid="process-output">{processId}</div>;
    },
  };
});

const view = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });

function panel(shownId: typeof PARSER_ID, panelView = view, remote: RemoteDurable = fakeRemote(panelView)) {
  return (
    <SidePanel
      view={panelView}
      remote={remote}
      shownId={shownId}
      narrow={false}
      open
      surface="tasks"
      busy={false}
      liveActivity={false}
      onOpenChange={vi.fn()}
      onSelectSurface={vi.fn()}
      openInPanel={vi.fn()}
      onOpenInMain={vi.fn()}
    />
  );
}

function renderPanel(shownId: typeof PARSER_ID, panelView = view, remote: RemoteDurable = fakeRemote(panelView)) {
  return render(panel(shownId, panelView, remote));
}

describe("SidePanel family", () => {
  it("keeps a task of the shown family open, with no Threads shell", () => {
    renderPanel(PARSER_ID);
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Threads/ })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("keeps the header and back button while the task snapshot loads", () => {
    const loading = fakeView({ side: { id: SUBAGENT_ID, docs: [] } });
    renderPanel(PARSER_ID, loading);
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();
    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in main" })).toBeInTheDocument();
  });

  it("hides a task of another family the moment that family is shown", () => {
    renderPanel(DARK_MODE_ID);
    expect(screen.queryByRole("button", { name: "Back to tasks" })).not.toBeInTheDocument();
    // The other family has no tasks; the panel says so rather than showing a fork list.
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });
});

describe("SidePanel subagents (ADR-0047)", () => {
  const tasksPanel = (panelView: typeof view, onOpenInMain = vi.fn()) => (
    <SidePanel
      view={panelView}
      remote={fakeRemote(panelView)}
      shownId={PARSER_ID}
      narrow={false}
      open
      surface="tasks"
      busy={false}
      liveActivity={false}
      onOpenChange={vi.fn()}
      onSelectSurface={vi.fn()}
      openInPanel={vi.fn()}
      onOpenInMain={onOpenInMain}
    />
  );
  const moved = (panelView: typeof view) =>
    withSummary(panelView, SUBAGENT_ID, { lifecycle: "background", name: "parser-tests", status: undefined });

  it("keeps a subagent in Tasks when it turns background", () => {
    const list = fakeView();
    const { rerender } = render(tasksPanel(list));
    expect(screen.getByText("Write regression tests")).toBeInTheDocument();

    rerender(tasksPanel(moved(list)));
    expect(screen.getByText("parser-tests")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });

  it("keeps an open detail in the panel when its subagent turns background", () => {
    const openInMain = vi.fn();
    const { rerender } = render(tasksPanel(view, openInMain));
    rerender(tasksPanel(moved(view), openInMain));

    expect(openInMain).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();
  });

  it("stops a named subagent at work from its detail, and opens it in main", () => {
    const openInMain = vi.fn();
    const named = withSummary(view, SUBAGENT_ID, { name: "parser-tests" });
    const remote = fakeRemote(named);
    render(
      <SidePanel
        view={named}
        remote={remote}
        shownId={PARSER_ID}
        narrow={false}
        open
        surface="tasks"
        busy={false}
        liveActivity={false}
        onOpenChange={vi.fn()}
        onSelectSurface={vi.fn()}
        openInPanel={vi.fn()}
        onOpenInMain={openInMain}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(remote.controller.abort).toHaveBeenCalledWith(SUBAGENT_ID);
    fireEvent.click(screen.getByRole("button", { name: "Open in main" }));
    expect(openInMain).toHaveBeenCalledWith(SUBAGENT_ID);
  });

  it("offers no Stop for an idle subagent or one from before names", () => {
    const { rerender } = render(tasksPanel(moved(view)));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    rerender(tasksPanel(view));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open in main" })).toBeInTheDocument();
  });
});

describe("SidePanel task rows", () => {
  it("orders a family's tasks running, then failed, then done, each saying its state", () => {
    renderPanel(PARSER_ID, withSubagents(fakeView(), MIXED_SUBAGENTS));
    const list = screen.getByRole("list", { name: "This conversation" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual([
      "Write regression testsRunning · bash bun test",
      "Audit error handlingWaiting for an answer",
      "Trace reconnect pathRunning · read gateway.ts",
      "Reproduce on Node 22Failed",
      "Update the changelogDone",
      "Survey existing parsersDone",
    ]);
    // Every row keeps its kind's glyph, a finished one too, so titles line up.
    for (const row of rows) expect(row.querySelector('[data-slot="task-glyph"]')).not.toBeNull();
  });

  it("names a lone group only for screen readers", () => {
    renderPanel(PARSER_ID, withSubagents(fakeView(), MIXED_SUBAGENTS));
    expect(screen.getByRole("list", { name: "This conversation" })).toBeInTheDocument();
    expect(screen.queryByText("This conversation")).toBeNull();
  });

  it("heads each group once a fork has subagents too", () => {
    renderPanel(PARSER_ID, withBackgroundSubagents(fakeView()));
    expect(screen.getByText("This conversation")).toBeInTheDocument();
    expect(screen.getByText("Try a recursive-descent rewrite")).toBeInTheDocument();
  });

  it("marks process rows apart from subagent rows", async () => {
    renderPanel(PARSER_ID, withSubagents(fakeView(), MIXED_SUBAGENTS), fakeRemote(view, {}, fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } })));
    const processes = await screen.findByRole("list", { name: "Processes" });
    const glyphs = [...processes.querySelectorAll('[data-slot="task-glyph"]')].map((glyph) => glyph.getAttribute("data-kind"));
    expect(new Set(glyphs)).toEqual(new Set(["process"]));
    const subagents = screen.getByRole("list", { name: "This conversation" });
    expect(subagents.querySelector('[data-kind="process"]')).toBeNull();
    expect(within(processes).getByRole("button", { name: /^bun test --watch/ })).toHaveTextContent("Exited 1");
  });
});

describe("SidePanel processes", () => {
  it("titles the list Tasks in its bar, with no Processes heading over ended processes", async () => {
    const ended = PROCESSES.filter((process) => !isProcessActive(process.state));
    renderPanel(PARSER_ID, fakeView(), fakeRemote(view, {}, fakeProcesses({ lists: { [PARSER_ID]: ended } })));
    expect(await screen.findByRole("list", { name: "Processes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.queryByText("Processes")).toBeNull();
  });

  it("hides the Processes group when the family has none", () => {
    renderPanel(PARSER_ID);
    expect(screen.queryByText("Processes")).toBeNull();
  });

  it("lists the root's processes while a fork is shown", () => {
    const fork = fakeView({ conversation: forkConversation() });
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    renderPanel(FORK_ID, fork, fakeRemote(fork, {}, processes));
    expect(processes.watch).toHaveBeenCalledWith(PARSER_ID, expect.any(Function));
    expect(screen.getByRole("list", { name: "Processes" })).toBeInTheDocument();
    expect(screen.getByText("dev server")).toBeInTheDocument();
    expect(screen.getByText(/1 process running/)).toBeInTheDocument();
  });

  it("opens a running process, stops it, and hides Stop once it ended", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    renderPanel(PARSER_ID, panelView, fakeRemote(panelView, {}, processes));
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();
    expect(screen.getByText("bun run dev")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByTestId("process-output")).toHaveTextContent("p-dev");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(processes.stop).toHaveBeenCalledWith(PARSER_ID, "p-dev"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(await screen.findByText("Stopped by the user")).toBeInTheDocument();
  });

  it("offers no Stop for an ended process", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    renderPanel(PARSER_ID, panelView, fakeRemote(panelView, {}, processes));
    fireEvent.click(await screen.findByRole("button", { name: /bun test --watch/ }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText("Exited with code 1")).toBeInTheDocument();
  });

  it("shows no Stop and the reason when the host has no process module", async () => {
    const panelView = fakeView();
    const reason = "The host couldn't load its process module; its log says which package is missing";
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES }, unavailable: reason });
    renderPanel(PARSER_ID, panelView, fakeRemote(panelView, {}, processes));
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("shows a lost process's pid and no output", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    renderPanel(PARSER_ID, panelView, fakeRemote(panelView, {}, processes));
    fireEvent.click(await screen.findByRole("button", { name: /sleep 300/ }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText("Lost track after a host restart; it may still be running (pid 777)")).toBeInTheDocument();
    expect(screen.getByText("The host restarted, so this process's output is no longer available.")).toBeInTheDocument();
  });

  it("shows released output as an empty state, not an error", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: [{ ...PROCESSES[0]!, id: "p-released" }] } });
    renderPanel(PARSER_ID, panelView, fakeRemote(panelView, {}, processes));
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(await screen.findByText("The output of this process is no longer available")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets a newly opened subagent detail replace a process detail", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    const remote = fakeRemote(panelView, {}, processes);
    const { rerender } = renderPanel(PARSER_ID, panelView, remote);
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(screen.getByText("bun run dev")).toBeInTheDocument();

    const withSide = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });
    rerender(panel(PARSER_ID, withSide, remote));
    expect(await screen.findByText("Write regression tests")).toBeInTheDocument();
    expect(screen.queryByText("bun run dev")).toBeNull();

    // Leaving the subagent returns to Tasks, not to the process detail that
    // was open before the task navigation.
    rerender(panel(PARSER_ID, panelView, remote));
    expect(screen.queryByText("Background processes stop when the host restarts.")).toBeNull();
    expect(screen.getByText("dev server")).toBeInTheDocument();
  });

  it("closes another family's lingering side when a process is opened", async () => {
    // The side still names the parser family's subagent while this family's list shows.
    const panelView = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });
    const processes = fakeProcesses({ lists: { [DARK_MODE_ID]: PROCESSES } });
    const remote = fakeRemote(panelView, {}, processes);
    renderPanel(DARK_MODE_ID, panelView, remote);
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(remote.controller.showSide).toHaveBeenCalledWith(undefined);
  });

  it("closes the detail when the family changes", async () => {
    const panelView = fakeView();
    const processes = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
    const remote = fakeRemote(panelView, {}, processes);
    const { rerender } = renderPanel(PARSER_ID, panelView, remote);
    fireEvent.click(await screen.findByRole("button", { name: /dev server/ }));
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();

    rerender(panel(DARK_MODE_ID, panelView, remote));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to tasks" })).toBeNull());
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });
});

describe("SidePanel Changes", () => {
  it("refetches when main shows another conversation of the same family", async () => {
    // A pre-ADR-0019 fork may own its worktree; the host answers per conversation.
    const changes = vi.fn(async () => ({ available: true as const, base: "c0ffee0", patch: "", truncated: false }));
    const parser = fakeView();
    const remote = fakeRemote(parser, { changes });
    const panel = (view: typeof parser, shownId: typeof PARSER_ID) => (
      <SidePanel
        view={view}
        remote={remote}
        shownId={shownId}
        narrow={false}
        open
        surface="changes"
        busy={false}
        liveActivity={false}
        onOpenChange={vi.fn()}
        onSelectSurface={vi.fn()}
        openInPanel={vi.fn()}
        onOpenInMain={vi.fn()}
      />
    );
    const { rerender } = render(panel(parser, PARSER_ID));
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    rerender(panel(fakeView({ conversation: forkConversation() }), FORK_ID));
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
  });

  it("shows nothing of the last conversation while the next one is still opening", async () => {
    const changes = vi.fn(async () => ({ available: true as const, base: "c0ffee0", patch: "--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-a\n+b", truncated: false }));
    const parser = fakeView();
    const remote = fakeRemote(parser, { changes });
    // Main already shows another conversation; its snapshot has not landed.
    render(
      <SidePanel
        view={parser}
        remote={remote}
        shownId={DARK_MODE_ID}
        narrow={false}
        open
        surface="changes"
        busy={false}
        liveActivity={false}
        onOpenChange={vi.fn()}
        onSelectSurface={vi.fn()}
        openInPanel={vi.fn()}
        onOpenInMain={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh changes" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).not.toHaveBeenCalled();
    expect(screen.queryByText("src/parser.ts")).toBeNull();
  });
});

describe("SidePanel close", () => {
  it.each(["tasks", "changes", "terminal"] as const)("closes the docked panel from its %s header", (surface) => {
    const onOpenChange = vi.fn();
    render(
      <SidePanel
        view={view}
        remote={fakeRemote(view)}
        shownId={PARSER_ID}
        narrow={false}
        open
        surface={surface}
        busy={false}
        liveActivity={false}
        onOpenChange={onOpenChange}
        onSelectSurface={vi.fn()}
        openInPanel={vi.fn()}
        onOpenInMain={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
