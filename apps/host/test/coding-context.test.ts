import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { coding } from "../src/extensions/coding.ts";
import { createContext } from "../src/extensions/context.ts";
import { connectTo, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

/** The shown conversation's working directory, as the agent resolved it. */
function cwdOf(client: RemoteDurable): string {
  const agent = client.view.current().conversation!.docs["pi.agent"] as AgentState;
  return agent.cwd!;
}

/** Records the effective system prompt of every model request, in order. */
function capturePrompts(prompts: string[]): FauxResponseFactory {
  return (context) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage(`captured-${prompts.length}`);
  };
}

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}.\n`;

describe("coding tools and context extension", () => {
  it("runs bash and read tools in the conversation's project directory", async () => {
    const project = await tempDir();
    defer(project.remove);
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: [coding],
      answers: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "printf hello > out.txt && cat out.txt" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall("read", { path: "out.txt" }), { stopReason: "toolUse" }),
        "tools worked",
      ],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: project.path }, "make a file");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "tools worked",
    );

    expect(await readFile(join(cwdOf(client), "out.txt"), "utf8")).toBe("hello");
    const results = client
      .view.current()
      .conversation!.entries.filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => JSON.stringify(entry.model));
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toContain("hello");
  });

  it("renders preamble, environment, project context, and skills", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeFile(join(project.path, "AGENTS.md"), "project rule: use tabs");
    await mkdir(join(project.path, ".agents", "skills", "deploy"), { recursive: true });
    await writeFile(join(project.path, ".agents", "skills", "deploy", "SKILL.md"), SKILL("deploy", "Project deploy steps"));

    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeFile(join(agentsHome.path, "AGENTS.md"), "global rule: be brief");
    await mkdir(join(agentsHome.path, "skills", "deploy"), { recursive: true });
    await writeFile(join(agentsHome.path, "skills", "deploy", "SKILL.md"), SKILL("deploy", "Global deploy steps"));
    await mkdir(join(agentsHome.path, "skills", "review"), { recursive: true });
    await writeFile(join(agentsHome.path, "skills", "review", "SKILL.md"), SKILL("review", "Global review steps"));

    const prompts: string[] = [];
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: [createContext({ agentsHome: agentsHome.path }), coding],
      answers: [capturePrompts(prompts)],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: project.path }, "hello");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "captured-1",
    );

    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("You are PiNomad, a coding agent running on the user's own machine.");
    expect(prompt).toContain(`Working directory: ${cwdOf(client)}`);
    const globalAt = prompt.indexOf("global rule: be brief");
    const projectAt = prompt.indexOf("project rule: use tabs");
    expect(globalAt).toBeGreaterThanOrEqual(0);
    expect(projectAt).toBeGreaterThanOrEqual(0);
    expect(globalAt).toBeLessThan(projectAt);
    expect(prompt).toContain("<name>deploy</name>");
    expect(prompt).toContain("Project deploy steps");
    expect(prompt).not.toContain("Global deploy steps");
    expect(prompt).toContain("<name>review</name>");
  });

  it("re-renders project context on every request", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const file = join(project.path, "AGENTS.md");
    await writeFile(file, "rule v1");

    const prompts: string[] = [];
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: [createContext({ agentsHome: agentsHome.path })],
      answers: [capturePrompts(prompts), capturePrompts(prompts)],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: project.path }, "one");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "captured-1",
    );
    await writeFile(file, "rule v2");
    await client.controller.submit("two", "followUp");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "captured-2",
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("rule v1");
    expect(prompts[1]).toContain("rule v2");
  });

  it("renders only preamble and environment when context files and skills are absent", async () => {
    const project = await tempDir();
    defer(project.remove);
    const prompts: string[] = [];
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      extensions: [createContext({ agentsHome: join(project.path, "no-such-home") })],
      answers: [capturePrompts(prompts)],
    });
    const client = await connectTo(defer, host);

    await startChat(client, "hello");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "captured-1",
    );

    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("You are PiNomad, a coding agent running on the user's own machine.");
    expect(prompt).toContain(`Working directory: ${cwdOf(client)}`);
    expect(prompt).not.toContain("<project_context>");
    expect(prompt).not.toContain("available_skills");
  });
});
