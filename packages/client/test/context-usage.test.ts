import { describe, expect, it } from "vitest";
import { contextUsage } from "../src/context-usage.ts";
import { CONTEXT_USAGE_CASES } from "./context-usage-cases.ts";

const named = (name: string) => CONTEXT_USAGE_CASES.find((c) => c.name === name)!;

describe("contextUsage", () => {
  it("reads the newest assistant usage against the model's window", () => {
    const c = named("latest-wins");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 84000, window: 200000 });
  });

  it("skips aborted, failed, and zero-usage replies for the last real one", () => {
    const c = named("skips-aborted-error-zero");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 12200, window: 200000 });
  });

  it("is unknown until a reply lands after the last compaction or reset", () => {
    for (const name of ["empty", "no-assistant", "compaction-tail", "reset-tail"]) {
      const c = named(name);
      expect(contextUsage(c.view, c.contextWindow), name).toBeUndefined();
    }
  });

  it("replies after a compaction restart the count", () => {
    const c = named("reply-after-compaction");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 12000, window: 200000 });
  });

  it("sums the four components when totalTokens is falsy", () => {
    const c = named("components-sum");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 84000, window: 200000 });
  });

  it("keeps searching when the newest reply carries no usage", () => {
    const c = named("usage-missing");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 8000, window: 200000 });
  });

  it("is unknown without a positive context window", () => {
    for (const name of ["no-window", "zero-window"]) {
      const c = named(name);
      expect(contextUsage(c.view, c.contextWindow), name).toBeUndefined();
    }
  });

  it("reports usage over the window verbatim after a model swap", () => {
    const c = named("overflow");
    expect(contextUsage(c.view, c.contextWindow)).toEqual({ used: 250000, window: 200000 });
  });
});
