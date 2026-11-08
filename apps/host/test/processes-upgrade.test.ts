// An idle upgrade waits for background processes (ADR-0045 §5): they are part
// of the upgrader's busy signal, and stopping one lets the install proceed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { ProcessDoc } from "../src/process-doc.ts";
import { connectTo, startChat, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("idle upgrades and background processes", () => {
  it("stays waiting while a process runs, then installs after it stops", async () => {
    const installs: string[] = [];
    let opened: Awaited<ReturnType<typeof startFauxHost>> | undefined;
    opened = await startFauxHost(defer, {
      answers: ["ok"],
      processes: {
        shell: { file: "/bin/sh", args: [] },
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      },
      upgrade: {
        current: "0.13.0",
        restart: () => void opened?.close(),
        blocked: async () => null,
        latest: async () => ({ version: "0.14.0", publishedAt: 0, protocolMajor: 5 }),
        install: async (version) => {
          installs.push(version);
          return { ok: true };
        },
        every: () => () => {},
      },
    });
    const remote = await connectTo(defer, opened);
    const conversationId = await startChat(remote, "hi");
    const started = await opened.processes!.start(
      { conversationId, command: "sleep 30", name: "monitor", cwd: process.cwd() },
      BACKGROUND_CONTEXT,
    );

    await remote.controller.startUpgrade("idle");
    await until(() => remote.view.current().upgrade?.phase === "waiting");
    expect(installs).toEqual([]);

    await opened.processes!.stop({ conversationId, id: started.id, reason: "user" }, BACKGROUND_CONTEXT);
    await until(() => installs.length === 1);
    expect(installs).toEqual(["0.14.0"]);
  });

  it("stops running processes before an immediate install", async () => {
    let stoppedAtInstall: string | undefined;
    let opened: Awaited<ReturnType<typeof startFauxHost>> | undefined;
    opened = await startFauxHost(defer, {
      answers: ["ok"],
      processes: {
        shell: { file: "/bin/sh", args: [] },
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      },
      upgrade: {
        current: "0.13.0",
        restart: () => void opened?.close(),
        blocked: async () => null,
        latest: async () => ({ version: "0.14.0", publishedAt: 0, protocolMajor: 5 }),
        install: async () => {
          const doc = await opened!.harness.snapshot(ProcessDoc, conversationId, BACKGROUND_CONTEXT);
          stoppedAtInstall = JSON.stringify(doc?.processes[0]?.state);
          return { ok: true };
        },
        every: () => () => {},
      },
    });
    const remote = await connectTo(defer, opened);
    const conversationId = await startChat(remote, "hi");
    await opened.processes!.start(
      { conversationId, command: "sleep 30", name: "monitor", cwd: process.cwd() },
      BACKGROUND_CONTEXT,
    );
    await remote.controller.startUpgrade("now");
    await until(() => stoppedAtInstall !== undefined);
    expect(stoppedAtInstall).toContain("shutdown");
  });
});
