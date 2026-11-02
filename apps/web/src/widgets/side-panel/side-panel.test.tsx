// The side panel belongs to the family the main column shows. It lists only
// Foreground Tasks; Forks are independent conversations in the sidebar now.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DARK_MODE_ID, fakeRemote, fakeView, PARSER_ID, SUBAGENT_ID, subagentConversation } from "../../test/story-fixtures.tsx";
import { SidePanel } from "./side-panel.tsx";

const view = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });

function renderPanel(shownId: typeof PARSER_ID) {
  render(
    <SidePanel
      view={view}
      remote={fakeRemote(view)}
      shownId={shownId}
      narrow={false}
      open
      onOpenChange={vi.fn()}
      openInPanel={vi.fn()}
      onOpenInMain={vi.fn()}
    />,
  );
}

describe("SidePanel family", () => {
  it("keeps a task of the shown family open, with no Threads shell", () => {
    renderPanel(PARSER_ID);
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Threads/ })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("hides a task of another family the moment that family is shown", () => {
    renderPanel(DARK_MODE_ID);
    expect(screen.queryByRole("button", { name: "Back to tasks" })).not.toBeInTheDocument();
    // The other family has no tasks; the panel says so rather than showing a fork list.
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });
});
