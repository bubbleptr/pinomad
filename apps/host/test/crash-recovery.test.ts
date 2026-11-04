import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, streamingText, transcript } from "@pinomad/protocol/transcript.ts";
import { freePort, LONG_ANSWER, stopChild, tempDir, useCleanups, waitForView } from "./support.ts";

const hostDir = fileURLToPath(new URL("..", import.meta.url));
const defer = useCleanups();

interface HostProcess {
  readonly child: ChildProcess;
  readonly url: string;
  readonly token: string;
}

async function spawnHost(dataDir: string, port: number, model: readonly string[] = ["--faux", LONG_ANSWER, "--faux-tps", "40"]): Promise<HostProcess> {
  const child = spawn(
    process.execPath,
    ["src/main.ts", "--data-dir", dataDir, "--port", String(port), ...model, "--lock-stale-ms", "2000"],
    { cwd: hostDir, stdio: ["ignore", "pipe", "inherit"] },
  );
  defer(() => stopChild(child));
  const lines = createInterface({ input: child.stdout! });
  for await (const line of lines) {
    const event = JSON.parse(line) as { event: string; url: string; tokenFile: string };
    if (event.event === "ready") return { child, url: event.url, token: (await readFile(event.tokenFile, "utf8")).trim() };
  }
  throw new Error("host exited before it was ready");
}

it("resumes both clients after the host is killed mid-stream and restarted", async () => {
  const dir = await tempDir();
  defer(dir.remove);
  const port = await freePort();
  // Slow enough (~40 characters a second) to kill well past the first store.
  const first = await spawnHost(dir.path, port, ["--faux", LONG_ANSWER, "--faux-tps", "10"]);

  const connect = async (): Promise<RemoteDurable> => {
    const client = await connectRemoteDurable({ url: first.url, token: first.token, reconnectDelayMs: { min: 100, max: 500 } });
    defer(() => client.close());
    return client;
  };
  const a = await connect();
  const b = await connect();

  await a.controller.createConversation({ kind: "chat" }, "investigate");
  const conversationId = a.view.current().conversation!.conversation.id;
  await b.controller.switchConversation(conversationId);
  // Kill while the answer is still streaming, partway through and past the
  // first store: streamed text is stored up to about 1 s after it is shown
  // (pi.progress.persistWithinMs), so this is ~2 s in.
  await waitForView(b.view, (view) => (streamingText(view.conversation!)?.length ?? 0) > 80);
  const seenBeforeKill = streamingText(b.view.current().conversation!)!;
  expect(seenBeforeKill.length).toBeLessThan(LONG_ANSWER.length);
  first.child.kill("SIGKILL");
  await once(first.child, "exit");
  await Promise.all([a, b].map((client) => waitForView(client.view, (view) => view.connection === "reconnecting")));

  const second = await spawnHost(dir.path, port);
  expect(second.token).toBe(first.token);

  const settled = (client: RemoteDurable) =>
    waitForView(
      client.view,
      (view) => view.connection === "connected" && !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.role === "assistant",
      30_000,
    );
  await Promise.all([settled(a), settled(b)]);

  // The stored partial survives the crash as an aborted entry; recovery then resends the request.
  // Up to the last second of what clients saw may be lost with the process.
  const [user, interrupted, answer, ...rest] = transcript(a.view.current().conversation!);
  expect(user).toEqual({ role: "user", text: "investigate" });
  expect(interrupted).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(interrupted!.text.length).toBeGreaterThan(0);
  expect(LONG_ANSWER.startsWith(interrupted!.text)).toBe(true);
  expect(answer).toEqual({ role: "assistant", text: LONG_ANSWER, stopReason: "stop" });
  expect(rest).toEqual([]);
  expect(b.view.current().conversation).toEqual(a.view.current().conversation);
});
