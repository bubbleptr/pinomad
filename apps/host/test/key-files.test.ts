// Key files must appear complete or not at all: a concurrent first caller
// (`pinomad join` beside a starting host) may read the file the moment it
// exists. The mock widens the gap between creating a `wx` file and filling it,
// which a real disk only sometimes shows (CI hit it once).
import { readdir, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { loadHostKey, loadRelayKey } from "../src/devices.ts";
import { tempDir, useCleanups } from "./support.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof real.writeFile = async (path, data, options) => {
    const opts = typeof options === "object" && options !== null ? options : undefined;
    if (opts?.flag !== "wx") return real.writeFile(path, data, options);
    const handle = await real.open(path as string, "wx", opts.mode);
    try {
      await sleep(50);
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  };
  return { ...real, writeFile, default: { ...real, writeFile } };
});

const defer = useCleanups();

describe("key files under a slow first write", () => {
  it("loadHostKey gives concurrent first callers the same complete key", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const [a, b] = await Promise.all([loadHostKey(dir.path), loadHostKey(dir.path)]);
    expect(toBase64Url(b.privateKey)).toBe(toBase64Url(a.privateKey));
    expect(toBase64Url((await loadHostKey(dir.path)).privateKey)).toBe(toBase64Url(a.privateKey));
    expect((await stat(join(dir.path, "host-key"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir.path)).toEqual(["host-key"]);
  });

  it("loadRelayKey gives concurrent first callers the same complete key", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const [a, b] = await Promise.all([loadRelayKey(dir.path), loadRelayKey(dir.path)]);
    expect(toBase64Url(b.secretKey)).toBe(toBase64Url(a.secretKey));
    expect(toBase64Url((await loadRelayKey(dir.path)).secretKey)).toBe(toBase64Url(a.secretKey));
    expect((await stat(join(dir.path, "relay-key"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir.path)).toEqual(["relay-key"]);
  });
});
