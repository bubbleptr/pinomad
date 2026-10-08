import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";
import { chromium, type Page } from "@playwright/test";
import { question } from "@pinomad/host/src/extensions/question.ts";
import { todo } from "@pinomad/host/src/extensions/todo.ts";
import { openHost, type OpenedHost } from "@pinomad/host/src/host.ts";
import { connectTo, followFirst, freePort, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { coding } from "@pinomad/host/src/extensions/coding.ts";
import { createSubagent } from "@pinomad/host/src/extensions/subagent.ts";
import { deriveChat } from "../src/entities/conversation/cot-view.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";

const defer = useCleanups();
const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

async function startWeb(): Promise<string> {
  const vite = await createServer({ configFile: webConfig, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  return new URL(vite.resolvedUrls!.local[0]!).origin;
}

async function openPage(host: OpenedHost, width: number, webOrigin: string) {
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await page.getByRole("textbox").waitFor();
  return page;
}

/** Every node in an organized view, top-level and nested. */
const allNodes = (view: { organized: { chats: readonly ConversationNode[]; projects: readonly { conversations: readonly ConversationNode[] }[] } }): ConversationNode[] => {
  const flat = (nodes: readonly ConversationNode[]): ConversationNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)]);
  return flat(view.organized.chats.concat(...view.organized.projects.map((entry) => entry.conversations)));
};

it("keeps the chat usable on a phone with navigation and live state still reachable", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 390, webOrigin);

  const composer = page.getByRole("textbox");
  expect((await composer.boundingBox())!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // A single header row: the old button bar is gone.
  expect(await page.getByRole("button", { name: "Conversations" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Live state" }).count()).toBe(0);

  // The initial screen is a draft chat; the first message creates the conversation.
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "hello", exact: true }).click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "Dock", exact: true }).click();
  await page.getByRole("dialog").getByText("No live tasks").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compact", exact: true }).waitFor();
});

it("preserves an unsent follow-up and disables write controls while reconnecting", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["An answer to fork."] });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Fork", exact: true }).waitFor();
  await composer.fill("keep this draft");

  await host.close();
  await page.getByText("Host connection lost", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Follow-up", exact: true }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "Compact", exact: true }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "Fork", exact: true }).isDisabled()).toBe(true);
  expect(await composer.textContent()).toBe("keep this draft");
});

it("sends a typed steer from the button without stopping the run, and still stops with empty input", async () => {
  const webOrigin = await startWeb();
  // Slow enough that the answer is still streaming when the steer is sent.
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], tokensPerSecond: 20 });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("look into it");
  await composer.press("Enter");
  await followFirst(observer);
  await waitForView(observer.view, (view) => view.conversation !== undefined && isBusy(view.conversation));
  await page.getByRole("button", { name: /stop/i, exact: true }).waitFor();

  await composer.fill("focus on the logs");
  const send = page.getByRole("button", { name: /send/i, exact: true });
  expect(await send.count()).toBe(1);
  await send.click();
  await waitForView(observer.view, (view) => {
    const inbox = view.conversation?.docs["pi.inbox"] as { items?: { mode: string }[] } | undefined;
    return inbox?.items?.some((item) => item.mode === "steer") === true;
  });
  expect(isBusy(observer.view.current().conversation!)).toBe(true);
  await expect.poll(() => composer.textContent()).toBe("");

  await page.getByRole("button", { name: /stop/i, exact: true }).click();
  await waitForView(observer.view, (view) => view.conversation !== undefined && !isBusy(view.conversation));
});

it.each([
  ["thinking-only", fauxAssistantMessage(fauxThinking("Compare the release evidence."))],
  ["tool-only", fauxAssistantMessage(fauxToolCall("search_logs", { release: "v2.3" }), { stopReason: "toolUse" })],
])("forks a persisted %s answer from its message action", async (_, message) => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "The fork continued."] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  const conversationId = await followFirst(observer);
  const source = await host.harness.commit(
    (tx) => tx.appendEntry(AssistantEntry, conversationId, { model: [message] }),
    BACKGROUND_CONTEXT,
  );

  const fork = page.getByRole("button", { name: "Fork", exact: true });
  // One Fork action per run: the run's last assistant entry is the appended one.
  await expect.poll(() => fork.count()).toBe(1);
  await fork.last().click();
  await page.getByRole("textbox", { name: "First message", exact: true }).fill("Continue from this evidence.");
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();

  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));
  const branch = allNodes(observer.view.current()).find((node) => node.summary.kind === "fork")!;
  await observer.controller.switchConversation(branch.summary.id);
  await waitForView(
    observer.view,
    (view) => view.conversation !== undefined && !isBusy(view.conversation) && transcript(view.conversation).at(-1)?.text === "The fork continued.",
  );
  const entries = observer.view.current().conversation!.entries;
  expect(entries.some((entry) => entry.id === source.id)).toBe(true);
  expect(transcript(observer.view.current().conversation!).at(-2)).toMatchObject({
    role: "user",
    text: "Continue from this evidence.",
  });
});

it("renders todo and a pending question card on every page and shares one answer", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    extensions: [todo, question],
    answers: [
      fauxAssistantMessage(
        fauxToolCall("todo_write", { items: [{ text: "Investigate the report", status: "in_progress" }] }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("ask_user_question", {
          questions: [
            { header: "Deploy", question: "Deploy v2.3 now?", options: [{ label: "Yes" }, { label: "No" }] },
          ],
        }),
        { stopReason: "toolUse" },
      ),
      "all answered",
    ],
  });
  const a = await openPage(host, 1280, webOrigin);
  const b = await openPage(host, 1280, webOrigin);

  await a.getByRole("textbox").fill("plan and deploy");
  await a.getByRole("textbox").press("Enter");
  // Page B joins the conversation from the navigation.
  await b.getByRole("button", { name: "plan and deploy", exact: true }).click();

  for (const page of [a, b]) {
    await page.getByRole("button", { name: "Dock", exact: true }).click();
    const panel = page.getByLabel("Live state");
    await panel.getByText("Investigate the report", { exact: true }).waitFor();
    // The pending question renders above the composer in the main column.
    const card = page.getByTestId("pending-questions");
    await card.getByText("Deploy v2.3 now?", { exact: true }).waitFor();
    await expect.poll(() => card.getByRole("button", { name: "Submit", exact: true }).count()).toBe(1);
  }

  await a.getByTestId("pending-questions").getByRole("radio", { name: "Yes", exact: true }).click();
  await a.getByTestId("pending-questions").getByRole("button", { name: "Submit", exact: true }).click();
  // Both pages converge on the stored answer; the turn continues.
  await b.getByLabel("Live state").getByText("Yes", { exact: true }).waitFor();
  await a.getByText("all answered", { exact: true }).waitFor();
});

it("renders a document that fails its presentation schema as key-value fallback", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], extensions: [todo, question] });
  const owner = await connectTo(defer, host);
  const conversationId = await startChat(owner, "has a bad doc");
  // Declared pinomad.todo but shaped wrong: the client must not lie about it.
  const token = todo.docs![0]!.token;
  await host.harness.commit(async (tx) => {
    (await tx.doc(token, conversationId))["items"] = "not-an-array";
  }, BACKGROUND_CONTEXT);

  const page = await openPage(host, 1280, webOrigin);
  await page.getByRole("button", { name: "has a bad doc", exact: true }).click();
  await page.getByRole("button", { name: "Dock", exact: true }).click();
  const panel = page.getByLabel("Live state");
  await panel.getByText("todo.list", { exact: true }).waitFor();
  await panel.getByText("items", { exact: true }).waitFor();
  await panel.getByText('"not-an-array"', { exact: true }).waitFor();
  // The rest of the workbench still works.
  await page.getByRole("textbox").fill("still alive");
  expect(await page.getByRole("textbox").textContent()).toBe("still alive");
});

it("shows interruption without a text bubble and never offers a fork for streaming or aborted thinking", async () => {
  const webOrigin = await startWeb();
  const directory = await tempDir();
  defer(directory.remove);
  const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
  faux.setResponses([fauxAssistantMessage(fauxThinking("Compare the release evidence. ".repeat(100)))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const host = await openHost({
    dataDir: directory.path,
    models,
    modelSummaries: () => [],
    initialModel: { provider: model.provider, modelId: model.id },
    port: 0,
    browserOrigins: [webOrigin],
  });
  defer(() => host.close());
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 390, webOrigin);
  await page.getByRole("textbox").fill("Investigate the release.");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("Thinking…", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);

  await followFirst(observer);
  await observer.controller.abort();
  await waitForView(
    observer.view,
    (view) =>
      view.conversation !== undefined
      && deriveChat(view.conversation, view.toolPresentations, isBusy(view.conversation)).some(
        (item) => item.kind === "run" && item.interrupted,
      ),
  );
  await expect.poll(() => page.getByText("interrupted", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
});

it("opens a subagent's conversation from its card and returns to the parent", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    extensions: ({ models, modelSummaries }: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
      createSubagent({ models, modelSummaries, exclude: [] }),
    ],
    answers: [
      fauxAssistantMessage(fauxToolCall("subagent", { task: "count the lines" }), { stopReason: "toolUse" }),
      "child answer",
      "parent final",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("delegate");
  await composer.press("Enter");
  await page.getByText("parent final", { exact: true }).waitFor();

  // The settled subagent call sits folded inside the chain of thought;
  // expanding the run, then the step, reveals the link to its child.
  await page.getByRole("button", { name: /Worked for/, exact: false }).click();
  await page.getByRole("button", { name: /Used count the lines/, exact: false }).click();
  await page.getByRole("button", { name: "Open conversation", exact: true }).click();
  // The header breadcrumb is <parent title> › <child title>.
  await page.getByRole("button", { name: "Back to delegate", exact: true }).waitFor();
  await page.getByText("child answer", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Back to delegate", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "Back to delegate", exact: true }).count()).toBe(0);
  await page.getByText("parent final", { exact: true }).waitFor();
});

it("renders a real edit's diff inside the tool row instead of the raw args", async () => {
  const webOrigin = await startWeb();
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    projects: [project.path],
    extensions: [coding],
    answers: [
      fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\ngamma\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "delta" }] }), {
        stopReason: "toolUse",
      }),
      "edit complete",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await page.getByRole("textbox").fill("fix the notes");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("edit complete", { exact: true }).waitFor();

  // Expand the run's folded steps: each round is its own single-call step,
  // and a single-call step expands straight to the detail.
  await page.getByRole("button", { name: /Worked for/ }).click();
  await page.getByRole("button", { name: /Edited notes.txt/ }).click();

  const editDetail = page.locator('[data-slot="chat-tool-step-detail"]').last();
  // The diff view carries the hunk lines; the args and output panes are gone.
  await editDetail.getByText("-beta", { exact: true }).waitFor();
  await editDetail.getByText("+delta", { exact: true }).waitFor();
  expect(await editDetail.locator('[data-slot="chat-tool-args"]').count()).toBe(0);
  expect(await editDetail.locator('[data-slot="chat-tool-result"]').count()).toBe(0);
});

it("keeps the chain of thought in place when a grouped tool row takes focus", async () => {
  const webOrigin = await startWeb();
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    projects: [project.path],
    extensions: [coding],
    answers: [
      fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "alpha\nbeta\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "notes.txt" }),
          fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "delta" }] }),
        ],
        { stopReason: "toolUse" },
      ),
      "edit complete",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await page.getByRole("textbox").fill("fix the notes");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("edit complete", { exact: true }).waitFor();

  await page.getByRole("button", { name: /Worked for/ }).click();
  await page.getByRole("button", { name: /Read 1 file/ }).click();
  // The grouped rows overhang their clip box for the hover fill; focusing one
  // must not scroll that box sideways and shear off the steps' left edge.
  await page.getByRole("button", { name: /^edit/ }).click();

  const content = page.locator(".chain-of-thought__content").last();
  const contentBox = (await content.boundingBox())!;
  const firstStep = (await content.locator(".chat-step__trigger").first().boundingBox())!;
  expect(firstStep.x).toBeGreaterThanOrEqual(contentBox.x);
});

it("organizes conversations under projects and chats", async () => {
  const webOrigin = await startWeb();
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: ["project answer", "chat answer", "fork answer"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // Add the project through the dialog.
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(project.path);
  await page.getByRole("dialog").getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("group", { name: projectName }).waitFor();

  // A new conversation in the project runs under it — and the header says so.
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  // The draft label shows in the header AND as the empty-state heading.
  await page.locator("h3", { hasText: `New conversation in ${projectName}` }).waitFor();
  await expect.poll(() => page.locator("h1").textContent()).toBe(`New conversation in ${projectName}`);
  await page.getByRole("textbox").fill("project work");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("project answer", { exact: true }).waitFor();
  const projectSection = page.getByRole("group", { name: projectName });
  await projectSection.getByRole("button", { name: "project work", exact: true }).waitFor();

  // A new chat lands under Chats, then archives away.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByText("New chat", { exact: true }).nth(1).waitFor();
  await page.getByRole("textbox").fill("chat work");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("chat answer", { exact: true }).waitFor();
  const chats = page.getByRole("group", { name: "Chats" });
  await chats.getByRole("button", { name: "chat work", exact: true }).waitFor();
  await chats.getByRole("button", { name: "chat work", exact: true }).hover();
  await chats.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect.poll(() => chats.getByRole("button", { name: "chat work", exact: true }).count()).toBe(0);

  // A fork nests under its parent conversation.
  await projectSection.getByRole("button", { name: "project work", exact: true }).click();
  await page.getByRole("button", { name: "Fork", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  await waitForView(observer.view, (view) =>
    allNodes(view).some((node) => node.summary.kind === "fork" && node.summary.title === "Continue from here."),
  );
  const parentNode = observer.view
    .current()
    .organized.projects[0]!.conversations.find((node) => node.children.length > 0)!;
  expect(parentNode.children[0]!.summary.kind).toBe("fork");
  await page.getByText("fork answer", { exact: true }).waitFor();
});

it("keeps the dock closed until asked and keeps it open across conversations", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "second answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  const composer = page.getByRole("textbox");
  await composer.fill("first chat");
  await composer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();
  await startChat(observer, "second chat");
  await page.getByRole("button", { name: "second chat", exact: true }).waitFor();

  // Closed by default: nothing of the live state is mounted.
  expect(await page.getByLabel("Live state").count()).toBe(0);
  const dockToggle = page.getByRole("button", { name: "Dock", exact: true });
  expect(await dockToggle.getAttribute("aria-pressed")).toBe("false");
  await dockToggle.click();
  const panel = page.getByLabel("Live state");
  await panel.getByText("No live tasks", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Dock", exact: true }).getAttribute("aria-pressed")).toBe("true");

  // Switching conversations keeps the dock open.
  await page.getByRole("button", { name: "second chat", exact: true }).click();
  await page.getByText("second answer", { exact: true }).waitFor();
  await panel.getByText("No live tasks", { exact: true }).waitFor();

  // And closes again.
  await page.getByRole("button", { name: "Dock", exact: true }).click();
  await expect.poll(() => page.getByLabel("Live state").count()).toBe(0);
});

it("puts the conversation title in the header and the path inside the dock", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["an answer"] });
  const page = await openPage(host, 1280, webOrigin);

  const composer = page.getByRole("textbox");
  await composer.fill("title me");
  await composer.press("Enter");
  await page.getByText("an answer", { exact: true }).waitFor();

  // The header carries the conversation's title — not its path.
  await expect.poll(() => page.locator("h1").textContent()).toBe("title me");
  expect(await page.getByText("/chats/", { exact: false }).count()).toBe(0);

  // The path moved into the dock's Workspace section.
  await page.getByRole("button", { name: "Dock", exact: true }).click();
  const panel = page.getByLabel("Live state");
  await panel.getByText("Workspace", { exact: true }).waitFor();
  await panel.getByText("/chats/", { exact: false }).waitFor();
});

it("collapses the sidebar into the header toggle and restores it", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "New chat", exact: true }).count()).toBe(0);
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  await expand.waitFor();

  // The choice survives a reload.
  await page.reload();
  await expand.waitFor();
  expect(await page.getByRole("button", { name: "New chat", exact: true }).count()).toBe(0);

  await expand.click();
  await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
  await expect.poll(() => page.getByRole("button", { name: "Expand sidebar" }).count()).toBe(0);
});

it("pairs a phone client through the QR link and survives revoke", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: ["paired answer"],
    remote: { port: await freePort() },
  });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // A phone on http://<lan-ip> is not a secure context: crypto.randomUUID is
  // absent there, so every client code path must survive without it.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);

  // Pairing completes: the composer is usable and the secret leaves the URL.
  const composer = page.getByRole("textbox");
  await composer.waitFor();
  await composer.fill("hello from phone");
  await composer.press("Enter");
  await page.getByText("paired answer", { exact: true }).waitFor();
  expect(page.url()).not.toContain("#pair=");

  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
  expect(tokenClient.view.current().devices[0]!.name).toBe("Mac Chrome");

  // The stored device reconnects without a fragment.
  await page.goto(`${webOrigin}/`);
  await page.getByRole("textbox").waitFor();

  // Revocation drops the client into the rejected state; forgetting shows the entry screen.
  await tokenClient.controller.revokeDevice(tokenClient.view.current().devices[0]!.publicKey);
  await page.getByText("paired with the host, or was revoked", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Forget this host", exact: true }).click();
  await page.getByText("No host link", { exact: true }).waitFor();
});

it("manages paired devices from the Devices dialog", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Devices", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("No paired devices", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Pair a device", exact: true }).click();
  await page.getByRole("img", { name: "Pairing QR code" }).waitFor();
  await dialog.getByText("#pair=", { exact: false }).waitFor();
  await dialog.getByText("Expires in", { exact: false }).waitFor();

  // A device paired from another client appears in the list.
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const [hostKey, secret] = pairingUrl.split("#pair=")[1]!.split(".");
  const phone = await connectRemoteDurable({
    transport: secureWebSocketTransport({
      url: host.remote!.url,
      hostKey: fromBase64Url(hostKey!),
      device: generateKeyPair(),
      pairing: { secret: secret!, name: "QA phone" },
    }),
  });
  defer(() => phone.close());
  await dialog.getByText("QA phone", { exact: true }).waitFor();

  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await dialog.getByText("No paired devices", { exact: false }).waitFor();
});

it("shows a plain connection error — not a forget-pairing prompt — when the host is down", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await page.getByRole("textbox").waitFor();

  // Host dies; the stored device mode must not claim the pairing is bad.
  await tokenClient.close();
  await host.close();
  await page.goto(`${webOrigin}/`);
  await page.getByText("Could not connect to the host", { exact: true }).waitFor();
  await expect.poll(() => page.getByRole("button", { name: "Forget this host" }).count()).toBe(0);
});

it("reuses the stored device key when a spent pairing link is opened again", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: ["paired answer", "second answer"],
    remote: { port: await freePort() },
  });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;
  const pairLink = `${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  defer(() => context.close());
  // Pair once in this context — the device identity lands in localStorage.
  const first = await context.newPage();
  await first.goto(pairLink);
  await first.getByRole("textbox").waitFor();
  await first.getByRole("textbox").fill("hello");
  await first.getByRole("textbox").press("Enter");
  await first.getByText("paired answer", { exact: true }).waitFor();
  const savedKey = await first.evaluate(
    () => (JSON.parse(localStorage.getItem("pinomad.device")!) as { privateKey: string }).privateKey,
  );

  // Same context, the now-spent link: a fresh load like scanning the QR again.
  const again = await context.newPage();
  await again.goto(pairLink);
  await again.getByRole("textbox").waitFor();
  expect(again.url()).not.toContain("#pair=");
  const afterKey = await again.evaluate(
    () => (JSON.parse(localStorage.getItem("pinomad.device")!) as { privateKey: string }).privateKey,
  );
  expect(afterKey).toBe(savedKey);

  await again.getByRole("textbox").fill("hi again");
  await again.getByRole("textbox").press("Enter");
  await again.getByText("second answer", { exact: true }).waitFor();
  // Still just the one registered device — no new identity was created.
  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
});

it("tells a fresh browser that a spent pairing code was used or expired", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  // Consume the offer with one pairing first.
  const first = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await first.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await first.getByRole("textbox").waitFor();
  await first.close();

  // A context with no stored device sees the spent-code explanation, nothing destructive.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  defer(() => context.close());
  const fresh = await context.newPage();
  await fresh.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await fresh.getByText("used or has expired", { exact: false }).waitFor();
  expect(await fresh.getByRole("button", { name: "Forget this host" }).count()).toBe(0);
  expect(await fresh.getByRole("button", { name: "Use saved pairing" }).count()).toBe(0);
});

it("keeps a rejected pairing's recovery button reachable by scrolling on a short viewport", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  // Consume the offer with one pairing so the link is rejected next time.
  const first = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await first.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await first.getByRole("textbox").waitFor();
  await first.close();

  // A saved pairing for a different host renders the spent-code screen plus a
  // "Use saved pairing" recovery button — the content is taller than 220px.
  const context = await browser.newContext({ viewport: { width: 280, height: 220 } });
  defer(() => context.close());
  const saved = generateKeyPair();
  await context.addInitScript((device) => {
    try {
      localStorage.setItem("pinomad.device", JSON.stringify(device));
    } catch {
      // Non-http preload pages (about:blank) have no usable localStorage.
    }
  }, { url: host.remote!.url, hostKey: toBase64Url(generateKeyPair().publicKey), privateKey: toBase64Url(saved.privateKey) });
  const page = await context.newPage();
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  const message = page.getByText("used or has expired", { exact: false });
  await message.waitFor();
  const button = page.getByRole("button", { name: "Use saved pairing", exact: true });

  // A real scroll gesture must bring the recovery button into view.
  await page.mouse.move(140, 110);
  await page.mouse.wheel(0, 2000);
  await page.waitForFunction(() => {
    const scroller = Array.from(document.querySelectorAll("#root div")).find((d) => d.scrollTop > 0);
    return scroller !== undefined;
  });
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(220);

  // Scrolling back up returns the message to the viewport.
  await page.mouse.wheel(0, -2000);
  await page.waitForFunction(() => {
    const scroller = Array.from(document.querySelectorAll("#root div")).find((d) => d.scrollHeight > d.clientHeight + 1);
    return scroller === undefined || scroller.scrollTop === 0;
  });
  const messageBox = await message.boundingBox();
  expect(messageBox!.y).toBeGreaterThanOrEqual(0);
});

// The element that clips and scrolls the messages: the nearest ancestor of a
// rendered message that actually overflows (scrollHeight > clientHeight).
const scrollerOf = async (page: Page, text: string) =>
  page.getByText(text, { exact: true }).evaluate((el) => {
    let cur: HTMLElement | null = el.parentElement;
    while (
      cur !== null &&
      (cur.scrollHeight <= cur.clientHeight + 1 || !["auto", "scroll"].includes(getComputedStyle(cur).overflowY))
    )
      cur = cur.parentElement;
    return cur === null ? null : { top: cur.scrollTop, height: cur.scrollHeight, client: cur.clientHeight };
  });

it("scrolls a long conversation with the mouse wheel over the message column", async () => {
  const webOrigin = await startWeb();
  const long = Array.from({ length: 150 }, (_, i) => `- line ${i}`).join("\n");
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: [long] });
  const page = await openPage(host, 1280, webOrigin);

  const composer = page.getByRole("textbox");
  await composer.fill("long chat");
  await composer.press("Enter");
  const last = page.getByText("line 149", { exact: true });
  await last.waitFor();

  const before = await scrollerOf(page, "line 149");
  expect(before).not.toBeNull();
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1500);
  await expect.poll(async () => (await scrollerOf(page, "line 100"))?.top ?? 99999).toBeLessThan(before!.top - 200);
});

it("opens a switched conversation at its latest answer instead of the old scroll position", async () => {
  const webOrigin = await startWeb();
  const long = (tag: string) => Array.from({ length: 150 }, (_, i) => `- ${tag} ${i}`).join("\n");
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: [long("A"), long("B")] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // Chat A through the page; chat B through a second client so the page stays on A.
  const composer = page.getByRole("textbox");
  await composer.fill("first chat");
  await composer.press("Enter");
  const lastA = page.getByText("A 149", { exact: true });
  await lastA.waitFor();
  await startChat(observer, "second chat");
  const chats = page.getByRole("group", { name: "Chats" });
  await chats.getByRole("button", { name: "second chat", exact: true }).waitFor();

  // Scroll chat A to the very top with a real wheel gesture over the messages.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -5000);
  await page.mouse.wheel(0, -5000);
  // The smooth-scroll spring can settle a few px short of 0 — "near the top" is
  // enough to prove A is scrolled away from its bottom.
  await expect.poll(async () => (await scrollerOf(page, "A 149"))?.top ?? 99999).toBeLessThan(40);

  // Switching conversations must not inherit that scroll position.
  await chats.getByRole("button", { name: "second chat", exact: true }).click();
  await page.getByText("B 149", { exact: true }).waitFor();
  await expect
    .poll(async () => {
      const s = await scrollerOf(page, "B 149");
      return s === null ? 99999 : s.height - s.top - s.client;
    })
    .toBeLessThan(8);
});
