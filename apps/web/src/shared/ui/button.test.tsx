// jsdom: the two props Button adds to shadcn's. Loading must not rename or
// resize the button (end-to-end tests find buttons by name), and a disabled
// button with a tooltip must stay reachable by keyboard to show it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.tsx";

describe("Button", () => {
  it("keeps its name while loading, and ignores clicks", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays focusable when disabled with a tooltip", async () => {
    const onClick = vi.fn();
    render(<Button disabled tooltip="Connect the host first" onClick={onClick}>Unpair</Button>);
    await userEvent.tab();
    const button = screen.getByRole("button", { name: "Unpair" });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });
});
