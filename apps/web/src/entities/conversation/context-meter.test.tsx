import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ContextMeter } from "./context-meter.tsx";

describe("ContextMeter", () => {
  it("shows the fill percent and the used/window tooltip", async () => {
    const user = userEvent.setup();
    render(<ContextMeter usage={{ used: 84000, window: 200000 }} />);
    const meter = screen.getByRole("meter", { name: "Context 42% used, 84k of 200k tokens" });
    expect(meter).toHaveTextContent("42%");
    await user.hover(meter);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("84k / 200k");
  });

  it("turns warning at four fifths of the window", () => {
    render(<ContextMeter usage={{ used: 160000, window: 200000 }} />);
    expect(screen.getByRole("meter")).toHaveClass("text-warning");
  });

  it("reports an over-window fill verbatim after a model swap", () => {
    render(<ContextMeter usage={{ used: 250000, window: 200000 }} />);
    expect(screen.getByRole("meter", { name: "Context 125% used, 250k of 200k tokens" })).toHaveTextContent("125%");
  });

  it("reads “—” until a qualifying reply lands", async () => {
    const user = userEvent.setup();
    render(<ContextMeter usage={undefined} />);
    const meter = screen.getByLabelText("Context usage unknown");
    expect(meter).toHaveTextContent("—");
    await user.hover(meter);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("No usage data yet");
  });

  it("adds the conversation's spend to the tooltip", async () => {
    const user = userEvent.setup();
    render(<ContextMeter usage={{ used: 84000, window: 200000 }} cost={0.4213} />);
    await user.hover(screen.getByRole("meter"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("84k / 200k · $0.42");
  });

  it("formats millions compactly", () => {
    render(<ContextMeter usage={{ used: 1_234_000, window: 2_000_000 }} />);
    screen.getByRole("meter", { name: "Context 62% used, 1.2M of 2M tokens" });
  });
});
