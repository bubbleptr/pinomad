import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextBar, ContextFigures } from "./context-meter.tsx";

const BREAKDOWN = { used: 84_000, system: 6_000, skills: 2_000, tools: 9_000, mcp: 0, messages: 67_000 };

describe("ContextFigures", () => {
  it("shows the share and the used/window counts", () => {
    render(<ContextFigures usage={{ used: 84_000, window: 200_000 }} />);
    expect(screen.getByText("42% · 84k / 200k")).toHaveClass("text-muted");
  });

  it("turns warning at four fifths of the window", () => {
    render(<ContextFigures usage={{ used: 160_000, window: 200_000 }} />);
    expect(screen.getByText("80% · 160k / 200k")).toHaveClass("text-warning");
  });

  it("reports an over-window share verbatim after a model swap", () => {
    render(<ContextFigures usage={{ used: 250_000, window: 200_000 }} />);
    screen.getByText("125% · 250k / 200k");
  });

  it("formats millions compactly", () => {
    render(<ContextFigures usage={{ used: 1_234_000, window: 2_000_000 }} />);
    screen.getByText("62% · 1.2M / 2M");
  });

  it("reads “—” until a qualifying reply lands", () => {
    render(<ContextFigures usage={undefined} />);
    screen.getByText("—");
  });
});

describe("ContextBar", () => {
  it("is the meter for the whole window, with or without a breakdown", () => {
    const { rerender } = render(<ContextBar usage={{ used: 84_000, window: 200_000 }} breakdown={undefined} />);
    const meter = screen.getByRole("meter", { name: "Context 42% used, 84k of 200k tokens" });
    expect(meter).toHaveAttribute("aria-valuenow", "42");
    rerender(<ContextBar usage={{ used: 84_000, window: 200_000 }} breakdown={BREAKDOWN} />);
    expect(screen.getByRole("meter", { name: "Context 42% used, 84k of 200k tokens" })).toHaveAttribute("aria-valuenow", "42");
  });

  it("caps the meter's value at full after a model swap", () => {
    render(<ContextBar usage={{ used: 250_000, window: 200_000 }} breakdown={undefined} />);
    expect(screen.getByRole("meter", { name: "Context 125% used, 250k of 200k tokens" })).toHaveAttribute("aria-valuenow", "100");
  });

  it("names an unknown reading without claiming a value", () => {
    render(<ContextBar usage={undefined} breakdown={undefined} />);
    expect(screen.queryByRole("meter")).toBeNull();
    screen.getByLabelText("Context usage unknown");
  });
});
