import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";
import { chromium } from "@playwright/test";
import { approval } from "@pinomad/host/src/extensions/approval.ts";
import { todo } from "@pinomad/host/src/extensions/todo.ts";
import { openHost, type OpenedHost } from "@pinomad/host/src/host.ts";
import { connectTo, followFirst, freePort, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport } from "@pinomad/protocol/secure-channel.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
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

  // The initial screen is a draft chat; the first message creates the conversation.
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "hello", exact: true }).click();
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
  // The prompt's own answer and the appended entry both offer Fork; the latter is last.
  await expect.poll(() => fork.count()).toBe(2);
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
  // Page B joins the conversation from the navigation.
  await b.getByRole("button", { name: "plan and deploy", exact: true }).click();

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
  const owner = await connectTo(defer, host);
  const conversationId = await startChat(owner, "has a bad doc");
  // Declared pinomad.todo but shaped wrong: the client must not lie about it.
  const token = todo.docs![0]!.token;
  await host.harness.commit(async (tx) => {
    (await tx.doc(token, conversationId))["items"] = "not-an-array";
  }, BACKGROUND_CONTEXT);

  const page = await openPage(host, 1280, webOrigin);
  await page.getByRole("button", { name: "has a bad doc", exact: true }).click();
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
      && chatItems(view.conversation).some((item) => item.kind === "assistant" && item.stopReason === "aborted"),
  );
  await expect.poll(() => page.getByText("interrupted", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Fork", exact: true }).count()).toBe(0);
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

  // A new conversation in the project runs under it.
  await page.getByRole("group", { name: projectName }).getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "New conversation", exact: true }).click();
  await page.getByText(`New conversation in ${projectName}`, { exact: true }).waitFor();
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
