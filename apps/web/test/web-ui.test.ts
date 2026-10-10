import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";
import { chromium, type Page } from "@playwright/test";
import { question } from "@pinomad/host/src/extensions/question.ts";
import { todo } from "@pinomad/host/src/extensions/todo.ts";
import { openHost, type OpenedHost } from "@pinomad/host/src/host.ts";
import { connectTo, followFirst, freePort, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
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
const run = promisify(execFile);
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

it("opens the Devices dialog from the phone drawer", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 390, webOrigin);

  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  // The drawer closed; only the Devices dialog remains.
  await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
  await page.getByRole("dialog").getByRole("button", { name: "Pair a device", exact: true }).waitFor();
});

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
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Live", exact: true }).click();
  await page.getByRole("dialog").getByText("No live tasks").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compact conversation", exact: true }).waitFor();
});

it("replaces a draft pick the restarted host no longer offers", async () => {
  const webOrigin = await startWeb();
  const port = await freePort();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, {
    port,
    dataDir: dir.path,
    browserOrigins: [webOrigin],
    fauxModels: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
    answers: ["old host answer", "new host answer"],
  });
  const page = await openPage(host, 1280, webOrigin);
  const capsule = page.getByRole("button", { name: "Model and Thinking", exact: true });
  await expect.poll(() => capsule.textContent()).toContain("Faux Thinker");

  // Restart on the same port/dataDir (the fixture's reconnect mechanism) with
  // a different model list — the stored pick is gone from the new hello.
  await host.close();
  await startFauxHost(defer, {
    port,
    dataDir: dir.path,
    browserOrigins: [webOrigin],
    fauxModels: [{ id: "faux-other", name: "Faux Other" }],
    answers: ["new host answer"],
  });

  // The draft falls back to an available model and submits with it.
  await expect.poll(() => capsule.textContent(), { timeout: 15000 }).toContain("Faux Other");
  await page.getByRole("textbox").fill("after reconnect");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("new host answer", { exact: true }).waitFor();
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
  // Follow-up is only offered while a run is busy — the capsule and the
  // + menu are the always-present write controls here.
  expect(await page.getByRole("button", { name: "Model and Thinking", exact: true }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "More actions", exact: true }).isDisabled()).toBe(true);
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

it("shows no Fork action inside a fork's transcript", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  const fork = page.getByRole("button", { name: "Fork", exact: true });
  await fork.waitFor();
  await fork.click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  // The fork opens in the side panel; its settled run offers no way to fork again.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();
  await expect.poll(() => panel.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
});

it("replaces the Fork action with a 1 fork chip once a message is forked", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();

  // The forked message keeps one chip instead of the Fork icon button.
  const chip = page.getByRole("button", { name: "1 fork", exact: true });
  await chip.waitFor();
  await expect.poll(() => page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);

  // The chip opens that thread in the panel.
  await panel.getByRole("button", { name: "Back to threads", exact: true }).click();
  await panel.getByRole("button", { name: /Continue from here/, exact: false }).waitFor();
  await chip.click();
  await panel.getByRole("button", { name: "Open in main", exact: true }).waitFor();
});

it("shows the 1 fork chip for a legacy nested fork inside the panel's thread", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  const parentId = await followFirst(observer);
  await page.getByText("first answer", { exact: true }).waitFor();

  // Fork A through the API, then seed the pre-ADR-0019 shape directly: a fork
  // B anchored at A's own answer — the depth-of-one rule forbids it today.
  const parentEntryId = String(observer.view.current().conversation!.entries.at(-1)!.id);
  await observer.controller.fork(parentEntryId, "fork side");
  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));
  const forkA = allNodes(observer.view.current()).find((node) => node.summary.kind === "fork")!.summary.id;
  await waitForView(
    observer.view,
    (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "fork answer",
  );
  const aEntryId = observer.view.current().conversation!.entries.filter((entry) => entry.conversationId === forkA).at(-1)!.id;
  await host.harness.commit(
    async (tx) => tx.forkConversation(forkA, aEntryId, { ownership: { kind: "ownerless" } }),
    BACKGROUND_CONTEXT,
  );
  await observer.controller.switchConversation(parentId);
  await waitForView(
    observer.view,
    (view) =>
      allNodes(view).filter((node) => node.summary.kind === "fork").length === 2 &&
      allNodes(view).some((node) => node.summary.parent === forkA),
  );

  // The chip on A's forked-from message (in the main column) opens A's thread.
  await page.getByRole("button", { name: "1 fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();

  // A's own run anchored B: the chip inside the panel opens B's thread too.
  await panel.getByRole("button", { name: "1 fork", exact: true }).click();
  await panel.getByRole("button", { name: "Open in main", exact: true }).waitFor();
  await panel.getByText(/Forked from/, { exact: false }).waitFor();
});

it("opens the existing fork instead of the dialog when a message was already forked", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  const parentId = await followFirst(observer);
  await page.getByRole("button", { name: "Fork", exact: true }).waitFor();

  // A fork already exists at the run's last entry — created through the observer.
  const entryId = String(observer.view.current().conversation!.entries.at(-1)!.id);
  await observer.controller.fork(entryId, "fork side");
  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));
  const forkId = allNodes(observer.view.current()).find((node) => node.summary.kind === "fork")!.summary.id;
  await waitForView(observer.view, (view) => !isBusy(view.conversation!));
  await observer.controller.switchConversation(parentId);

  // The forked message shows the "1 fork" chip instead of the Fork action.
  await expect.poll(() => page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
  await page.getByRole("button", { name: "1 fork", exact: true }).click();
  // The existing fork opens in the panel's Threads detail — no dialog, and the
  // main column stays on the parent (showSide is per-remote).
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Open in main", exact: true }).waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  expect(allNodes(observer.view.current()).filter((node) => node.summary.kind === "fork")).toHaveLength(1);
  await expect.poll(() => page.locator("h1").textContent()).toBe("start");
});

it("forks into the panel's Threads detail and talks to it there", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: ["parent answer", "fork answer", "side answer"],
  });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  await page.getByText("parent answer", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();

  // The main column stays on the parent; the fork answers inside the panel.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect.poll(() => page.locator("h1").textContent()).toBe("start");
  await panel.getByRole("button", { name: "Threads", exact: true }).waitFor();
  await panel.getByText("fork answer", { exact: true }).waitFor();
  // The detail shows only the fork's own entries behind a "Forked from"
  // divider — the parent's prefix lives in the main column, not twice.
  await panel.getByText("Forked from start", { exact: true }).waitFor();
  expect(await panel.getByText("parent answer", { exact: true }).count()).toBe(0);

  // The panel composer talks to the fork only.
  await panel.getByRole("textbox").fill("side question");
  await panel.getByRole("textbox").press("Enter");
  await panel.getByText("side answer", { exact: true }).waitFor();
  // It appears exactly once: inside the panel, never in the main transcript.
  expect(await page.getByText("side answer", { exact: true }).count()).toBe(1);

  // "Open in main" promotes the fork; the panel returns to its Threads list.
  await panel.getByRole("button", { name: "Open in main", exact: true }).click();
  await page.getByRole("button", { name: "Back to start", exact: true }).waitFor();
  await expect.poll(() => panel.getByRole("button", { name: "Open in main", exact: true }).count()).toBe(0);
  await panel.getByRole("button", { name: /Continue from here|side question/, exact: false }).waitFor();
});

it("closes the side detail when the main column switches to another family", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "second answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("first chat");
  await composer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();
  await startChat(observer, "second chat");

  // Fork the first conversation and open it in the panel.
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();

  // Switching to a different root conversation drops the side detail.
  await page.getByRole("button", { name: "second chat", exact: true }).click();
  await page.getByText("second answer", { exact: true }).waitFor();
  await panel.getByText("No threads yet", { exact: true }).waitFor();
});

it("resets the thread composer when the panel switches to another fork", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: ["first answer", "second answer", "fork one answer", "fork two answer"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("one");
  await composer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();
  await composer.fill("two");
  await composer.press("Enter");
  await page.getByText("second answer", { exact: true }).waitFor();
  const parentId = await followFirst(observer);

  // One fork per run, created through the observer.
  const assistantIds = observer.view
    .current()
    .conversation!.entries.filter((entry) => entry.kind === "pi.assistant")
    .map((entry) => String(entry.id));
  await observer.controller.fork(assistantIds[0]!, "fork one");
  await observer.controller.switchConversation(parentId);
  await observer.controller.fork(assistantIds[1]!, "fork two");
  await observer.controller.switchConversation(parentId);
  await waitForView(observer.view, (view) => allNodes(view).filter((node) => node.summary.kind === "fork").length === 2);

  // Open fork A from the Threads list and draft a reply, unsent.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await panel.getByRole("button", { name: "Threads", exact: true }).click();
  await panel.getByRole("button", { name: "fork one", exact: true }).click();
  const threadComposer = panel.getByRole("textbox");
  await threadComposer.fill("draft");

  // Opening fork B through its own message's chip replaces the side;
  // the composer belongs to whichever thread is shown.
  await page.getByRole("button", { name: "1 fork", exact: true }).last().click();
  await panel.getByText("fork two answer", { exact: true }).waitFor();
  await expect.poll(() => threadComposer.textContent()).toBe("");
});

it("shows an empty family in the panel while drafting a new conversation", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();
  await followFirst(observer);

  const entryId = String(observer.view.current().conversation!.entries.at(-1)!.id);
  await observer.controller.fork(entryId, "fork side");
  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));

  const panel = page.getByRole("complementary", { name: "Side panel" });
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await panel.getByRole("button", { name: "Threads", exact: true }).click();
  await panel.getByRole("button", { name: "fork side", exact: true }).waitFor();

  // The draft home has no family — the panel must not keep the previous one's.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await panel.getByText("No threads yet", { exact: true }).waitFor();
});

it("on a phone, Open in main closes the panel dialog too", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 390, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();
  await followFirst(observer);

  const entryId = String(observer.view.current().conversation!.entries.at(-1)!.id);
  await observer.controller.fork(entryId, "fork side");
  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));

  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Threads", exact: true }).click();
  await dialog.getByRole("button", { name: "fork side", exact: true }).click();
  await dialog.getByText("fork answer", { exact: true }).waitFor();

  // Promoting the thread takes over the whole screen — the dialog cannot stay on top.
  await dialog.getByRole("button", { name: "Open in main", exact: true }).click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "Back to start", exact: true }).waitFor();
});

it("shows no Fork action when the shown fork's root left navigation", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "fork answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");
  await composer.fill("start");
  await composer.press("Enter");
  const parentId = await followFirst(observer);
  await page.getByRole("button", { name: "Fork", exact: true }).waitFor();

  // Fork through the observer, then show the fork in the page.
  const entryId = String(observer.view.current().conversation!.entries.at(-1)!.id);
  await observer.controller.fork(entryId, "fork side");
  await waitForView(observer.view, (view) => allNodes(view).some((node) => node.summary.kind === "fork"));
  const forkId = allNodes(observer.view.current()).find((node) => node.summary.kind === "fork")!.summary.id;
  await waitForView(observer.view, (view) => !isBusy(view.conversation!));
  await page.getByRole("button", { name: "start", exact: true }).waitFor();
  await page.getByRole("button", { name: "1 fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Open in main", exact: true }).click();
  await page.getByRole("button", { name: "Back to start", exact: true }).waitFor();

  // Another client archives the root: the fork leaves `organized`, and the
  // action must stay gone rather than reappearing.
  await observer.controller.archive(parentId, true);
  await waitForView(observer.view, (view) => !allNodes(view).some((node) => node.summary.id === parentId));
  await expect.poll(() => page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
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
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
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
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
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

it("rolls a subagent's failure up to the family's root row", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    extensions: ({ models, modelSummaries }: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
      createSubagent({ models, modelSummaries, exclude: [] }),
    ],
    answers: [
      fauxAssistantMessage(fauxToolCall("subagent", { task: "count the lines" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("boom", { errorMessage: "child blew up", stopReason: "error" }),
      "parent final",
    ],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);
  await page.getByRole("textbox").fill("delegate");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("parent final", { exact: true }).waitFor();

  // The child failed; the root's own run ended cleanly.
  const parent = allNodes(observer.view.current()).find((node) => node.summary.kind === "conversation")!;
  expect(parent.children[0]!.summary.status).toBe("failed");
  expect(parent.summary.status).toBeUndefined();

  const row = page.getByRole("group", { name: "Chats" }).locator(".pigui-sidenav-session-row", {
    has: page.getByRole("button", { name: "delegate", exact: true }),
  });
  await expect.poll(() => row.getAttribute("data-status")).toBe("failed");

  // The dot is decorative (aria-hidden inside the button); the status reaches
  // screen readers as a hidden sibling AFTER it in reading order, and the row
  // button's accessible name stays exactly the title.
  await row.locator("xpath=./span[normalize-space()='Failed']").waitFor({ state: "attached" });
  await expect.poll(() =>
    row.getByRole("button", { name: "delegate", exact: true }).count(),
  ).toBe(1);
});

it("opens a subagent's conversation from its card in the panel's Tasks detail", async () => {
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

  // The settled call anchors a card under the run: label, status, model and
  // elapsed, without unfolding the chain of thought.
  const card = page.locator('[data-slot="subagent-card"][data-status="done"]');
  await card.waitFor();
  await card.getByText("count the lines", { exact: true }).waitFor();
  await card.getByText(/Done · faux\/faux-1 · \d+s/, { exact: false }).waitFor();
  await card.getByRole("button", { name: "View", exact: true }).click();

  // It opens beside the main column in the panel — read-only, no composer.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByRole("button", { name: "Tasks", exact: true }).waitFor();
  await panel.getByText("child answer", { exact: true }).waitFor();
  await panel.getByText("Read-only · subagent", { exact: true }).waitFor();
  expect(await panel.getByRole("textbox").count()).toBe(0);
  // The main column still shows the parent.
  await expect.poll(() => page.locator("h1").textContent()).toBe("delegate");

  // Back to the list: the task rows sit under their owner's group.
  await panel.getByRole("button", { name: "Back to tasks", exact: true }).click();
  await panel.getByText("This conversation", { exact: true }).waitFor();
  await panel.getByRole("button", { name: /count the lines/, exact: false }).waitFor();
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

it("shows the draft home and fills the composer from a suggestion without creating", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("heading", { name: "Build something useful with PiNomad" }).waitFor();
  await page.getByRole("combobox", { name: "Project", exact: true }).waitFor();
  for (const label of [
    "Explain this repo's architecture",
    "Fix the failing test",
    "Add a CLI flag with docs",
    "Review my uncommitted changes",
  ]) {
    await page.getByRole("button", { name: label, exact: true }).waitFor();
  }

  // A suggestion fills the composer and focuses it; nothing is created.
  await page.getByRole("button", { name: "Fix the failing test", exact: true }).click();
  expect(await page.getByRole("textbox").textContent()).toBe("Fix the failing test");
  expect(await page.getByRole("textbox").evaluate((el) => document.activeElement === el || el.contains(document.activeElement))).toBe(true);
  await expect.poll(() => page.getByRole("button", { name: "No chats", exact: true }).count()).toBe(1);
});

it("creates the draft conversation under the picked project", async () => {
  const webOrigin = await startWeb();
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], projects: [project.path], answers: ["picked answer"] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: projectName, exact: true }).click();
  await expect.poll(() => page.locator("h1").textContent()).toBe(`New conversation in ${projectName}`);

  await page.getByRole("textbox").fill("picked work");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("picked answer", { exact: true }).waitFor();
  await page.getByRole("group", { name: projectName }).getByRole("button", { name: "picked work", exact: true }).waitFor();
});

it("creates the draft with the picked model and thinking level", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
    answers: ["thinking answer"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // The default is the host's first model; the capsule picks the reasoning one + a level.
  const capsule = page.getByRole("button", { name: "Model and Thinking", exact: true });
  await capsule.click();
  await page.getByRole("button", { name: "Faux Thinker", exact: false }).click();
  await page.getByRole("button", { name: "Medium", exact: true }).click();
  await expect.poll(() => capsule.textContent()).toContain("Faux Thinker · Medium");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox").fill("deep work");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("thinking answer", { exact: true }).waitFor();

  // The new conversation's composer shows the picked model, and the agent doc carries it.
  const liveCapsule = page.getByRole("button", { name: "Model and Thinking", exact: true });
  await expect.poll(() => liveCapsule.textContent()).toContain("Faux Thinker · Medium");
  await expect.poll(async () => {
    const conversationId = observer.view.current().organized.chats.find((node) => node.summary.title === "deep work")?.summary.id;
    if (conversationId === undefined) return undefined;
    const agent = await host.harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT);
    return `${agent?.model?.provider}/${agent?.model?.modelId}:${agent?.thinkingLevel}`;
  }).toBe("faux/faux-thinker:medium");
});

it("changes the model and thinking level from the composer capsule", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
    answers: ["done"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("textbox").fill("hello");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("done", { exact: true }).waitFor();

  // The default model is non-reasoning: plain name, no Thinking section.
  const capsule = page.getByRole("button", { name: "Model and Thinking", exact: true });
  await expect.poll(() => capsule.textContent()).toContain("Faux Model");
  await capsule.click();
  // Non-reasoning model: no Thinking section (no level rows at all).
  expect(await page.getByRole("group", { name: "Thinking" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Faux Thinker", exact: false }).textContent()).not.toContain("·");

  // Picking the reasoning model reveals its levels once the setModel call
  // round-trips; picking one relabels the trigger.
  await page.getByRole("button", { name: "Faux Thinker", exact: false }).click();
  const thinking = page.getByRole("group", { name: "Thinking" });
  await thinking.getByRole("button", { name: "High", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => capsule.textContent()).toContain("Faux Thinker · High");
  await expect.poll(async () => {
    const id = observer.view.current().organized.chats.find((node) => node.summary.title === "hello")?.summary.id;
    if (id === undefined) return undefined;
    const agent = await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    return `${agent?.model?.provider}/${agent?.model?.modelId}:${agent?.thinkingLevel}`;
  }).toBe("faux/faux-thinker:high");
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
  await expect.poll(() => page.locator("h1").textContent()).toBe(`New conversation in ${projectName}`);
  await page.getByRole("textbox").fill("project work");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("project answer", { exact: true }).waitFor();
  const projectSection = page.getByRole("group", { name: projectName });
  await projectSection.getByRole("button", { name: "project work", exact: true }).waitFor();

  // A new chat lands under Chats, then archives away.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect.poll(() => page.locator("h1").textContent()).toBe("New chat");
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
  // The fork opens beside the main column in the panel's Threads detail.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();

  // The sidebar lists roots only: the fork is never a row, and its root stays
  // selected while the fork is shown (aria-current from SideNavItem isSelected).
  expect(await projectSection.getByRole("button", { name: "Continue from here.", exact: true }).count()).toBe(0);
  const rootRow = projectSection.getByRole("button", { name: "project work", exact: true });
  await expect.poll(() => rootRow.getAttribute("aria-current")).toBe("page");
  // The row's trailing meta is the family's freshest update, compact.
  await expect.poll(async () => await projectSection.locator(".pigui-sidenav-session-meta").textContent()).toBe("now");

  // "Open in main" promotes the fork: main shows it, the breadcrumb returns.
  await panel.getByRole("button", { name: "Open in main", exact: true }).click();
  await page.getByRole("button", { name: "Back to project work", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "Back to project work", exact: true }).count()).toBe(0);
  await page.getByText("project answer", { exact: true }).waitFor();
});

it("keeps the side panel closed until asked and keeps it open across conversations", async () => {
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

  // Closed by default: nothing of the panel is mounted.
  expect(await page.getByRole("complementary", { name: "Side panel" }).count()).toBe(0);
  const panelToggle = page.getByRole("button", { name: "Side panel", exact: true });
  expect(await panelToggle.getAttribute("aria-pressed")).toBe("false");
  await panelToggle.click();
  const panel = page.getByLabel("Live state");
  await panel.getByText("No live tasks", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Side panel", exact: true }).getAttribute("aria-pressed")).toBe("true");

  // Switching conversations keeps the panel open.
  await page.getByRole("button", { name: "second chat", exact: true }).click();
  await page.getByText("second answer", { exact: true }).waitFor();
  await panel.getByText("No live tasks", { exact: true }).waitFor();

  // And closes again.
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect.poll(() => page.getByRole("complementary", { name: "Side panel" }).count()).toBe(0);
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

  // The path moved into the panel's Workspace section, on the Live tab.
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
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

it("creates exactly one conversation when Enter is pressed twice quickly", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["done"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  const composer = page.getByRole("textbox");
  await composer.fill("double tap");
  // Two Enters before the first submit resolves: the second must not create
  // a second conversation (each submit carries a fresh requestId).
  await composer.evaluate((el) => {
    for (const _ of [0, 1]) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
  });
  await page.getByText("done", { exact: true }).waitFor();

  await expect.poll(() => observer.view.current().organized.chats.length).toBe(1);
});

it("disables the follow-up and stop controls while disconnected", async () => {
  const webOrigin = await startWeb();
  const port = await freePort();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, {
    port,
    dataDir: dir.path,
    browserOrigins: [webOrigin],
    answers: [LONG_ANSWER, LONG_ANSWER],
    tokensPerSecond: 10,
  });
  const page = await openPage(host, 1280, webOrigin);
  const composer = page.getByRole("textbox");

  // Busy run + empty input: the disconnected Stop is disabled.
  await composer.fill("keep busy");
  await composer.press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.waitFor();
  await host.close();
  await page.getByText("Host connection lost", { exact: true }).waitFor();
  // ChatSendButton can't render a disabled stop, so while disconnected the
  // stop state is hidden and the send control shows, disabled.
  expect(await page.getByRole("button", { name: "Stop", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);

  // Reconnect to a restarted host and start a second busy run; the Follow-up
  // button appearing proves busy, then dropping the host again leaves it
  // disabled and the typed text intact.
  const restarted = await startFauxHost(defer, {
    port,
    dataDir: dir.path,
    browserOrigins: [webOrigin],
    answers: [LONG_ANSWER],
    tokensPerSecond: 10,
  });
  await page.getByText("Host connection lost", { exact: true }).waitFor({ state: "detached" });
  await composer.fill("again");
  await composer.press("Enter");
  await composer.fill("unsent follow-up");
  await page.getByRole("button", { name: "Follow-up", exact: true }).waitFor();
  await restarted.close();
  await page.getByText("Host connection lost", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Follow-up", exact: true }).isDisabled()).toBe(true);
  await expect.poll(() => composer.textContent()).toBe("unsent follow-up");
});

it("compacts the conversation from the more-actions menu", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["done"] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("textbox").fill("hello");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("done", { exact: true }).waitFor();

  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compact conversation", exact: true }).click();
  await page.locator("[data-toast-id]").getByText("Compaction", { exact: false }).waitFor();
});

it("shows a queued follow-up above the composer until the run takes it", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    tokensPerSecond: 60,
    answers: ["word ".repeat(500), "followed"],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("textbox").fill("go");
  await page.getByRole("textbox").press("Enter");
  // Wait for the live composer (the draft's input would eat the fill otherwise)
  // and for the run to be provably busy.
  await page.getByText("word", { exact: false }).first().waitFor();
  await page.getByRole("textbox").fill("next task");
  await page.getByRole("button", { name: "Follow-up", exact: true }).click();

  const queued = page.locator(".chat-queued-message");
  await queued.getByText("next task", { exact: true }).waitFor();
  await queued.getByText("Follow-up", { exact: true }).waitFor();
  // Once the run takes it, the row is gone and the message is a user entry.
  await page.locator(".chat-queued-message").first().waitFor({ state: "detached" });
  await page.getByText("followed", { exact: true }).waitFor();
});

it("shows the location row and honors the draft checkout picker", async () => {
  const webOrigin = await startWeb();
  const repoDir = await tempDir();
  defer(repoDir.remove);
  const repoName = repoDir.path.split("/").at(-1)!;
  await mkdir(join(repoDir.path, ".git-placeholder"), { recursive: true });
  await run("git", ["-C", repoDir.path, "init", "-b", "main"]);
  await writeFile(join(repoDir.path, "tracked.txt"), "tracked\n");
  await run("git", ["-C", repoDir.path, "add", "-A"]);
  await run("git", ["-C", repoDir.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  const plainDir = await tempDir();
  defer(plainDir.remove);
  const plainName = plainDir.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    projects: [repoDir.path, plainDir.path],
    answers: ["chat done", "tree done", "direct done"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // A chat conversation carries the static "Chat" chip.
  await page.getByRole("textbox").fill("chat hi");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("chat done", { exact: true }).waitFor();
  await page.getByText("Chat", { exact: true }).waitFor();

  // A repo project defaults to a worktree: "Git worktree" + its pinomad branch.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: repoName, exact: true }).click();
  await page.getByRole("combobox", { name: "Where to work", exact: true }).waitFor();
  await page.getByRole("textbox").fill("tree hi");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("tree done", { exact: true }).waitFor();
  await page.getByText("Git worktree", { exact: true }).waitFor();
  await page.getByText(/pinomad\/[0-9]+-[0-9a-f]+/).waitFor();

  // A plain project with "Project folder" works directly in its directory.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: plainName, exact: true }).click();
  await page.getByRole("combobox", { name: "Where to work", exact: true }).click();
  await page.getByRole("option", { name: "Project folder", exact: true }).click();
  await page.getByRole("textbox").fill("direct hi");
  await page.getByRole("textbox").press("Enter");
  await page.getByText("direct done", { exact: true }).waitFor();
  await page.getByText("Project folder", { exact: true }).waitFor();
  await expect.poll(async () => {
    const id = observer.view.current().organized.projects.find((p) => p.project.name === plainName)
      ?.conversations.find((node) => node.summary.title === "direct hi")?.summary.id;
    if (id === undefined) return undefined;
    const agent = await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    return agent?.cwd;
  }).toBe(await realpath(plainDir.path));
});

it("surfaces a failed command as a toast without opening the dock", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  // The dock stays closed; a rejected command must still be visible.
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("/nonexistent/pinomad-nope");
  await page.getByRole("dialog").getByRole("button", { name: "Add project", exact: true }).click();
  // Scope to the toast itself: the message also lands in Astryx's hidden
  // assertive live region, making a bare role=alert match ambiguous.
  const toast = page.locator("[data-toast-id]");
  await toast.getByText("No such directory", { exact: false }).waitFor();

  // An undismissed error toast must not sit over the composer or the header's
  // actions — it would block sending until dismissed. Settle the toast's own
  // animations only: the draft hero's shimmer loops forever.
  await page.waitForFunction(() =>
    document.querySelector("[data-toast-id]")?.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
  );
  const toastBox = (await toast.boundingBox())!;
  const composerBox = (await page.getByRole("textbox").boundingBox())!;
  const dockBox = (await page.getByRole("button", { name: "Side panel", exact: true }).boundingBox())!;
  const intersects = (a: typeof toastBox, b: typeof toastBox) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  expect(intersects(toastBox, composerBox)).toBe(false);
  expect(intersects(toastBox, dockBox)).toBe(false);
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
  // Pin the UA so the derived device name doesn't depend on the OS running the test.
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  });
  // A phone on http://<lan-ip> is not a secure context: crypto.randomUUID is
  // absent there, so every client code path must survive without it.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);

  // Pairing completes after the confirmation: the composer is usable and the
  // secret leaves the URL.
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const composer = page.getByRole("textbox");
  await composer.waitFor();
  await composer.fill("hello from phone");
  await composer.press("Enter");
  await page.getByText("paired answer", { exact: true }).waitFor();
  expect(page.url()).not.toContain("#pair=");

  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
  expect(tokenClient.view.current().devices[0]!.name).toBe("Android Chrome");

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

it("explains a loopback pairing link instead of drawing an unusable QR", async () => {
  const webOrigin = await startWeb();
  // No remote access: the offer points at 127.0.0.1, which a phone's camera
  // could never reach — the dialog must say so instead of showing a QR.
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Devices", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Pair a device", exact: true }).click();
  await dialog.getByText("only works on this machine", { exact: false }).waitFor();
  expect(await dialog.getByRole("img", { name: "Pairing QR code" }).count()).toBe(0);
  await expect.poll(() => dialog.getByText(/#pair=/, { exact: false }).count()).toBeGreaterThan(0);
});

it("pairs a device by pasting the loopback link on the no-link screen", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["pasted-link hello"] });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  // No remote access: the offer targets the loopback /secure path.
  expect(pairingUrl).toContain("%2Fsecure");

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage();
  await page.goto(webOrigin);
  await page.getByText("No host link").waitFor();

  await page.getByLabel("Pairing link").fill(pairingUrl);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const composer = page.getByRole("textbox");
  await composer.waitFor();
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByText("pasted-link hello").waitFor();
  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
});

it("names the host and opens no socket until a pair link is confirmed", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);

  // The link names its host; the offer stays unconsumed while it waits.
  await page.getByText("Pair with this host?").waitFor();
  await page.getByText(`pair with ${new URL(host.remote!.url).host}`, { exact: false }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(tokenClient.view.current().devices).toHaveLength(0);

  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("textbox").waitFor();
  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
});

it("drops a pair link back to the no-link screen on Cancel", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await page.getByText("Pair with this host?").waitFor();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("No host link").waitFor();
  expect(tokenClient.view.current().devices).toHaveLength(0);
});

it("re-resolves the address when the hash changes in place", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();
  const pair = pairingUrl.split("#pair=")[1]!;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage();
  await page.goto(webOrigin);
  await page.getByText("No host link").waitFor();

  // What a deep link into an open window does: a same-document hash change.
  await page.evaluate((fragment) => {
    window.location.hash = fragment;
  }, `pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await page.getByText("Pair with this host?").waitFor();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("textbox").waitFor();
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
  await page.getByRole("button", { name: "Pair", exact: true }).click();
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
  await first.getByRole("button", { name: "Pair", exact: true }).click();
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
  await again.getByRole("button", { name: "Pair", exact: true }).click();
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
  await first.getByRole("button", { name: "Pair", exact: true }).click();
  await first.getByRole("textbox").waitFor();
  await first.close();

  // A context with no stored device sees the spent-code explanation, nothing destructive.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  defer(() => context.close());
  const fresh = await context.newPage();
  await fresh.goto(`${webOrigin}/#pair=${pair}&url=${encodeURIComponent(host.remote!.url)}`);
  await fresh.getByRole("button", { name: "Pair", exact: true }).click();
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
  await first.getByRole("button", { name: "Pair", exact: true }).click();
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
  await page.getByRole("button", { name: "Pair", exact: true }).click();
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
