// `pinomad upgrade` validates its flags before touching npm/git (issue #164).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isParseArgsError } from "../src/cli/args.ts";
import { main, npmBeside } from "../src/cli/upgrade.ts";

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

describe("npmBeside", () => {
  it("runs the npm that ships with the running node, the only npm an install-script runtime has", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "pinomad-runtime-"));
    try {
      const node = join(runtime, "node", "bin", "node");
      const cli = join(runtime, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
      await mkdir(join(runtime, "node", "bin"), { recursive: true });
      await mkdir(join(cli, ".."), { recursive: true });
      await writeFile(node, "");
      await writeFile(cli, "");
      // npm's lifecycle scripts call `node` by name, so its bin dir goes first on PATH.
      expect(npmBeside(node)).toEqual({ command: node, args: [cli], binDir: join(runtime, "node", "bin") });
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });

  it("falls back to npm on PATH when the running node has none beside it", () => {
    expect(npmBeside("/nowhere/bin/node")).toEqual({ command: "npm", args: [] });
  });
});
