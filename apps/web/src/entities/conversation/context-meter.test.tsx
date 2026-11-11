import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { allocateCells, ContextBar, ContextFigures, GRID_CELLS } from "./context-meter.tsx";

const BREAKDOWN = { used: 84_000, system: 6_000, skills: 2_000, tools: 9_000, mcp: 0, messages: 67_000 };

describe("ContextFigures", () => {
  it("shows the share and the used/window counts", () => {
    render(<ContextFigures usage={{ used: 84_000, window: 200_000 }} />);
    expect(screen.getByText("42% · 84k / 200k")).toHaveClass("text-muted-foreground");
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

describe("allocateCells", () => {
  const sum = (cells: readonly number[]) => cells.reduce((a, b) => a + b, 0);

  it("gives every part that takes space a cell, even on a huge window", () => {
    // 23k of a 1M window: each part is under a cell's worth on its own.
    const cells = allocateCells([12_000, 3_000, 4_000, 0, 5_000], { used: 24_000, window: 1_000_000 });
    expect(cells.map((count) => count > 0)).toEqual([true, true, true, false, true]);
    expect(cells[3]).toBe(0);
  });

  it("keeps a tiny reading visible but small", () => {
    const cells = allocateCells([1_500, 500], { used: 2_000, window: 1_000_000 });
    expect(cells).toEqual([1, 1]);
  });

  it("follows the window's scale and the parts' proportions", () => {
    const cells = allocateCells([21_000, 63_000], { used: 84_000, window: 200_000 });
    expect(sum(cells)).toBe(Math.round(GRID_CELLS * 0.42));
    expect(cells[1]).toBeGreaterThan(cells[0] * 2.5);
  });

  it("leaves a cell empty until the window is actually full", () => {
    expect(sum(allocateCells([199_500], { used: 199_500, window: 200_000 }))).toBe(GRID_CELLS - 1);
  });

  it("fills the grid exactly at or past the window", () => {
    expect(sum(allocateCells([200_000], { used: 200_000, window: 200_000 }))).toBe(GRID_CELLS);
    expect(sum(allocateCells([50_000, 200_000], { used: 250_000, window: 200_000 }))).toBe(GRID_CELLS);
  });
});
