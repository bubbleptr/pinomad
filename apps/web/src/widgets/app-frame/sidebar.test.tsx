import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_SUBAGENT_ID,
  fakeMachines,
  fakeView,
  FORK_ID,
  HOME_HOST,
  NESTED_FORK_ID,
  PARSER_ID,
  SECOND_FORK_ID,
  SUBAGENT_ID,
  withSummary,
} from "../../test/story-fixtures.tsx";
import * as stories from "./sidebar.stories.tsx";

const { BackgroundSubagents, BackgroundSubagentsCollapsed, Default, ForkRows, ForkSelected, LegacyNestedForks } =
  composeStories(stories);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const row = (name: string) => screen.getByRole("button", { name }).closest<HTMLElement>(".pigui-sidenav-session-row");

describe("background subagent sidebar", () => {
  it("shows both background parents, but not the foreground task or a second selection", () => {
    render(<BackgroundSubagents />);

    expect(screen.getByRole("button", { name: "Inspect socket owner" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Verify retry on device" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "Write regression tests" })).toBeNull();
    expect(document.querySelectorAll(".pigui-background-tree-child .model-logo")).toHaveLength(2);
  });

  it("keeps disclosure independent from opening and counts only visible background rows", async () => {
    const user = userEvent.setup();
    render(<BackgroundSubagentsCollapsed />);

    const group = document.querySelector(".pigui-background-tree-children")?.closest("[role=group]");
    expect(group).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".pigui-sidenav-subagent-count")).toHaveTextContent("2");

    await user.click(screen.getByRole("button", { name: "Expand Fix the parser's trailing-comma bug" }));
    expect(group).toHaveAttribute("aria-hidden", "false");
    expect(BackgroundSubagentsCollapsed.args.onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Inspect socket owner" }));
    expect(BackgroundSubagentsCollapsed.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, BACKGROUND_SUBAGENT_ID);

    await user.click(screen.getByRole("button", { name: "Fix the parser's trailing-comma bug" }));
    expect(BackgroundSubagentsCollapsed.args.onOpen).toHaveBeenCalledWith(HOME_HOST.hostKey, PARSER_ID);
  });

  it("does not repeat a fork's background child under its own row", () => {
    render(<BackgroundSubagents />);

    // Both background rows belong to the root's Background projection.
    expect(document.querySelectorAll('[data-kind="root"] .pigui-background-tree-child')).toHaveLength(2);
    expect(document.querySelectorAll('[data-kind="fork"] .pigui-background-tree-child')).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Try a recursive-descent rewrite" })).toBeInTheDocument();
  });
});

describe("a subagent that turns background", () => {
  it("appears under its root by name once its lifecycle changes", () => {
    const before = fakeView();
    const { rerender } = render(<Default machines={fakeMachines({ home: before })} />);
    expect(document.querySelector(".pigui-background-tree-child")).toBeNull();

    // ADR-0046 §6: the first message outside its call turns it background, once.
    const after = withSummary(before, SUBAGENT_ID, { lifecycle: "background", name: "parser-tests" });
    rerender(<Default machines={fakeMachines({ home: after })} />);
    const child = document.querySelector<HTMLElement>(".pigui-background-tree-child")!;
    expect(within(child).getByRole("button", { name: "parser-tests" })).toBeInTheDocument();
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
