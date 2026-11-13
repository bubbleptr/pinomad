import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeMachines,
  fakeView,
  FORK_ID,
  HOME_HOST,
  NESTED_FORK_ID,
  SECOND_FORK_ID,
  SUBAGENT_ID,
  withSummary,
} from "../../test/story-fixtures.tsx";
import * as stories from "./sidebar.stories.tsx";

const { Default, ForkRows, ForkSelected, LegacyNestedForks, SubagentShown } =
  composeStories(stories);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const row = (name: string) => screen.getByRole("button", { name }).closest<HTMLElement>(".pigui-sidenav-session-row");

describe("subagents in the sidebar (ADR-0047 §1)", () => {
  it("gives subagents no rows; the root stays selected while its subagent is shown", () => {
    render(<SubagentShown />);

    expect(screen.queryByRole("button", { name: "Inspect socket owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify retry on device" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Write regression tests" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).toHaveAttribute("aria-current", "page");
    // The fork is its own row and takes no selection from the root's subagent.
    expect(screen.getByRole("button", { name: "Try a recursive-descent rewrite" })).not.toHaveAttribute("aria-current", "page");
  });

  it("adds no row when a subagent turns background", () => {
    const before = fakeView();
    const { rerender } = render(<Default machines={fakeMachines({ home: before })} />);
    const rows = document.querySelectorAll(".pigui-sidenav-session-row").length;

    const after = withSummary(before, SUBAGENT_ID, { lifecycle: "background", name: "parser-tests" });
    rerender(<Default machines={fakeMachines({ home: after })} />);
    expect(document.querySelectorAll(".pigui-sidenav-session-row")).toHaveLength(rows);
    expect(screen.queryByRole("button", { name: "parser-tests" })).toBeNull();
  });
});

describe("fork rows", () => {
  it("opens the fork with its own hostKey and id", async () => {
    const user = userEvent.setup();
    render(<ForkRows />);

    await user.click(screen.getByRole("button", { name: "Try a recursive-descent rewrite" }));
    expect(ForkRows.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, FORK_ID);
  });

  it("selects only the fork or only its root", () => {
    const { unmount } = render(<ForkSelected />);
    expect(screen.getByRole("button", { name: "Try a recursive-descent rewrite" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    unmount();

    render(<ForkRows />);
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Try a recursive-descent rewrite" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("offers Rename but not Archive on a fork", async () => {
    const user = userEvent.setup();
    render(<ForkRows />);
    const forkRow = row("Try a recursive-descent rewrite")!;

    await user.click(within(forkRow).getByRole("button", { name: "Conversation actions" }));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();

    // The root keeps both actions.
    const rootRow = row("Fix the parser's trailing-comma bug")!;
    await user.click(within(rootRow).getByRole("button", { name: "Conversation actions" }));
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
  });

  it("keeps legacy nested and multiple forks navigable in stable order", async () => {
    const user = userEvent.setup();
    render(<LegacyNestedForks />);

    const project = screen.getByRole("group", { name: "pinomad" });
    const rows = [...project.querySelectorAll<HTMLElement>('[data-kind="fork"]')];
    const order = ["Try a recursive-descent rewrite", "Revisit the frame cost", "Compare a table-driven parser"];
    expect(rows).toHaveLength(order.length);
    order.forEach((name, index) => expect(rows[index]!.textContent).toContain(name));

    await user.click(screen.getByRole("button", { name: "Revisit the frame cost" }));
    expect(LegacyNestedForks.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, NESTED_FORK_ID);
    await user.click(screen.getByRole("button", { name: "Compare a table-driven parser" }));
    expect(LegacyNestedForks.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, SECOND_FORK_ID);
  });
});

describe("family status in the sidebar", () => {
  it("tags a family waiting for an answer, and keeps the row's name to its title", () => {
    render(<Default machines={fakeMachines({ home: withSummary(fakeView(), SUBAGENT_ID, { status: "needs-answer" }) })} />);

    const waiting = row("Fix the parser's trailing-comma bug")!;
    expect(waiting).toHaveAttribute("data-status", "needs-answer");
    expect(within(waiting).getByText("Needs answer")).toBeVisible();
    // The tag says it; no amber dot competes with it.
    expect(waiting.querySelector('[data-slot="status-dot"]')).toBeNull();

    const failed = row("Draft the 0.9 release notes")!;
    expect(within(failed).queryByText("Needs answer")).toBeNull();
    expect(failed.querySelector('[data-slot="status-dot"]')).not.toBeNull();
  });
});
