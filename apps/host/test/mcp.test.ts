import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type { McpStatus } from "@pinomad/protocol/mcp.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));

/** Write an `mcpServers` config into a fresh temp dir and return its path. */
async function writeConfig(servers: Record<string, unknown>): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  const path = join(dir.path, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
  return path;
}

/** Resolve once the view's mcp status satisfies `predicate`. */
const mcpIs = (client: RemoteDurable, predicate: (status: McpStatus) => boolean): Promise<void> =>
  waitForView(client.view, (view) => view.mcp !== null && predicate(view.mcp));

const server = (status: McpStatus, name: string) => status.servers.find((entry) => entry.name === name);

/** The `pi.tool-result` messages of the shown conversation, in order. */
function toolResults(client: RemoteDurable): { content?: unknown[]; isError?: boolean }[] {
  return client
    .view.current()
    .conversation!.entries.filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => entry.model?.[0] as { content?: unknown[]; isError?: boolean });
}

/** Poll a plain condition — used for the server process, which no stream reports. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met within the timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

describe("mcp", () => {
  it("serves a connected server's tools to conversations and returns text, images, and errors", async () => {
    const configPath = await writeConfig({ fixture: { command: process.execPath, args: [fixture] } });
    const host = await startFauxHost(defer, {
      mcpConfig: configPath,
      answers: [
        fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { text: "hello from mcp" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("mcp__fixture__image", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("mcp__fixture__fail", {}), { stopReason: "toolUse" }),
        "all done",
      ],
    });
    const client = await connectTo(defer, host);
    await mcpIs(client, (status) => server(status, "fixture")?.state === "connected");
    await startChat(client, "use the mcp tools");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "all done",
    );

    const [echo, image, fail] = toolResults(client);
    expect(echo?.isError).not.toBe(true);
    expect(echo?.content).toEqual([{ type: "text", text: "hello from mcp" }]);
    expect(image?.content).toEqual([{ type: "image", data: expect.any(String), mimeType: "image/png" }]);
    expect(fail?.isError).toBe(true);
  });

  it("reports per-server status and config errors over the mcp stream", async () => {
    const configPath = await writeConfig({
      good: { command: process.execPath, args: [fixture] },
      broken: { command: "pinomad-definitely-not-a-command" },
      off: { command: process.execPath, args: [fixture], enabled: false },
      malformed: { args: [] },
      badenv: { command: process.execPath, args: [fixture], env: { MISSING: "${PINOMAD_UNSET_TEST_VAR}" } },
    });
    const host = await startFauxHost(defer, { mcpConfig: configPath });
    const client = await connectTo(defer, host);

    await mcpIs(client, (status) => server(status, "good")?.state === "connected" && server(status, "broken")?.state === "failed");
    const status = client.view.current().mcp!;
    expect(status.configPath).toBe(configPath);
    expect(server(status, "good")?.tools).toBe(5);
    expect(server(status, "broken")?.error).toBeTruthy();
    expect(server(status, "off")).toMatchObject({ state: "disabled", tools: 0 });
    // Malformed entries land in config errors, not the server list.
    expect(status.servers.map((entry) => entry.name).sort()).toEqual(["broken", "good", "off"]);
    expect(status.errors.some((error) => error.includes("malformed"))).toBe(true);
    expect(status.errors.some((error) => error.includes("badenv") && error.includes("PINOMAD_UNSET_TEST_VAR"))).toBe(true);
  });

  it("reports an unreadable config as an error and a missing config as empty status", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const badPath = join(dir.path, "mcp.json");
    await writeFile(badPath, "{ not json");
    const bad = await startFauxHost(defer, { mcpConfig: badPath });
    const badClient = await connectTo(defer, bad);
    await mcpIs(badClient, (status) => status.errors.length > 0);
    expect(badClient.view.current().mcp!.errors[0]).toContain(badPath);

    const missing = await startFauxHost(defer, { mcpConfig: join(dir.path, "missing.json") });
    const missingClient = await connectTo(defer, missing);
    await mcpIs(missingClient, () => true);
    expect(missingClient.view.current().mcp).toEqual({ configPath: join(dir.path, "missing.json"), errors: [], servers: [] });
  });

  it("re-lists a server's tools on notifications/tools/list_changed", async () => {
    const configPath = await writeConfig({ fixture: { command: process.execPath, args: [fixture] } });
    const host = await startFauxHost(defer, {
      mcpConfig: configPath,
      answers: [
        fauxAssistantMessage(fauxToolCall("mcp__fixture__add_tool", {}), { stopReason: "toolUse" }),
        "added it",
        fauxAssistantMessage(fauxToolCall("mcp__fixture__added", {}), { stopReason: "toolUse" }),
        "used it",
      ],
    });
    const client = await connectTo(defer, host);
    await mcpIs(client, (status) => server(status, "fixture")?.state === "connected" && server(status, "fixture")?.tools === 5);
    await startChat(client, "add a tool");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "added it",
    );
    await mcpIs(client, (status) => server(status, "fixture")?.tools === 6);

    // The next turn's request is prepared after the reinstall, so the new tool is offered.
    await client.controller.submit("use the new tool", "followUp");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "used it",
    );
    const results = toolResults(client);
    expect(results.at(-1)?.content).toEqual([{ type: "text", text: "added tool ran" }]);
  });

  it("marks a server that exits mid-session failed and drops its tools", async () => {
    const configPath = await writeConfig({ fixture: { command: process.execPath, args: [fixture] } });
    const host = await startFauxHost(defer, {
      mcpConfig: configPath,
      answers: [fauxAssistantMessage(fauxToolCall("mcp__fixture__crash", {}), { stopReason: "toolUse" }), "it crashed"],
    });
    const client = await connectTo(defer, host);
    await mcpIs(client, (status) => server(status, "fixture")?.state === "connected");
    const parentId = await startChat(client, "crash the server");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "it crashed",
    );

    await mcpIs(client, (status) => server(status, "fixture")?.state === "failed");
    expect(server(client.view.current().mcp!, "fixture")?.error).toContain("disconnected");
    const agent = await (await host.harness.conversation(parentId, context))!.agent(context);
    expect(agent.tools.map((tool) => tool.name).filter((name) => name.startsWith("mcp__"))).toEqual([]);
  });

  it("stops stdio server processes when the host closes", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const pidFile = join(dir.path, "server.pid");
    const configPath = join(dir.path, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { MCP_FIXTURE_PID: pidFile } } } }),
    );
    const host = await startFauxHost(defer, { mcpConfig: configPath });
    const client = await connectTo(defer, host);
    await mcpIs(client, (status) => server(status, "fixture")?.state === "connected");

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(pid)).toBe(true);
    await host.close();
    await until(() => !alive(pid));
  });
});
