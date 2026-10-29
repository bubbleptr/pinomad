// The side panel belongs to the family the main column shows: while another
// family's conversation is still loading, the old family's fork must not stay
// open beside it (its composer would send into a conversation no longer shown).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DARK_MODE_ID, fakeRemote, fakeView, FORK_ID, forkConversation, PARSER_ID } from "../../test/story-fixtures.tsx";
import { SidePanel } from "./side-panel.tsx";

const view = fakeView({ side: { id: FORK_ID, conversation: forkConversation(), docs: [] } });

function renderPanel(shownId: typeof PARSER_ID) {
  render(
    <SidePanel
      view={view}
      remote={fakeRemote(view)}
      shownId={shownId}
      narrow={false}
      open
      onOpenChange={vi.fn()}
      tab="threads"
      onTabChange={vi.fn()}
      openInPanel={vi.fn()}
      onOpenInMain={vi.fn()}
    />,
  );
}

describe("SidePanel family", () => {
  it("keeps a fork of the shown family open", () => {
    renderPanel(PARSER_ID);
    expect(screen.getByRole("button", { name: "Open in main" })).toBeInTheDocument();
  });

  it("hides a fork of another family the moment that family is shown", () => {
    renderPanel(DARK_MODE_ID);
    expect(screen.queryByRole("button", { name: "Open in main" })).not.toBeInTheDocument();
  });
});
