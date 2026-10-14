import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Models } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineExtension, defineTool, type LiveState } from "@earendil-works/pi-durable";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { BuiltinExtension } from "../src/builtin-extension.ts";
import { coding } from "../src/extensions/coding.ts";
import { createCodemode } from "../src/extensions/codemode.ts";
import { question } from "../src/extensions/question.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { connectTo, followFirst, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));

/** The extension list main.ts builds, for a faux host. */
const extensionsFor = (provided: {
  models: Models;
  modelSummaries: () => readonly ModelSummary[];
}): readonly BuiltinExtension[] => [
  coding,
  question,
  createSubagent({ models: provided.models, modelSummaries: provided.modelSummaries, exclude: [question.extension] }),
  createCodemode(),
];

type ToolResultEntry = { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown };

/** `pi.tool-result` models of the shown conversation, in order. */
const toolResults = (client: RemoteDurable): ToolResultEntry[] =>
  client
    .view.current()
    .conversation!.entries.filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => entry.model?.[0] as ToolResultEntry);

const resultText = (result: ToolResultEntry | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");

/** The last `pi.tool-result` of the shown conversation. */
const lastResult = (client: RemoteDurable): ToolResultEntry => toolResults(client).at(-1)!;

const script = (code: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });

describe("codemode", () => {
  it("runs read/bash calls in parallel and returns only the script's output", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeFile(join(project.path, "a.txt"), "alpha-secret-".repeat(50));
    await writeFile(join(project.path, "b.txt"), "beta-secret-".repeat(50));
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [
        script(`const [a, b, out] = await Promise.all([
          tools.read({ path: "a.txt" }),
          tools.read({ path: "b.txt" }),
          tools.bash({ command: "printf from-bash" }),
        ]);
        return "summary: a=" + a.length + " b=" + b.length + " bash=" + out.output;`),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "summarize the files");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = lastResult(client);
    expect(result.isError).not.toBe(true);
    const text = resultText(result);
    expect(text).toContain("Script completed");
    expect(text).toContain("bash=from-bash");
    // Only the script's output reaches the model: the raw file contents do not.
    expect(text).not.toContain("alpha-secret-");
    expect(text).not.toContain("beta-secret-");
    const details = result.details as { code: string; calls: { name: string; status: string }[] };
    expect(details.calls.map((call) => call.name).sort()).toEqual(["bash", "read", "read"]);
    expect(details.calls.every((call) => call.status === "ok")).toBe(true);
  });

  it("resolves a bash nonzero exit to its structured output instead of rejecting", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [
        script(`const r = await tools.bash({ command: "echo hi; exit 3" });
          return "exit=" + r.exitCode + " out=" + r.output.trim();`),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "run a failing command");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = lastResult(client);
    expect(result.isError).not.toBe(true);
    const text = resultText(result);
    expect(text).toContain("exit=3");
    expect(text).toContain("out=hi");
    // An error result the script got a value for is still an error row on the card.
    const details = result.details as { calls: { name: string; status: string; error?: string }[] };
    expect(details.calls[0]).toMatchObject({ name: "bash", status: "error" });
  });

  it("applies an edit through a script", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeFile(join(project.path, "f.txt"), "hello world\n");
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [
        script(`await tools.edit({ path: "f.txt", edits: [{ oldText: "hello", newText: "goodbye" }] }); return "edited";`),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "change the file");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    expect(await readFile(join(project.path, "f.txt"), "utf8")).toBe("goodbye world\n");
    // Upstream nested calls carry no per-call details (ADR-0013 §7): no nested diff.
    const details = lastResult(client).details as { calls: { name: string; status: string }[] };
    expect(details.calls[0]).toMatchObject({ name: "edit", status: "ok" });
  });

  it("keeps model-only tools out of scripts and fails direct calls to them", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [
        script(`text(ALL_TOOLS.map((t) => t.name).sort().join(","));
        await tools.ask_user_question({ questions: [] });`),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "list tools then ask");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = lastResult(client);
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("Script error:");
    const names = text.split("\n").find((line) => line.includes("read")) ?? "";
    for (const kept of ["read", "bash", "edit", "write"]) expect(names).toContain(kept);
    for (const excluded of ["ask_user_question", "subagent", "codemode"]) expect(names).not.toContain(excluded);
  });

  it("keeps the output a failing script already produced", async () => {
    const host = await startFauxHost(defer, {
      extensions: extensionsFor,
      answers: [script(`text("before"); throw new Error("boom");`), "done"],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "run it");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = lastResult(client);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("before");
    expect(resultText(result)).toContain("Script error");
    expect(resultText(result)).toContain("Error: boom");
  });

  it("keeps image blocks when long script output is truncated", async () => {
    const host = await startFauxHost(defer, {
      extensions: extensionsFor,
      answers: [
        script([
          '// @options: {"max_output_tokens": 100}',
          'text("a".repeat(2000));',
          'image({ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" });',
          'text("b".repeat(2000));',
        ].join("\n")),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startChat(client, "run it");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const blocks = lastResult(client).content ?? [];
    // The image sits in the omitted middle of the text but must survive truncation.
    expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { text: string }).text).toContain("Script completed");
    const text = resultText(lastResult(client));
    // Upstream cuts past the token budget and spills the full text to a file.
    expect(text).toContain("tokens truncated");
    expect(text).toContain("Image saved to");
    const details = lastResult(client).details as { fullOutputPath?: string };
    expect(details.fullOutputPath).toBeDefined();
  });

  it("lets a script catch a nested tool's error and continue", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [
        script(`try { await tools.read({ path: "missing.txt" }); } catch (error) { return "caught: " + error.message; }`),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "try a failing command");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = lastResult(client);
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("caught:");
    const details = result.details as { calls: { name: string; status: string }[] };
    expect(details.calls[0]).toMatchObject({ name: "read", status: "error" });
  });

  it("exposes MCP tools to scripts only by default, with discovery helpers", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const configPath = join(dir.path, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], description: "Fixture server" } } }),
    );
    const offered: string[][] = [];
    const prompts: string[] = [];
    const record: FauxResponseFactory = (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      prompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage(fauxToolCall("codemode", {
        code: `text(JSON.stringify(await tools.mcp__fixture__echo({ text: "hi" })));
        text((await searchTools("echo")).map((t) => t.name).join(","));
        text(JSON.stringify((await describeNamespace("fixture")).tools));
        return "done with mcp";`,
      }), { stopReason: "toolUse" });
    };
    const host = await startFauxHost(defer, {
      mcpConfig: configPath,
      extensions: extensionsFor,
      answers: [record, "done"],
    });
    const client = await connectTo(defer, host);
    await waitForView(
      client.view,
      (view) => view.mcp?.servers.find((server) => server.name === "fixture")?.state === "connected",
    );
    await startChat(client, "use the mcp echo tool");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const names = offered[0] ?? [];
    expect(names).not.toContain("mcp__fixture__echo");
    expect(names).toContain("codemode");
    expect(prompts[0]).toContain("codemode");
    expect(prompts[0]).toContain("fixture");

    const text = resultText(lastResult(client));
    expect(text).toContain('"hi"');
    expect(text).toContain("mcp__fixture__echo");
    for (const tool of ["echo", "image", "fail", "add_tool", "crash"]) expect(text).toContain(tool);
  });

  it("offers a direct-exposure server's tools to the model and resolves them in scripts", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const configPath = join(dir.path, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], exposure: "direct" } } }),
    );
    const offered: string[][] = [];
    const record: FauxResponseFactory = (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(fauxToolCall("codemode", {
        code: `const result = await tools.mcp__fixture__echo({ text: "hi" }); return JSON.stringify(result);`,
      }), { stopReason: "toolUse" });
    };
    const host = await startFauxHost(defer, { mcpConfig: configPath, extensions: extensionsFor, answers: [record, "done"] });
    const client = await connectTo(defer, host);
    await waitForView(
      client.view,
      (view) => view.mcp?.servers.find((server) => server.name === "fixture")?.state === "connected",
    );
    await startChat(client, "echo through the script");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    expect(offered[0]).toContain("mcp__fixture__echo");
    expect(resultText(lastResult(client))).toContain('"hi"');
  });

  it("aborts a running script quickly", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: extensionsFor,
      answers: [script(`await tools.bash({ command: "sleep 30" }); return "never";`), "unreached"],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "sleep");
    // Abort only once the nested bash call shows as running in pi.live.nestedTools.
    await waitForView(client.view, (view) => {
      const live = view.conversation?.docs["pi.live"] as LiveState | undefined;
      const parent = live?.tools?.find((tool) => tool.name === "codemode");
      return (
        parent?.status === "running" &&
        live?.nestedTools?.some((tool) => tool.parentCallId === parent.callId && tool.name === "bash" && tool.status === "running") === true
      );
    });
    await client.controller.abort();
    await waitForView(client.view, (view) => view.conversation !== undefined && !isBusy(view.conversation));

    const result = lastResult(client);
    expect(result.isError).toBe(true);
    // An aborted script yields a harness-written error result; upstream keeps
    // no partial call list for it.
    expect(resultText(result)).toContain("aborted");
    expect(result.details).toBeUndefined();
  });

  it("keeps model-only tools callable by the model but not by scripts", async () => {
    const offered: string[][] = [];
    const record: FauxResponseFactory = (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: `try { await tools.ask_user_question({ questions: [{ header: "Q", question: "q?", options: [{ label: "a" }] }] }); return "asked"; }
            catch (error) { try { await tools.subagent({ task: "x" }); return "subagent called"; } catch (inner) { return "both blocked"; } }`,
        }),
        { stopReason: "toolUse" },
      );
    };
    const host = await startFauxHost(defer, { extensions: extensionsFor, answers: [record, "done"] });
    const client = await connectTo(defer, host);
    await startChat(client, "try the model-only tools");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    expect(offered[0]).toContain("ask_user_question");
    expect(offered[0]).toContain("subagent");
    expect(resultText(lastResult(client))).toContain("both blocked");
  });

  it("resumes a script across a host restart without re-running finished calls", async () => {
    const project = await tempDir();
    defer(project.remove);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executions = { counted: 0, blocked: 0 };
    const counters: BuiltinExtension = {
      extension: defineExtension({
        name: "counters",
        tools: [
          defineTool({
            name: "counted",
            description: "Counts its executions.",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: `counted #${++executions.counted}` }] }),
          }),
          defineTool({
            name: "blocked",
            description: "Waits on the test's gate.",
            parameters: Type.Object({}),
            // Re-runs after a restart; the replaying script reattaches to it.
            replay: "safe",
            execute: async (_args, _api, ctx) => {
              const attempt = ++executions.blocked;
              // Close aborts the invocation; settling keeps the task's record
              // running so the reopened harness replays it.
              await new Promise<void>((resolve, reject) => {
                gate.then(resolve);
                ctx.abortSignal?.addEventListener("abort", () => reject(new Error("aborted by host close")));
              });
              return { output: [{ type: "text", text: `released #${attempt}` }] };
            },
          }),
        ],
      }),
    };
    const extensions = (provided: Parameters<typeof extensionsFor>[0]) => [...extensionsFor(provided), counters];
    const host1 = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions,
      answers: [
        script(`const a = await tools.counted({}); const b = await tools.blocked({}); return a + "|" + b;`),
        "done",
      ],
    });
    const client1 = await connectTo(defer, host1);
    await startConversation(client1, { kind: "project", path: project.path }, "run the script");
    // The first nested call is done; the second is in flight when the host dies.
    const deadline = Date.now() + 10_000;
    while (executions.blocked !== 1) {
      if (Date.now() > deadline) throw new Error("blocked tool never ran");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(executions.counted).toBe(1);
    await host1.close();

    const host2 = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions,
      answers: ["done"],
    });
    const client2 = await connectTo(defer, host2);
    await followFirst(client2);
    release();
    await waitForView(
      client2.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    expect(executions.counted).toBe(1);
    expect(executions.blocked).toBe(2);
    expect(resultText(lastResult(client2))).toContain("counted #1|released #2");
  });
});
