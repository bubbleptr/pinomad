// jsdom: the resizable widths of the sidebar, Settings nav and side panel.
// Widths saved before the move off Astryx must still load, the keyboard must
// reach both bounds, and no step may leave them.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResizeHandle, useResizableWidth } from "./resize-handle.tsx";

function Pane({ reversed = false }: { reversed?: boolean }) {
  const width = useResizableWidth({ defaultSize: 260, min: 240, max: 320, autoSaveId: "test-pane" });
  return <ResizeHandle width={width} label="Resize pane" reversed={reversed} />;
}

const handle = () => screen.getByRole("separator", { name: "Resize pane" });
const press = (key: string, shiftKey = false) => fireEvent.keyDown(handle(), { key, shiftKey });

afterEach(() => localStorage.clear());

describe("ResizeHandle", () => {
  it("loads a width saved under the Astryx key and saves changes back to it", () => {
    localStorage.setItem("astryx-resizable:test-pane", "300");
    render(<Pane />);
    expect(handle()).toHaveAttribute("aria-valuenow", "300");
    press("ArrowLeft");
    expect(localStorage.getItem("astryx-resizable:test-pane")).toBe("290");
  });

  it("steps by 10, or 50 with Shift, and never past its bounds", () => {
    render(<Pane />);
    press("ArrowRight");
    expect(handle()).toHaveAttribute("aria-valuenow", "270");
    press("ArrowRight", true);
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    press("ArrowLeft", true);
    press("ArrowLeft", true);
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
    press("End");
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    press("Home");
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
  });

  it("clamps a saved width the bounds no longer allow", () => {
    localStorage.setItem("astryx-resizable:test-pane", "900");
    render(<Pane />);
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
  });

  it("grows toward the start edge when reversed, as the side panel does", () => {
    render(<Pane reversed />);
    press("ArrowLeft");
    expect(handle()).toHaveAttribute("aria-valuenow", "270");
  });
});
