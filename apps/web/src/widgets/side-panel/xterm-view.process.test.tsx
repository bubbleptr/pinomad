// A background process's host pty is fixed at 120×40 (ADR-0045 §3), so the
// read-only screen keeps that logical grid instead of fitting the panel. A
// terminal keeps fitting: its host follows the screen's size.
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProcesses } from "../../test/story-fixtures.tsx";
import XtermView from "./xterm-view.tsx";

type MockScreen = {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
};

const mocked = vi.hoisted(() => ({
  screens: [] as MockScreen[],
  fits: [] as unknown[],
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocked.screens.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }
    onData(): { dispose(): void } {
      return { dispose() {} };
    }
    write(): void {}
    dispose(): void {}
    focus(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    constructor() {
      mocked.fits.push(this);
    }
    fit(): void {}
  },
}));

describe("XtermView process mode", () => {
  beforeEach(() => {
    mocked.screens.length = 0;
    mocked.fits.length = 0;
  });

  it("keeps the host's 120×40 grid and never fits", () => {
    const processes = fakeProcesses();
    render(<XtermView processes={processes} processId="p-dev" />);

    expect(mocked.screens).toHaveLength(1);
    expect(mocked.screens[0]).toMatchObject({ cols: 120, rows: 40 });
    expect(mocked.fits).toHaveLength(0);
    expect(processes.attach).toHaveBeenCalledWith("p-dev", undefined, expect.any(Object));
  });
});
