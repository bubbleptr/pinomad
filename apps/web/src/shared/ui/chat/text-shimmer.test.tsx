import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";

describe("TextShimmer", () => {
  it("renders its text with the shimmer slot and class", () => {
    render(<TextShimmer>Pace</TextShimmer>);

    const shimmer = screen.getByText("Pace");

    expect(shimmer).toHaveAttribute("data-slot", "text-shimmer");
    expect(shimmer).toHaveClass("text-shimmer");
  });

  it("appends caller class names", () => {
    render(<TextShimmer className="custom">Loading</TextShimmer>);

    expect(screen.getByText("Loading")).toHaveClass("text-shimmer", "custom");
  });
});

describe("TextShimmer sweep", () => {
  type Sweep = { keyframes: Keyframe[]; duration: number };

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  function sweepAt(width: number): Sweep {
    const calls: Sweep[] = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        calls.push({ keyframes, duration: options.duration as number });
        return { cancel() {} };
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);

    const { unmount } = render(<TextShimmer style={{ fontSize: "14px" }}>Running bash…</TextShimmer>);
    unmount();

    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  /** Where the highlight starts and ends (px), and how long that takes (ms). */
  function travel({ keyframes, duration }: Sweep) {
    const x = (frame: Keyframe) => Number.parseFloat(String(frame.backgroundPosition));
    const end = keyframes.find((frame) => frame.offset !== undefined && frame.offset !== null)!;

    return { distance: x(end) - x(keyframes[0]!), sweepMs: (end.offset as number) * duration, restMs: duration * (1 - (end.offset as number)) };
  }

  // A fixed duration made a long row sweep several times faster than a short
  // one. The highlight moves at one speed whatever the text, and rests as long.
  it("sweeps a long row at the same speed as a short one and rests as long", () => {
    const short = travel(sweepAt(66));
    const long = travel(sweepAt(400));

    expect(long.distance).toBeGreaterThan(short.distance);
    expect(long.distance / long.sweepMs).toBeCloseTo(short.distance / short.sweepMs, 6);
    expect(long.restMs).toBeCloseTo(short.restMs, 6);
  });

  it("stays still when the reader asks for reduced motion", () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);

    render(<TextShimmer>Running bash…</TextShimmer>);

    expect(animate).not.toHaveBeenCalled();
  });
});
