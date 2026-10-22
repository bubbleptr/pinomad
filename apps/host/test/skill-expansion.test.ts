// `$name` skill expansion (issue #308, ADR-0028): the host prepends each
// mentioned skill's full text to the user message in pi-coding-agent's
// `/skill:` format, keeps the typed text verbatim after it, and leaves the
// text alone for unknown names and unreadable files.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { createContext } from "../src/extensions/context.ts";
import { expandSkillMentions } from "../src/skill-expansion.ts";
import { connectTo, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

const DISABLED = "disable-model-invocation: true\n";

/** Writes `<dir>/<name>/SKILL.md` and returns the skill's directory. */
async function writeSkill(dir: string, name: string, body: string, extra = ""): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} steps\n${extra}---\n\n${body}\n\n`);
  return skillDir;
}

/** pi-coding-agent's `_expandSkillCommand` block, spelled out. */
const block = (name: string, skillDir: string, body: string): string =>
  `<skill name="${name}" location="${skillDir}/SKILL.md">\nReferences are relative to ${skillDir}.\n\n${body}\n</skill>`;

/** The stored text of the shown conversation's user messages, oldest first. */
const userTexts = (client: RemoteDurable): string[] =>
  transcript(client.view.current().conversation!).flatMap((line) => (line.role === "user" ? [line.text] : []));

/** Resolve once the shown conversation holds `count` user messages and is idle. */
const settledAfter = (client: RemoteDurable, count: number) =>
  waitForView(
    client.view,
    (view) =>
      view.conversation !== undefined
      && !isBusy(view.conversation)
      && transcript(view.conversation).filter((line) => line.role === "user").length === count
      && transcript(view.conversation).at(-1)?.role === "assistant",
  );

async function userSkillsHost(answers = 4) {
  const agentsHome = await tempDir();
  defer(agentsHome.remove);
  const skills = join(agentsHome.path, "skills");
  const review = await writeSkill(skills, "review", "Review the diff.\n\nThen report.");
  const deploy = await writeSkill(skills, "deploy", "Deploy steps.");
  const host = await startFauxHost(defer, { agentsHome: agentsHome.path, answers: Array.from({ length: answers }, () => "ok") });
  const client = await connectTo(defer, host);
  return { host, client, review, deploy };
}

describe("skill expansion", () => {
  it("expands `$review` in a new conversation to pi's block, then the typed text verbatim", async () => {
    const { client, review } = await userSkillsHost();
    await startChat(client, "$review do x");
    await settledAfter(client, 1);
    expect(userTexts(client)).toEqual([`${block("review", review, "Review the diff.\n\nThen report.")}\n\n$review do x`]);
  });

  it("expands a project conversation against the project's skills", async () => {
    const project = await tempDir();
    defer(project.remove);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    // Not a git repo: the conversation works in the project directory itself,
    // which the host registers by its real path.
    const local = await writeSkill(join(await realpath(project.path), ".agents", "skills"), "review", "Project review.");
    await writeSkill(join(agentsHome.path, "skills"), "review", "User review.");
    const host = await startFauxHost(defer, { projects: [project.path], agentsHome: agentsHome.path, answers: ["ok"] });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: project.path }, "please $review");
    await settledAfter(client, 1);
    expect(userTexts(client)).toEqual([`${block("review", local, "Project review.")}\n\nplease $review`]);
  });

  it("writes one block per distinct skill, in first-mention order", async () => {
    const { client, review, deploy } = await userSkillsHost();
    await startChat(client, "$review twice: $review");
    await settledAfter(client, 1);
    await client.controller.submit("$deploy after $review, then $deploy", "followUp");
    await settledAfter(client, 2);

    const reviewBlock = block("review", review, "Review the diff.\n\nThen report.");
    expect(userTexts(client)).toEqual([
      `${reviewBlock}\n\n$review twice: $review`,
      `${block("deploy", deploy, "Deploy steps.")}\n\n${reviewBlock}\n\n$deploy after $review, then $deploy`,
    ]);
  });

  it("leaves unknown names, mid-word dollars, and dollar-free text unchanged", async () => {
    const { client } = await userSkillsHost();
    await startChat(client, "$foo and pre$review cost $5");
    await settledAfter(client, 1);
    await client.controller.submit("plain text", "followUp");
    await settledAfter(client, 2);
    expect(userTexts(client)).toEqual(["$foo and pre$review cost $5", "plain text"]);
  });

  it("sends the text unchanged with an error notice when the skill file cannot be read", async () => {
    const { client, review } = await userSkillsHost();
    const id = await startChat(client, "hi");
    await settledAfter(client, 1);
    // Prime the scope's listing, then take the file away underneath it: the
    // lister still names the skill, the read fails.
    const listing = await client.controller.listSkills({ kind: "conversation", conversationId: id });
    expect(listing.skills.map((skill) => skill.name).sort()).toEqual(["deploy", "review"]);
    await rm(join(review, "SKILL.md"));

    await client.controller.submit("$review and $deploy", "followUp");
    await settledAfter(client, 2);
    expect(userTexts(client)[1]).toMatch(/^<skill name="deploy" [^]*\n<\/skill>\n\n\$review and \$deploy$/);
    expect(userTexts(client)[1]).not.toContain('<skill name="review"');
    await waitForView(client.view, (view) =>
      view.notices.some((notice) => notice.level === "error" && notice.message.includes("review") && notice.message.includes(review)),
    );
  });

  it("lists and expands a disable-model-invocation skill, keeping it out of the prompt", async () => {
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const skills = join(agentsHome.path, "skills");
    const ship = await writeSkill(skills, "ship", "Ship it carefully.", DISABLED);
    await writeSkill(skills, "review", "Review the diff.");
    const prompts: string[] = [];
    const capture: FauxResponseFactory = (context) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage("ok");
    };
    const host = await startFauxHost(defer, {
      agentsHome: agentsHome.path,
      extensions: [createContext({ agentsHome: agentsHome.path })],
      answers: [capture],
    });
    const client = await connectTo(defer, host);

    const listing = await client.controller.listSkills({ kind: "chat" });
    expect(listing.skills.map((skill) => skill.name).sort()).toEqual(["review", "ship"]);

    await startChat(client, "$ship now");
    await settledAfter(client, 1);
    expect(userTexts(client)).toEqual([`${block("ship", ship, "Ship it carefully.")}\n\n$ship now`]);
    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("<name>review</name>");
    expect(prompt).not.toContain("<name>ship</name>");
    // The model no longer needs a rule for resolving `$name` itself.
    expect(prompt).not.toContain("`$name`");
  });
});

describe("host readers of user text", () => {
  it("titles from what the user typed: the summary fallback and the auto-title input", async () => {
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeSkill(join(agentsHome.path, "skills"), "review", "Review the diff.");
    const titleInputs: string[] = [];
    const titler: FauxResponseFactory = (context) => {
      const request = context.messages.at(-1)!;
      titleInputs.push(typeof request.content === "string" ? request.content : JSON.stringify(request.content));
      return fauxAssistantMessage("Review x");
    };
    const host = await startFauxHost(defer, { agentsHome: agentsHome.path, answers: ["reviewed"] });
    const client = await connectTo(defer, host);

    const id = await startChat(client, "$review do x");
    await settledAfter(client, 1);
    const summary = () => client.view.current().organized.chats.find((node) => node.summary.id === id)!.summary;
    // No auto-title on this host: the summary falls back to the first message.
    expect(summary().title).toBe("$review do x");

    const titled = await startFauxHost(defer, { agentsHome: agentsHome.path, autoTitle: true, answers: ["reviewed", titler] });
    const titledClient = await connectTo(defer, titled);
    const titledId = await startChat(titledClient, "$review do x");
    await waitForView(titledClient.view, (view) =>
      view.organized.chats.some((node) => node.summary.id === titledId && node.summary.title === "Review x"),
    );
    expect(titleInputs).toEqual(["User's first message:\n$review do x\n\nAgent's reply:\nreviewed"]);
  });
});

describe("expandSkillMentions", () => {
  it("reports each unreadable skill and keeps the readable ones", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const review = await writeSkill(dir.path, "review", "Review.");
    const gone = join(dir.path, "gone");
    const result = await expandSkillMentions("$gone then $review", [
      { name: "review", filePath: join(review, "SKILL.md"), baseDir: review },
      { name: "gone", filePath: join(gone, "SKILL.md"), baseDir: gone },
    ]);
    expect(result.text).toBe(`${block("review", review, "Review.")}\n\n$gone then $review`);
    expect(result.failures).toEqual([{ name: "gone", filePath: join(gone, "SKILL.md"), message: expect.stringContaining("ENOENT") }]);
  });

  it("returns the text itself when nothing is mentioned", async () => {
    expect(await expandSkillMentions("no mention", [{ name: "review", filePath: "/x/SKILL.md", baseDir: "/x" }])).toEqual({
      text: "no mention",
      failures: [],
    });
  });
});
