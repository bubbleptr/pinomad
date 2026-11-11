// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatSystemMessage.test.tsx (MIT).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatSystemMessage } from "./chat-system-message";

describe("ChatSystemMessage", () => {
  it("renders children", () => {
    render(<ChatSystemMessage>Conversation started</ChatSystemMessage>);
    expect(screen.getByText("Conversation started")).toBeTruthy();
  });

  it("renders default variant without divider lines", () => {
    const {container} = render(<ChatSystemMessage>Hello</ChatSystemMessage>);
    // Divider lines have aria-hidden, so check there are none
    const hiddenElements = container.querySelectorAll("[aria-hidden]");
    expect(hiddenElements.length).toBe(0);
  });

  it("exposes the divider variant label as the separator accessible name", () => {
    render(<ChatSystemMessage variant="divider">Today</ChatSystemMessage>);
    expect(screen.getByRole("separator")).toHaveAccessibleName("Today");
  });

  it("renders icon", () => {
    render(
      <ChatSystemMessage icon={<span data-testid="icon">*</span>}>
        Notice
      </ChatSystemMessage>,
    );
    expect(screen.getByTestId("icon")).toBeTruthy();
  });

  it("reflects the variant", () => {
    render(
      <ChatSystemMessage variant="divider" data-testid="sys">
        Today
      </ChatSystemMessage>,
    );
    const el = screen.getByTestId("sys");
    expect(el).toHaveAttribute("data-variant", "divider");
  });

  it("forwards rest props (data-*, id) while keeping its own role", () => {
    render(
      <ChatSystemMessage data-testid="sys" data-custom="x" id="sys-1">
        Hello
      </ChatSystemMessage>,
    );
    const el = screen.getByTestId("sys");
    expect(el).toHaveAttribute("data-custom", "x");
    expect(el).toHaveAttribute("id", "sys-1");
    expect(el.getAttribute("role")).toBe("status");
  });

  it("forwards rest props in the divider variant", () => {
    render(
      <ChatSystemMessage variant="divider" data-testid="sys" data-custom="x">
        Today
      </ChatSystemMessage>,
    );
    const el = screen.getByTestId("sys");
    expect(el).toHaveAttribute("data-custom", "x");
    expect(el.getAttribute("role")).toBe("status");
  });
});
