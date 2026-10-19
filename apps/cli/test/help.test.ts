// `pinomad <command> --help` and bad flags are handled at the dispatcher
// (issue #200): subcommand parsers never declared `help`, so they used to
// die on ERR_PARSE_ARGS_UNKNOWN_OPTION with a full Node stack.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Spawns the packaged entry from source; resolves exit code + split output. */
function runPinomad(args: readonly string[]): {
  exited: Promise<number>;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(process.execPath, ["src/pinomad.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exited = once(child, "exit").then(([code]) => code ?? 1);
  return { exited, stdout: () => stdout, stderr: () => stderr };
}

describe("pinomad <command> --help", () => {
  it("prints the pair rows of the usage table and exits 0", async () => {
    const run = runPinomad(["pair", "--help"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("pair [--data-dir");
    expect(run.stdout()).toContain("pairing QR");
    expect(run.stderr()).toBe("");
  });

  it("accepts -h", async () => {
    const run = runPinomad(["pair", "-h"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("pair [--data-dir");
  });

  it("prints every row of a multi-line command (server + server passwd)", async () => {
    const run = runPinomad(["server", "--help"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("server --public-origin");
    expect(run.stdout()).toContain("server passwd");
  });

  it("intercepts --help for host without starting it", async () => {
    const run = runPinomad(["host", "--help"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("host --faux");
  });

  it("intercepts --help before upgrade would do real work", async () => {
    const run = runPinomad(["upgrade", "--help"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("upgrade [--force]");
  });

  it("covers a sub-command position (server passwd --help)", async () => {
    const run = runPinomad(["server", "passwd", "--help"]);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("server passwd");
  });
});

describe("pinomad <command> <bad args>", () => {
  const noStack = (stderr: string): void => {
    expect(stderr.split("\n").some((line) => /^\s*at\s/.test(line))).toBe(false);
    expect(stderr).not.toContain("ERR_PARSE_ARGS");
  };

  it("unknown option: two-line error, exit 2, no stack", async () => {
    const run = runPinomad(["pair", "--bogus"]);
    expect(await run.exited).toBe(2);
    expect(run.stderr()).toContain("pinomad pair: Unknown option '--bogus'");
    expect(run.stderr()).toContain('run "pinomad pair --help" for usage');
    noStack(run.stderr());
  });

  it("missing option value", async () => {
    const run = runPinomad(["pair", "--url"]);
    expect(await run.exited).toBe(2);
    expect(run.stderr()).toContain("pinomad pair:");
    noStack(run.stderr());
  });

  it("stray positional", async () => {
    const run = runPinomad(["leave", "extra"]);
    expect(await run.exited).toBe(2);
    noStack(run.stderr());
  });

  it("errors inside service's own dispatch still exit 2", async () => {
    const run = runPinomad(["service", "logs", "--bogus"]);
    expect(await run.exited).toBe(2);
    expect(run.stderr()).toContain("pinomad service:");
    expect(run.stderr()).toContain('run "pinomad service --help" for usage');
    noStack(run.stderr());
  });
});

describe("pinomad <unknown>", () => {
  it("keeps the unknown command behavior with a non-zero exit", async () => {
    const run = runPinomad(["start"]);
    expect(await run.exited).not.toBe(0);
    expect(run.stderr()).toContain("unknown command: start");
  });
});
