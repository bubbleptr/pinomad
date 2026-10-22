import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_LOG_MAX_BYTES, rotateHostLog } from "../src/service/log-rotation.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

async function dataDirWithLogs(): Promise<{ dataDir: string; logs: string; log: string }> {
  const data = await tempDir();
  defer(data.remove);
  const logs = join(data.path, "logs");
  await mkdir(logs, { recursive: true });
  return { dataDir: data.path, logs, log: join(logs, "host.log") };
}

describe("host log rotation", () => {
  it("leaves a log at the size limit untouched", async () => {
    const { dataDir, logs, log } = await dataDirWithLogs();
    await writeFile(log, Buffer.alloc(HOST_LOG_MAX_BYTES, 0x61));

    await expect(rotateHostLog(dataDir)).resolves.toBe(false);

    expect((await stat(log)).size).toBe(HOST_LOG_MAX_BYTES);
    expect(await readdir(logs)).toEqual(["host.log"]);
  });

  it("copies an oversized log to .1, truncates it, and shifts history", async () => {
    const { dataDir, logs, log } = await dataDirWithLogs();
    const content = Buffer.alloc(HOST_LOG_MAX_BYTES + 1, 0x62);
    await writeFile(log, content);
    await writeFile(join(logs, "host.log.1"), "one");
    await writeFile(join(logs, "host.log.2"), "two");
    await writeFile(join(logs, "host.log.3"), "three");

    await expect(rotateHostLog(dataDir)).resolves.toBe(true);

    expect(await readFile(log)).toHaveLength(0);
    expect((await readFile(join(logs, "host.log.1"))).equals(content)).toBe(true);
    expect(await readFile(join(logs, "host.log.2"), "utf8")).toBe("one");
    expect(await readFile(join(logs, "host.log.3"), "utf8")).toBe("two");
    expect(await readdir(logs)).toEqual(["host.log", "host.log.1", "host.log.2", "host.log.3"]);
  });

  it("keeps history and the current log when the copy fails", async () => {
    const { dataDir, logs, log } = await dataDirWithLogs();
    const content = Buffer.alloc(HOST_LOG_MAX_BYTES + 1, 0x64);
    await writeFile(log, content);
    await writeFile(join(logs, "host.log.1"), "one");
    await writeFile(join(logs, "host.log.2"), "two");
    await writeFile(join(logs, "host.log.3"), "three");

    await expect(
      rotateHostLog(dataDir, async (_source, destination) => {
        await writeFile(destination, "partial");
        throw new Error("copy failed");
      }),
    ).rejects.toThrow("copy failed");

    expect((await readFile(log)).equals(content)).toBe(true);
    expect(await readFile(join(logs, "host.log.1"), "utf8")).toBe("one");
    expect(await readFile(join(logs, "host.log.2"), "utf8")).toBe("two");
    expect(await readFile(join(logs, "host.log.3"), "utf8")).toBe("three");
    expect(await readdir(logs)).toEqual(["host.log", "host.log.1", "host.log.2", "host.log.3"]);
  });

  it("discards a stale temporary copy before rotating", async () => {
    const { dataDir, logs, log } = await dataDirWithLogs();
    const content = Buffer.alloc(HOST_LOG_MAX_BYTES + 1, 0x65);
    await writeFile(log, content);
    await writeFile(join(logs, "host.log.rotating"), "stale");

    await expect(rotateHostLog(dataDir)).resolves.toBe(true);

    expect((await readFile(join(logs, "host.log.1"))).equals(content)).toBe(true);
    expect(await readdir(logs)).toEqual(["host.log", "host.log.1"]);
  });

  it("does nothing when the log file is missing", async () => {
    const data = await tempDir();
    defer(data.remove);

    await expect(rotateHostLog(data.path)).resolves.toBe(false);

    await expect(stat(join(data.path, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes at offset 0 through an O_APPEND fd after truncation", async () => {
    const { dataDir, log } = await dataDirWithLogs();
    await writeFile(log, Buffer.alloc(HOST_LOG_MAX_BYTES + 1, 0x63));
    // launchd keeps its stdout/stderr file opened with O_APPEND for the host's
    // whole lifetime; "a" is the same flag combination.
    const fd = openSync(log, "a");
    try {
      await expect(rotateHostLog(dataDir)).resolves.toBe(true);
      writeSync(fd, "after-rotation\n");
    } finally {
      closeSync(fd);
    }

    expect(await readFile(log, "utf8")).toBe("after-rotation\n");
  });
});
