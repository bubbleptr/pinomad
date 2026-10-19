// `pinomad upgrade` validates its flags before touching npm/git (issue #164).
import { describe, expect, it, vi } from "vitest";
import { isParseArgsError } from "../src/cli/args.ts";
import { main } from "../src/cli/upgrade.ts";

describe("upgrade", () => {
  it("rejects an unknown option before running any upgrade step", async () => {
    const run = vi.fn();
    const step = vi.fn(async () => 0);
    const serviceInstalled = vi.fn(async () => false);
    const restart = vi.fn(async () => 0);
    await expect(main(["--bogus"], { run, step, serviceInstalled, restart })).rejects.toSatisfy(isParseArgsError);
    expect(run).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(serviceInstalled).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("exits explicitly with the restart's exit code", async () => {
    const restart = vi.fn(async () => 5);
    const exit = vi.fn();
    await main([], {
      run: async () => ({ stdout: "" }),
      step: async () => 0,
      serviceInstalled: async () => true,
      restart,
      exit,
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(5);
  });
});
