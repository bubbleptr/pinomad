// restartService's post-restart poll: a host answering with a newer protocol
// major is the upgrade landing (issue #164), not a failure to answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolMismatchError, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { restartService } from "../src/cli/service.ts";
import type { ServiceManager } from "../src/service/manager.ts";

const manager = (): ServiceManager => ({
  install: async () => "/fake/pinomad.service",
  uninstall: async () => {},
  restart: async () => {},
  state: async () => ({ installed: true, running: true, detail: "running" }),
  logs: async () => {},
  read: async () => undefined,
});

const ARGS = ["--url", "ws://127.0.0.1:1", "--token", "token"];
const reachable = { close: () => {} } as unknown as RemoteDurable;

afterEach(() => vi.restoreAllMocks());

describe("restartService", () => {
  it("treats a host answering with a newer protocol major as restarted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restart = vi.fn(async () => {});
    const code = await restartService({
      force: true,
      argv: ARGS,
      manager: manager(),
      restart,
      connect: async () => {
        throw new ProtocolMismatchError(6, 5, "0.6.0");
      },
    });
    expect(code).toBe(0);
    expect(restart).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("newer than this upgrader"));
  });

  it("keeps reporting failure when the answering host is older", async () => {
    const code = await restartService({
      force: true,
      argv: ARGS,
      manager: manager(),
      restart: vi.fn(async () => {}),
      connect: async () => {
        throw new ProtocolMismatchError(4, 5);
      },
      pollTimeoutMs: 30,
      pollDelayMs: 5,
    });
    expect(code).toBe(1);
  });

  it("polls until the restarted host answers", async () => {
    let calls = 0;
    const code = await restartService({
      force: true,
      argv: ARGS,
      manager: manager(),
      restart: vi.fn(async () => {}),
      connect: async () => (++calls === 1 ? Promise.reject(new Error("refused")) : Promise.resolve(reachable)),
      pollDelayMs: 1,
    });
    expect(code).toBe(0);
    expect(calls).toBe(2);
  });
});
