// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatComposerDrawer.test.tsx (MIT).

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatComposerDrawer } from "./chat-composer-drawer";

describe("ChatComposerDrawer", () => {
  it("links the toggle to the drawer content via aria-controls", () => {
    render(
      <ChatComposerDrawer count={2} label="Attachments">
        <span>Drawer content</span>
      </ChatComposerDrawer>,
    );

    const toggle = screen.getByRole("button", {name: /Attachments/});
    const controlsId = toggle.getAttribute("aria-controls");
    // aria-controls must be present and point at the real content region.
    expect(controlsId).toBeTruthy();
    const region = document.getElementById(controlsId as string);
    expect(region).not.toBeNull();
    expect(region).toContainElement(screen.getByText("Drawer content"));
  });

  it("keeps aria-controls resolvable while collapsed (content stays mounted)", () => {
    render(
      <ChatComposerDrawer count={2} label="Attachments" defaultIsCollapsed>
        <span>Drawer content</span>
      </ChatComposerDrawer>,
    );

    const toggle = screen.getByRole("button", {name: /Attachments/});
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    const region = document.getElementById(controlsId as string);
    expect(region).not.toBeNull();
    expect(region).toContainElement(screen.getByText("Drawer content"));
  });

  it("takes collapsed content out of focus and the accessibility tree", () => {
    render(
      <ChatComposerDrawer count={1} label="Attachments">
        <button type="button">Remove</button>
      </ChatComposerDrawer>,
    );

    const toggle = screen.getByRole("button", {name: /Attachments/});
    const region = document.getElementById(toggle.getAttribute("aria-controls") as string);
    expect(region).not.toHaveAttribute("inert");

    fireEvent.click(toggle);
    expect(region).toHaveAttribute("inert");
  });

  it("toggles aria-expanded when the toggle is activated", () => {
    render(
      <ChatComposerDrawer count={2} label="Attachments">
        <span>Drawer content</span>
      </ChatComposerDrawer>,
    );

    const toggle = screen.getByRole("button", {name: /Attachments/});
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", {name: /Attachments/})).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", {name: /Attachments/}));
    expect(screen.getByRole("button", {name: /Attachments/})).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
