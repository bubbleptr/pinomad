import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { chromium } from "@playwright/test";
import { approval } from "@pinomad/host/src/extensions/approval.ts";
import { todo } from "@pinomad/host/src/extensions/todo.ts";
import { openHost, type OpenedHost } from "@pinomad/host/src/host.ts";
import { connectTo, freePort, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { chatItems } from "../src/presentation/chat.ts";
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

it("keeps the chat usable on a phone with navigation and live state still reachable", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 390, webOrigin);

  const composer = page.getByRole("textbox");
  expect((await composer.boundingBox())!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "Live state", exact: true }).click();
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
  await waitForView(observer.view, (view) => isBusy(view.conversation));
  await page.getByRole("button", { name: /stop/i, exact: true }).waitFor();

  await composer.fill("focus on the logs");
  const send = page.getByRole("button", { name: /send/i, exact: true });
  expect(await send.count()).toBe(1);
  await send.click();
  await waitForView(observer.view, (view) => {
    const inbox = view.conversation.docs["pi.inbox"] as { items?: { mode: string }[] } | undefined;
    return inbox?.items?.some((item) => item.mode === "steer") === true;
  });
  expect(isBusy(observer.view.current().conversation)).toBe(true);
  await expect.poll(() => composer.textContent()).toBe("");

  await page.getByRole("button", { name: /stop/i, exact: true }).click();
  await waitForView(observer.view, (view) => !isBusy(view.conversation));
});

it.each([
  ["thinking-only", fauxAssistantMessage(fauxThinking("Compare the release evidence."))],
  ["tool-only", fauxAssistantMessage(fauxToolCall("search_logs", { release: "v2.3" }), { stopReason: "toolUse" })],
])("forks a persisted %s answer from its message action", async (_, message) => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["The fork continued."] });
  const root = await host.harness.root(BACKGROUND_CONTEXT);
  const source = await root.commit((tx) => tx.appendEntry(AssistantEntry, root.id, { model: [message] }), BACKGROUND_CONTEXT);
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  const fork = page.getByRole("button", { name: "Fork", exact: true });
  await expect.poll(() => fork.count()).toBe(1);
  await fork.click();
  await page.getByRole("textbox", { name: "First message", exact: true }).fill("Continue from this evidence.");
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();

  await waitForView(observer.view, (view) => view.conversations.some((conversation) => conversation.label.startsWith("fork ")));
  const branch = observer.view.current().conversations.find((conversation) => conversation.label.startsWith("fork "))!;
  await observer.controller.switchConversation(branch.id);
  await waitForView(observer.view, (view) => !isBusy(view.conversation) && transcript(view.conversation).at(-1)?.text === "The fork continued.");
  const entries = observer.view.current().conversation.entries;
  expect(entries.some((entry) => entry.id === source.id)).toBe(true);
  expect(transcript(observer.view.current().conversation).at(-2)).toMatchObject({ role: "user", text: "Continue from this evidence." });
});

it("renders todo and approval documents on every page and shares one decision", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    extensions: [todo, approval],
    answers: [
      fauxAssistantMessage(
        fauxToolCall("todo_write", { items: [{ text: "Investigate the report", status: "in_progress" }] }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("request_approval", { title: "Deploy v2.3?" }), { stopReason: "toolUse" }),
      "all approved",
    ],
  });
  const a = await openPage(host, 1280, webOrigin);
  const b = await openPage(host, 1280, webOrigin);

  await a.getByRole("textbox").fill("plan and deploy");
  await a.getByRole("textbox").press("Enter");

  for (const page of [a, b]) {
    const panel = page.getByLabel("Live state");
    await panel.getByText("Investigate the report", { exact: true }).waitFor();
    await panel.getByText("Deploy v2.3?", { exact: true }).waitFor();
    await expect.poll(() => panel.getByRole("button", { name: "Approve", exact: true }).count()).toBe(1);
  }

  await a.getByLabel("Live state").getByRole("button", { name: "Approve", exact: true }).click();
  await b.getByLabel("Live state").getByText("approved", { exact: true }).waitFor();
  await expect.poll(() => b.getByLabel("Live state").getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
  await a.getByText("all approved", { exact: true }).waitFor();
});

it("renders a document that fails its presentation schema as key-value fallback", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], extensions: [todo, approval] });
  // Declared pinomad.todo but shaped wrong: the client must not lie about it.
  const token = todo.docs![0]!.token;
  await host.harness.commit(async (tx) => {
    (await tx.doc(token, ROOT_CONVERSATION_ID))["items"] = "not-an-array";
  }, BACKGROUND_CONTEXT);

  const page = await openPage(host, 1280, webOrigin);
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
    cwd: directory.path,
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

  await observer.controller.abort();
  await waitForView(observer.view, (view) => chatItems(view.conversation).some((item) => item.kind === "assistant" && item.stopReason === "aborted"));
  await expect.poll(() => page.getByText("interrupted", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
});
