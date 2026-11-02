import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_SUBAGENT_ID, HOME_HOST, PARSER_ID } from "../../test/story-fixtures.tsx";
import * as stories from "./sidebar.stories.tsx";

const { BackgroundSubagents, BackgroundSubagentsCollapsed } = composeStories(stories);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

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
});
