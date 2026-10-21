import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";
import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { question } from "@pinomad/host/src/extensions/question.ts";
import { todo } from "@pinomad/host/src/extensions/todo.ts";
import type { AgentRoleStore } from "@pinomad/host/src/agent-roles.ts";
import { openHost, type OpenedHost } from "@pinomad/host/src/host.ts";
import { constantValue, Published } from "@pinomad/host/src/host-value.ts";
import type { ModelAuth } from "@pinomad/host/src/model-auth.ts";
import { connectTo, followFirst, freePort, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { generateKeyPair, keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { HostAuth } from "@pinomad/protocol/auth.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { coding } from "@pinomad/host/src/extensions/coding.ts";
import { createSubagent } from "@pinomad/host/src/extensions/subagent.ts";
import { deriveChat } from "@pinomad/client/cot-view.ts";
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

/**
 * The composer editable by its accessible name, whichever role Astryx gives
 * it: a configured trigger menu (named agents, @ file completion) turns the
 * contenteditable into a combobox — the standard pattern for an input that
 * can pop a listbox — and with no triggers it stays a plain textbox. Which
 * applies depends on host version, scope and agents, so locate by name.
 */
const prompt = (root: Page | Locator): Locator =>
  root.getByRole("textbox", { name: "Prompt" }).or(root.getByRole("combobox", { name: "Prompt" }));

async function openPage(host: OpenedHost, width: number, webOrigin: string) {
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await prompt(page).waitFor();
  return page;
}

/** Opens Settings from the sidebar's user bar and picks a section in its nav (wide screens). */
async function openSettings(page: Page, section: string): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: section, exact: true }).click();
  return dialog;
}

/** The host menu in the user bar: each paired host's name with its status. */
async function openHostsMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
}

/**
 * A localStorage-backed stand-in for the Electron preload bridge, so the
 * paired-host list survives the page reloads that switch hosts.
 */
async function stubDesktopBridge(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const KEY = "test.desktopHosts";
    const read = (): { hostKey: string }[] => JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const write = (hosts: { hostKey: string }[]): void => {
      localStorage.setItem(KEY, JSON.stringify(hosts));
    };
    (window as unknown as { pinomadDesktop: unknown }).pinomadDesktop = {
      hosts: {
        list: () => Promise.resolve(read()),
        save: (host: { hostKey: string }) => {
          write([...read().filter((each) => each.hostKey !== host.hostKey), host]);
          return Promise.resolve();
        },
        remove: (hostKey: string) => {
          write(read().filter((each) => each.hostKey !== hostKey));
          return Promise.resolve();
        },
        setName: (hostKey: string, name: string) => {
          const hosts = read() as { hostKey: string; name?: string }[];
          const index = hosts.findIndex((each) => each.hostKey === hostKey);
          if (index !== -1) write(hosts.map((each) => (each.hostKey === hostKey ? { ...each, name } : each)));
          return Promise.resolve();
        },
      },
      // The real preload answers this from main; the stub stands in for it.
      deviceName: () => Promise.resolve("Linux Desktop (test-box)"),
    };
  });
}

/** How many hosts the stubbed desktop bridge currently holds. */
const storedHostCount = (page: Page): Promise<number> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem("test.desktopHosts") ?? "[]") as unknown[]).length);

/** The conversation's own pi.user contents, oldest first, read off the harness. */
async function userContentsOf(host: OpenedHost, id: ConversationId): Promise<unknown[]> {
  const conversation = (await host.harness.conversation(id, BACKGROUND_CONTEXT))!;
  const items = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items;
  return items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => entry.model![0]!.content)
    .reverse();
}

/** Build a PNG inside the page and dispatch a paste carrying it into the editable. */
async function pasteImage(page: Page, width: number, height: number): Promise<void> {
  await page.evaluate(async ([w, h]) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#2266cc";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const file = new File([blob], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.querySelector('[aria-multiline="true"]')!.dispatchEvent(event);
  }, [width, height] as const);
}

/** Build `count` small PNGs inside the page and drop them on the composer. */
async function dropImages(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const data = new DataTransfer();
    for (let i = 0; i < n; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 40;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = i % 2 === 0 ? "#cc6622" : "#22cc66";
      ctx.fillRect(0, 0, 40, 40);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      data.items.add(new File([blob], `img${i}.png`, { type: "image/png" }));
    }
    document
      .querySelector('[data-slot="prompt-input"]')!
      .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, count);
}

/** The staged-attachment row the composer drawer shows. */
const attachments = (page: Page) => page.locator('[data-testid="composer-attachments"] [role="group"]');

/** A staged image that finished preparing — the pending skeleton has no img. */
const staged = (page: Page, index = 1) => attachments(page).getByRole("img", { name: `Image ${index}` });

/** Every node in an organized view, top-level and nested. */
const allNodes = (view: { organized: { chats: readonly ConversationNode[]; projects: readonly { conversations: readonly ConversationNode[] }[] } }): ConversationNode[] => {
  const flat = (nodes: readonly ConversationNode[]): ConversationNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)]);
  return flat(view.organized.chats.concat(...view.organized.projects.map((entry) => entry.conversations)));
};

/**
 * Drive the folder picker to an absolute path: "Parent folder" climbs to "/",
 * then each segment's row steps down. The footer's path is the settle check —
 * the next row is only clicked once its parent listing has actually landed.
 */
async function pickFolder(page: Page, target: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  const pathText = dialog.getByTestId("picker-path");
  const up = dialog.getByRole("button", { name: "Parent folder", exact: true });
  await pathText.waitFor();
  for (;;) {
    const current = await pathText.textContent();
    if (current === "/") break;
    await up.click();
    await expect.poll(async () => await pathText.textContent()).not.toBe(current);
  }
  let walked = "";
  for (const segment of target.split("/").filter(Boolean)) {
    walked += `/${segment}`;
    await dialog.getByRole("button", { name: segment, exact: true }).click();
    const expected = walked;
    await expect.poll(async () => await pathText.textContent()).toBe(expected);
  }
}

it("opens Settings → Devices from the phone drawer", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 390, webOrigin);

  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // The drawer closed; only the Settings dialog remains.
  await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Devices", { exact: true }).click();
  await dialog.getByRole("button", { name: "Pair a device", exact: true }).waitFor();
});

it("drills into a Settings section from the phone drawer and back out", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path });
  const page = await openPage(host, 390, webOrigin);

  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // The drawer closed; only the Settings dialog's section list remains.
  await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Providers", { exact: true }).waitFor();

  await dialog.getByText("Chats", { exact: true }).click();
  const followUp = dialog.getByRole("radiogroup", { name: "Follow-up messages", exact: true });
  await followUp.waitFor();
  await followUp.getByRole("radio", { name: "All at once", exact: true }).click();

  // The control only moves once the host's settings stream pushes the change.
  await expect.poll(() => followUp.getByRole("radio", { name: "All at once", checked: true }).count()).toBe(1);
  expect(JSON.parse(await readFile(join(dir.path, "settings.json"), "utf8"))).toMatchObject({ followUpMode: "all" });

  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByText("Providers", { exact: true }).waitFor();
});

it("changes a queue-mode setting, then resets it to pi's default", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Chats", exact: true }).click();
  const followUp = dialog.getByRole("radiogroup", { name: "Follow-up messages", exact: true });
  await followUp.waitFor();
  await followUp.getByRole("radio", { name: "All at once", exact: true }).click();

  // The control only moves once the host's settings stream pushes the change.
  await expect.poll(() => followUp.getByRole("radio", { name: "All at once", checked: true }).count()).toBe(1);
  const reset = dialog.getByRole("button", { name: "Use pi's default", exact: true });
  await reset.waitFor();
  expect(JSON.parse(await readFile(join(dir.path, "settings.json"), "utf8"))).toMatchObject({ followUpMode: "all" });

  await reset.click();
  await expect.poll(() => followUp.getByRole("radio", { name: "One at a time", checked: true }).count()).toBe(1);
  await expect.poll(() => dialog.getByRole("button", { name: "Use pi's default", exact: true }).count()).toBe(0);
});

it("opens Settings on Providers and shows host details under About", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // Providers is the default section — the empty-logins state shows right away.
  await dialog.getByText("No stored logins. Log in with the Pi CLI on the host.").waitFor();

  await dialog.getByRole("button", { name: "About", exact: true }).click();
  await dialog.getByText("Data directory", { exact: true }).waitFor();
  await dialog.getByText("settings.json", { exact: false }).waitFor();
  await dialog.getByText("Source checkout", { exact: true }).waitFor();
});

it("logs a stored login out from the Providers section", async () => {
  const webOrigin = await startWeb();
  // A fake ModelAuth: the real auth.json round trip lives in model-auth.test.ts;
  // here the auth stream just needs a login to remove through the real gateway call.
  const auth = new Published<HostAuth>(
    { logins: [{ providerId: "anthropic", name: "Anthropic", kind: "api_key", subscription: false }] },
    (a, b) => a.logins === b.logins,
  );
  const modelAuth: ModelAuth = {
    models: constantValue([]),
    auth,
    async logout(providerId: string) {
      auth.set({ logins: auth.value.logins.filter((login) => login.providerId !== providerId) });
    },
    close() {},
  };
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], modelAuth });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("1 provider logged in").waitFor();
  await dialog.getByRole("button", { name: "Anthropic actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Log out…", exact: true }).click();
  // The menu only arms the card's confirmation; signing out is the second step.
  await dialog.getByText("This also signs the Pi CLI on the host out of Anthropic.").waitFor();
  await dialog.getByRole("button", { name: "Log out", exact: true }).click();
  await dialog.getByText("No stored logins. Log in with the Pi CLI on the host.").waitFor();
});

it("keeps the chat usable on a phone with navigation and the side panel still reachable", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 390, webOrigin);

  const composer = prompt(page);
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
  await page.getByRole("dialog").getByText("No threads yet").waitFor();
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
  await prompt(page).fill("after reconnect");
  await prompt(page).press("Enter");
  await page.getByText("new host answer", { exact: true }).waitFor();
});

it("preserves an unsent follow-up and disables write controls while reconnecting", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["An answer to fork."] });
  const page = await openPage(host, 1280, webOrigin);
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  await prompt(panel).fill("side question");
  await prompt(panel).press("Enter");
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const threadComposer = prompt(panel);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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
  const composer = prompt(page);
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

  await prompt(a).fill("plan and deploy");
  await prompt(a).press("Enter");
  // Page B joins the conversation from the navigation.
  await b.getByRole("button", { name: "plan and deploy", exact: true }).click();

  for (const page of [a, b]) {
    // The list rides under the run in the transcript, once (ADR-0026 §4).
    const todoCard = page.locator('[data-slot="todo-card"]');
    await todoCard.getByText("Investigate the report", { exact: true }).waitFor();
    expect(await todoCard.count()).toBe(1);
    // The pending question renders above the composer in the main column.
    const card = page.getByTestId("pending-questions");
    await card.getByText("Deploy v2.3 now?", { exact: true }).waitFor();
    await expect.poll(() => card.getByRole("button", { name: "Submit", exact: true }).count()).toBe(1);
  }

  await a.getByTestId("pending-questions").getByRole("radio", { name: "Yes", exact: true }).click();
  await a.getByTestId("pending-questions").getByRole("button", { name: "Submit", exact: true }).click();
  // Both pages converge on the stored answer; the turn continues.
  await expect.poll(() => b.getByTestId("pending-questions").count()).toBe(0);
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
  // Malformed or unknown documents are inspectable in the Overview card.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Overview" });
  await panel.getByText("todo.list", { exact: true }).waitFor();
  await panel.getByText("items", { exact: true }).waitFor();
  await panel.getByText('"not-an-array"', { exact: true }).waitFor();
  // The rest of the workbench still works.
  await prompt(page).fill("still alive");
  expect(await prompt(page).textContent()).toBe("still alive");
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
    agentsHome: join(directory.path, "agents-home"),
    models,
    modelSummaries: () => [],
    settingsFallback: {
      defaultModel: () => ({ provider: model.provider, modelId: model.id }),
      defaultThinkingLevel: () => null,
      steeringMode: () => "one-at-a-time",
      followUpMode: () => "one-at-a-time",
    },
    port: 0,
    browserOrigins: [webOrigin],
  });
  defer(() => host.close());
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 390, webOrigin);
  await prompt(page).fill("Investigate the release.");
  await prompt(page).press("Enter");
  // The folded row names the live thinking and carries the clock; the step
  // itself waits behind it.
  await page.getByRole("button", { name: /^Thinking… · \d/ }).waitFor();
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

it("retries a failed run by resubmitting the user message it answered", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: [
      fauxAssistantMessage("boom", { errorMessage: "provider blew up", stopReason: "error" }),
      "recovered",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);
  await prompt(page).fill("go");
  await prompt(page).press("Enter");

  await page.getByText("Run failed", { exact: true }).waitFor();
  const retry = page.getByRole("button", { name: "Retry request", exact: true });
  await retry.waitFor();
  await retry.click();

  // The failed run is excluded from model context, so the transcript honestly
  // reads "go" → failure → "go" → the retried run's answer.
  await page.getByText("recovered", { exact: true }).waitFor();
  await expect.poll(() => page.locator('[data-slot="chat-message-user"]', { hasText: "go" }).count()).toBe(2);
  await expect.poll(() => page.getByRole("button", { name: "Retry request", exact: true }).count()).toBe(0);
});

it("sends a pasted image with a message and shows it in the transcript", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  // One plain first message takes the page from draft into the conversation.
  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await pasteImage(page, 3000, 1000);
  await staged(page).waitFor();
  await prompt(page).fill("look at this");
  await prompt(page).press("Enter");
  // The thumbnail renders off the user entry — its arrival means the
  // host has written it.
  const transcript = page.getByTestId("message-images");
  await transcript.getByRole("button", { name: /Image 1/ }).waitFor();

  const [record] = (await host.harness.commit((tx) => tx.scanConversations({}, 10), BACKGROUND_CONTEXT)).items;
  const contents = await userContentsOf(host, record.id);
  const sent = contents[1] as { type: string; data?: string }[];
  expect(sent.map((block) => block.type)).toEqual(["text", "image"]);
  const size = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    return { width: bitmap.width, height: bitmap.height };
  }, sent[1]!.data!);
  // The 3000×1000 source shrinks to the 1568px cap.
  expect(size.width).toBe(1568);
  expect(Math.abs(size.height - 523)).toBeLessThanOrEqual(1);

  await transcript.getByRole("button", { name: /Image 1/ }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
});

it("keeps at most four dropped images and lets one be removed", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await dropImages(page, 5);
  await expect.poll(() => attachments(page).count()).toBe(4);
  await page.getByRole("alert").waitFor();
  await expect.poll(async () => (await page.getByRole("alert").textContent()) ?? "").toContain(
    "At most 4 images per message",
  );

  await page.getByRole("group", { name: "Image 1" }).getByRole("button").click();
  await expect.poll(() => attachments(page).count()).toBe(3);
});

it("rejects a rapid second add once the four slots are taken", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await dropImages(page, 3);
  await expect.poll(() => attachments(page).count()).toBe(3);
  // Two drops in one dispatch pass: state hasn't flushed, so the second add
  // must still see the slot the first just reserved.
  await page.evaluate(async () => {
    const root = document.querySelector('[data-slot="prompt-input"]')!;
    const files: File[] = [];
    for (const name of ["extra-1", "extra-2"]) {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 40;
      canvas.getContext("2d")!.fillRect(0, 0, 40, 40);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      files.push(new File([blob], `${name}.png`, { type: "image/png" }));
    }
    for (const file of files) {
      const data = new DataTransfer();
      data.items.add(file);
      root.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  });
  await expect.poll(() => attachments(page).count()).toBe(4);
  await expect.poll(async () => (await page.getByRole("alert").textContent()) ?? "").toContain(
    "At most 4 images per message",
  );
});

it("lets a drop that carries only text reach the composer editor", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  const prevented = await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "dropped words");
    const editable = document.querySelector('[aria-multiline="true"]')!;
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
    editable.dispatchEvent(event);
    return event.defaultPrevented;
  });
  // A text drop is the editor's own paste-by-drag; only file drops are ours.
  expect(prevented).toBe(false);
  await expect.poll(() => page.locator('[data-testid="composer-attachments"]').count()).toBe(0);
});

it("creates a conversation from an image-only first message", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await pasteImage(page, 400, 300);
  await staged(page).waitFor();
  await prompt(page).press("Enter");
  await page.getByTestId("message-images").getByRole("button", { name: /Image 1/ }).waitFor();

  const [record] = (await host.harness.commit((tx) => tx.scanConversations({}, 10), BACKGROUND_CONTEXT)).items;
  const contents = await userContentsOf(host, record.id);
  expect((contents[0] as { type: string }[]).map((block) => block.type)).toEqual(["image"]);
});

it("resends the failed prompt's images on retry", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: [
      fauxAssistantMessage("boom", { errorMessage: "provider blew up", stopReason: "error" }),
      "recovered",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await pasteImage(page, 400, 300);
  await staged(page).waitFor();
  await prompt(page).fill("look");
  await prompt(page).press("Enter");
  await page.getByRole("button", { name: "Retry request", exact: true }).waitFor();

  const [record] = (await host.harness.commit((tx) => tx.scanConversations({}, 10), BACKGROUND_CONTEXT)).items;
  const first = (await userContentsOf(host, record.id))[0];

  await page.getByRole("button", { name: "Retry request", exact: true }).click();
  await page.getByText("recovered", { exact: true }).waitFor();

  await expect.poll(async () => (await userContentsOf(host, record.id)).length).toBe(2);
  const contents = await userContentsOf(host, record.id);
  expect(contents[1]).toEqual(first);
});

it("refuses images when the model doesn't accept them", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    fauxModels: [{ id: "faux-text", name: "Faux Text", input: ["text"] }],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitem", { name: /Add images/, disabled: true });
  await item.waitFor();
  await expect.poll(async () => (await item.textContent()) ?? "").toContain("can't see images");
  await page.keyboard.press("Escape");

  await pasteImage(page, 400, 300);
  await expect.poll(async () => (await page.getByRole("alert").textContent()) ?? "").toContain(
    "This model doesn't accept images",
  );
  await expect.poll(() => attachments(page).count()).toBe(0);
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
  await prompt(page).fill("delegate");
  await prompt(page).press("Enter");
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

  // The trailing slot counts the family's subagents (#219) and yields to the
  // … menu on hover, so the two never overlap.
  const subagents = row.locator(".pigui-sidenav-subagent-count");
  await expect.poll(() => subagents.textContent()).toBe("1");
  expect(await subagents.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await row.getByRole("button", { name: "delegate", exact: true }).hover();
  await expect.poll(() => subagents.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  // Still hidden while the menu is open, wherever the pointer goes — today the
  // menu renders inside the row, but a portaled one must not bring it back.
  await row.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).hover();
  await expect.poll(() => subagents.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
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
  const composer = prompt(page);
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
  expect(await prompt(panel).count()).toBe(0);
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
  await prompt(page).fill("fix the notes");
  await prompt(page).press("Enter");
  await page.getByText("edit complete", { exact: true }).waitFor();

  // The model never narrated, so the whole run is one grey row (ADR-0026).
  // Expanded, each round is its own single-call step, and a single-call step
  // expands straight to the detail.
  const trace = page.locator('[data-slot="chat-trace-trigger"]');
  await expect.poll(() => trace.count()).toBe(1);
  await trace.click();
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
  await prompt(page).fill("fix the notes");
  await prompt(page).press("Enter");
  await page.getByText("edit complete", { exact: true }).waitFor();

  await page.locator('[data-slot="chat-trace-trigger"]').click();
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
  expect(await prompt(page).textContent()).toBe("Fix the failing test");
  expect(await prompt(page).evaluate((el) => document.activeElement === el || el.contains(document.activeElement))).toBe(true);
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

  await prompt(page).fill("picked work");
  await prompt(page).press("Enter");
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
  await prompt(page).fill("deep work");
  await prompt(page).press("Enter");
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

  await prompt(page).fill("hello");
  await prompt(page).press("Enter");
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

  // With no projects the section's empty state is an Add project row; the
  // section header's "+" is pinned — visible without hovering.
  const addRow = page.locator("button.astryx-side-nav-item", { hasText: "Add project" });
  await addRow.waitFor();
  // waitFor's default state is "visible": the pinned "+" needs no hover.
  await page
    .locator(".pigui-sidenav-section-header")
    .getByRole("button", { name: "Add project", exact: true })
    .waitFor();

  // Add the project through the folder picker; the draft for it opens right after.
  await addRow.click();
  await pickFolder(page, await realpath(project.path));
  await page.getByRole("dialog").getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("group", { name: projectName }).waitFor();
  await expect.poll(() => page.locator("h1").textContent()).toBe(`New conversation in ${projectName}`);
  await expect.poll(async () => await addRow.count()).toBe(0);
  await prompt(page).fill("project work");
  await prompt(page).press("Enter");
  await page.getByText("project answer", { exact: true }).waitFor();
  const projectSection = page.getByRole("group", { name: projectName });
  await projectSection.getByRole("button", { name: "project work", exact: true }).waitFor();

  // A new chat lands under Chats, then archives away.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect.poll(() => page.locator("h1").textContent()).toBe("New chat");
  await prompt(page).fill("chat work");
  await prompt(page).press("Enter");
  await page.getByText("chat answer", { exact: true }).waitFor();
  const chats = page.getByRole("group", { name: "Chats" });
  await chats.getByRole("button", { name: "chat work", exact: true }).waitFor();
  await chats.getByRole("button", { name: "chat work", exact: true }).hover();
  await chats.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect.poll(() => chats.getByRole("button", { name: "chat work", exact: true }).count()).toBe(0);

  // Settings → Archived lists it with its home; Restore puts it back in Chats.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Archived", exact: true }).click();
  const archived = settings.getByRole("region", { name: "Archived" });
  await archived.getByText("Chat · now", { exact: true }).waitFor();
  await archived.getByRole("button", { name: "Restore chat work", exact: true }).click();
  await archived.getByText("No archived conversations.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await chats.getByRole("button", { name: "chat work", exact: true }).waitFor();

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

  // "Open in main" promotes the fork: main shows it, the breadcrumb returns.
  await panel.getByRole("button", { name: "Open in main", exact: true }).click();
  await page.getByRole("button", { name: "Back to project work", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "Back to project work", exact: true }).count()).toBe(0);
  await page.getByText("project answer", { exact: true }).waitFor();
});

it("leaves a conversation row's title the full width and reveals … on hover and focus", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["done"] });
  const page = await openPage(host, 1280, webOrigin);
  const title = "a conversation title long enough to be truncated by the sidebar";
  await prompt(page).fill(title);
  await prompt(page).press("Enter");
  await page.getByText("done", { exact: true }).waitFor();

  const chats = page.getByRole("group", { name: "Chats" });
  const row = chats.locator(".pigui-sidenav-session-row");
  const rowButton = chats.getByRole("button", { name: title, exact: true });
  await rowButton.waitFor();

  // No relative-time meta anymore; the spacer reserves one … button, not two.
  expect(await row.locator(".pigui-sidenav-session-meta").count()).toBe(0);
  const widths = await rowButton.evaluate((btn, text) => {
    const label = [...btn.querySelectorAll("span")].find((span) => span.textContent === text);
    return {
      label: label?.getBoundingClientRect().width ?? 0,
      spacer: btn.querySelector(".pigui-sidenav-actions-spacer")?.getBoundingClientRect().width ?? 0,
    };
  }, title);
  expect(widths.spacer).toBeLessThanOrEqual(32);
  // Was ~115px at the default 260px sidebar with the meta + two-button slot.
  expect(widths.label).toBeGreaterThan(150);

  const actions = row.getByRole("button", { name: "Conversation actions", exact: true });
  const hoverActions = row.locator(".pigui-sidenav-hover-actions");
  const opacity = () => hoverActions.evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(opacity).toBe("0");

  // Hover reveals … and it opens the row menu.
  await rowButton.hover();
  await expect.poll(opacity).toBe("1");
  await actions.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
  await page.keyboard.press("Escape");

  // Pointer off and focus out hides it again; keyboard focus brings … back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator("h1").hover();
  await expect.poll(opacity).toBe("0");
  await rowButton.focus();
  await expect.poll(opacity).toBe("1");
});

it("renames a conversation from its sidebar row menu", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["done"] });
  const page = await openPage(host, 1280, webOrigin);
  await prompt(page).fill("hello");
  await prompt(page).press("Enter");
  await page.getByText("done", { exact: true }).waitFor();

  const chats = page.getByRole("group", { name: "Chats" });
  await chats.getByRole("button", { name: "hello", exact: true }).hover();
  await chats.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Title", exact: true });
  await expect.poll(() => input.inputValue()).toBe("hello");
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  // Unchanged or blank is not a rename.
  expect(await save.isDisabled()).toBe(true);
  await input.fill("   ");
  expect(await save.isDisabled()).toBe(true);

  await input.fill("My better name");
  await save.click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  await chats.getByRole("button", { name: "My better name", exact: true }).waitFor();
  await expect.poll(() => page.locator("h1").textContent()).toBe("My better name");
});

it("keeps the side panel closed until asked and keeps it open across conversations", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["first answer", "second answer"] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  const composer = prompt(page);
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
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("No threads yet", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Side panel", exact: true }).getAttribute("aria-pressed")).toBe("true");

  // Switching conversations keeps the panel open.
  await page.getByRole("button", { name: "second chat", exact: true }).click();
  await page.getByText("second answer", { exact: true }).waitFor();
  await panel.getByText("No threads yet", { exact: true }).waitFor();

  // And closes again.
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect.poll(() => page.getByRole("complementary", { name: "Side panel" }).count()).toBe(0);
});

it("puts the conversation title in the header and the path inside the overview", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["an answer"] });
  const page = await openPage(host, 1280, webOrigin);

  const composer = prompt(page);
  await composer.fill("title me");
  await composer.press("Enter");
  await page.getByText("an answer", { exact: true }).waitFor();

  // The header carries the conversation's title — not its path.
  await expect.poll(() => page.locator("h1").textContent()).toBe("title me");
  expect(await page.getByText("/chats/", { exact: false }).count()).toBe(0);

  // The path sits in the Overview card's Workspace section; a Chat
  // conversation has no repository, so no Changes row.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const overview = page.getByRole("complementary", { name: "Overview" });
  await overview.getByText("Workspace", { exact: true }).waitFor();
  await overview.getByText("/chats/", { exact: false }).waitFor();
  expect(await overview.getByRole("button", { name: /Changes/ }).count()).toBe(0);
});

it("summarizes changes and subagents in the overview card and links to their detail", async () => {
  const webOrigin = await startWeb();
  const repo = await tempDir();
  defer(repo.remove);
  const repoName = repo.path.split("/").at(-1)!;
  await run("git", ["-C", repo.path, "init", "-b", "main"]);
  await writeFile(join(repo.path, "tracked.txt"), "a\nb\nc\n");
  await writeFile(join(repo.path, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  await run("git", ["-C", repo.path, "add", "-A"]);
  await run("git", ["-C", repo.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  // Two lines changed, one added: the card sums the patch to +2 −1.
  await writeFile(join(repo.path, "tracked.txt"), "a\nB\nc\nd\n");
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    projects: [repo.path],
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
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: repoName, exact: true }).click();
  await page.getByRole("combobox", { name: "Where to work", exact: true }).click();
  await page.getByRole("option", { name: "Project folder", exact: true }).click();
  await prompt(page).fill("delegate");
  await prompt(page).press("Enter");
  await page.getByText("parent final", { exact: true }).waitFor();

  const toggle = page.getByRole("button", { name: "Overview", exact: true });
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  await toggle.click();
  const overview = page.getByRole("complementary", { name: "Overview" });
  const changes = overview.getByRole("button", { name: /Changes/ });
  await changes.getByLabel("2 added, 1 removed", { exact: true }).waitFor();
  await overview.getByRole("button", { name: "1 done", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  // The Tasks tab's list, grouped by owner.
  await panel.getByText("This conversation", { exact: true }).waitFor();
  await panel.getByText("count the lines", { exact: true }).waitFor();

  await changes.click();
  await page.getByRole("dialog").getByText("tracked.txt", { exact: false }).first().waitFor();
  await page.keyboard.press("Escape");

  // A binary-only change has no text lines but is still a change.
  await run("git", ["-C", repo.path, "checkout", "--", "tracked.txt"]);
  await writeFile(join(repo.path, "logo.bin"), Buffer.from([0, 9, 9, 3]));
  await toggle.click();
  await toggle.click();
  await overview.getByRole("button", { name: /Changes/ }).getByText("1 file", { exact: true }).waitFor();

  // The open state survives a reload (which lands on a draft, where the card
  // has nothing to show); Escape inside the card closes it.
  await page.reload();
  await page.getByRole("button", { name: "delegate", exact: true }).click();
  await overview.waitFor();
  await overview.getByRole("button", { name: /Changes/ }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => overview.count()).toBe(0);
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

  const composer = prompt(page);
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
  const composer = prompt(page);

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

  await prompt(page).fill("hello");
  await prompt(page).press("Enter");
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

  await prompt(page).fill("go");
  await prompt(page).press("Enter");
  // Wait for the live composer (the draft's input would eat the fill otherwise)
  // and for the run to be provably busy.
  await page.getByText("word", { exact: false }).first().waitFor();
  await prompt(page).fill("next task");
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
  await prompt(page).fill("chat hi");
  await prompt(page).press("Enter");
  await page.getByText("chat done", { exact: true }).waitFor();
  await page.getByText("Chat", { exact: true }).waitFor();

  // A repo project defaults to a worktree: "Git worktree" + its pinomad branch.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: repoName, exact: true }).click();
  await page.getByRole("combobox", { name: "Where to work", exact: true }).waitFor();
  await prompt(page).fill("tree hi");
  await prompt(page).press("Enter");
  await page.getByText("tree done", { exact: true }).waitFor();
  await page.getByText("Git worktree", { exact: true }).waitFor();
  await page.getByText(/pinomad\/[0-9]+-[0-9a-f]+/).waitFor();

  // A plain project with "Project folder" works directly in its directory.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: plainName, exact: true }).click();
  await page.getByRole("combobox", { name: "Where to work", exact: true }).click();
  await page.getByRole("option", { name: "Project folder", exact: true }).click();
  await prompt(page).fill("direct hi");
  await prompt(page).press("Enter");
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
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], projects: [project.path] });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // The dock stays closed; a rejected command must still be visible. The
  // draft keeps a removed project's path, so its createConversation call
  // rejects "Unknown project" and the notice becomes a toast.
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: projectName, exact: true }).click();
  await observer.controller.removeProject(project.path);
  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  // Scope to the toast itself: the message also lands in Astryx's hidden
  // assertive live region, making a bare role=alert match ambiguous.
  const toast = page.locator("[data-toast-id]");
  await toast.getByText("Unknown project", { exact: false }).waitFor();

  // An undismissed error toast must not sit over the composer or the header's
  // actions — it would block sending until dismissed. Settle the toast's own
  // animations only: the draft hero's shimmer loops forever.
  await page.waitForFunction(() =>
    document.querySelector("[data-toast-id]")?.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
  );
  const toastBox = (await toast.boundingBox())!;
  const composerBox = (await prompt(page).boundingBox())!;
  const dockBox = (await page.getByRole("button", { name: "Side panel", exact: true }).boundingBox())!;
  const intersects = (a: typeof toastBox, b: typeof toastBox) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  expect(intersects(toastBox, composerBox)).toBe(false);
  expect(intersects(toastBox, dockBox)).toBe(false);
});

it("keeps the Add project picker open with the host's error on failure", async () => {
  const webOrigin = await startWeb();
  const parent = await tempDir();
  defer(parent.remove);
  await mkdir(join(parent.path, "victim"));
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  await page.locator(".pigui-sidenav-section-header").getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const victim = join(await realpath(parent.path), "victim");
  await pickFolder(page, victim);

  // The folder is gone by the time addProject reaches the host — the error
  // stays inline in the dialog and never becomes a toast.
  await rm(victim, { recursive: true, force: true });
  await dialog.getByRole("button", { name: "Add project", exact: true }).click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor();
  expect(await alert.textContent()).toContain("No such directory");
  await expect.poll(() => page.locator("[data-toast-id]").count()).toBe(0);
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
  const composer = prompt(page);
  await composer.waitFor();
  await composer.fill("hello from phone");
  await composer.press("Enter");
  await page.getByText("paired answer", { exact: true }).waitFor();
  expect(page.url()).not.toContain("#pair=");

  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
  expect(tokenClient.view.current().devices[0]!.name).toBe("Android Chrome");

  // The stored device reconnects without a fragment.
  await page.goto(`${webOrigin}/`);
  await prompt(page).waitFor();

  // Revocation drops the client into the rejected state; forgetting shows the entry screen.
  await tokenClient.controller.revokeDevice(tokenClient.view.current().devices[0]!.publicKey);
  await page.getByText("paired with the host, or was revoked", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Forget this host", exact: true }).click();
  await page.getByText("No host link", { exact: true }).waitFor();
});

it("manages paired devices from Settings → Devices", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], remote: { port: await freePort() } });
  const tokenClient = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  const dialog = await openSettings(page, "Devices");
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

it("registers the desktop bridge's device name and shows the pairing minute", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  await stubDesktopBridge(context);
  const page = await context.newPage();

  // Pairing over the stubbed bridge registers its name, not the browser UA's.
  await page.goto(webOrigin);
  await page.getByLabel("Pairing link").fill(pairingUrl);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await prompt(page).waitFor();
  await waitForView(tokenClient.view, (view) => view.devices.length === 1);
  expect(tokenClient.view.current().devices[0]!.name).toBe("Linux Desktop (test-box)");

  // The Devices row carries the pairing time down to the minute.
  const dialog = await openSettings(page, "Devices");
  await dialog.getByText("Linux Desktop (test-box)", { exact: true }).waitFor();
  await dialog.getByText(/Paired.*\d{1,2}:\d{2}/).waitFor();
});

it("explains a loopback pairing link instead of drawing an unusable QR", async () => {
  const webOrigin = await startWeb();
  // No remote access: the offer points at 127.0.0.1, which a phone's camera
  // could never reach — Settings → Devices must say so instead of showing a QR.
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const page = await openPage(host, 1280, webOrigin);

  const dialog = await openSettings(page, "Devices");
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
  const composer = prompt(page);
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
  await prompt(page).waitFor();
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
  await prompt(page).waitFor();
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
  await prompt(page).waitFor();

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
  await prompt(first).waitFor();
  await prompt(first).fill("hello");
  await prompt(first).press("Enter");
  await first.getByText("paired answer", { exact: true }).waitFor();
  const savedKey = await first.evaluate(
    () => (JSON.parse(localStorage.getItem("pinomad.hosts")!) as { privateKey: string }[])[0]!.privateKey,
  );

  // Same context, the now-spent link: a fresh load like scanning the QR again.
  const again = await context.newPage();
  await again.goto(pairLink);
  await again.getByRole("button", { name: "Pair", exact: true }).click();
  await prompt(again).waitFor();
  expect(again.url()).not.toContain("#pair=");
  const afterKey = await again.evaluate(
    () => (JSON.parse(localStorage.getItem("pinomad.hosts")!) as { privateKey: string }[])[0]!.privateKey,
  );
  expect(afterKey).toBe(savedKey);

  await prompt(again).fill("hi again");
  await prompt(again).press("Enter");
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
  await prompt(first).waitFor();
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
  await prompt(first).waitFor();
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

  // Real scroll gestures must bring the recovery button into view. The hosts
  // list below it makes the page taller still, so step instead of jumping to
  // the bottom.
  await page.mouse.move(140, 110);
  const inView = async (): Promise<boolean> => {
    const box = await button.boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= 220;
  };
  for (let step = 0; step < 20 && !(await inView()); step++) {
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(50);
  }
  expect(await inView()).toBe(true);
  expect(
    await page.evaluate(() => Array.from(document.querySelectorAll("#root div")).some((d) => d.scrollTop > 0)),
  ).toBe(true);

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

  const composer = prompt(page);
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
  const composer = prompt(page);
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

it("switches between paired hosts on the desktop bridge", async () => {
  const webOrigin = await startWeb();
  // Each host carries a settings.json name — the switcher labels stored
  // entries by machine name once the settings stream lands (5.12).
  const dirA = await tempDir();
  defer(dirA.remove);
  const dirB = await tempDir();
  defer(dirB.remove);
  await writeFile(join(dirA.path, "settings.json"), JSON.stringify({ hostName: "Host A" }));
  await writeFile(join(dirB.path, "settings.json"), JSON.stringify({ hostName: "Host B" }));
  const hostA = await startFauxHost(defer, { dataDir: dirA.path, browserOrigins: [webOrigin], answers: ["host A answer"] });
  const hostB = await startFauxHost(defer, { dataDir: dirB.path, browserOrigins: [webOrigin], answers: ["host B answer"] });
  const tokenA = await connectTo(defer, hostA);
  const tokenB = await connectTo(defer, hostB);
  const { url: pairA } = await tokenA.controller.createPairing();
  const { url: pairB } = await tokenB.controller.createPairing();
  const labelA = "Host A";
  const labelB = "Host B";

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  await stubDesktopBridge(context);
  const page = await context.newPage();
  // Pairing must mount the client exactly once: saving the host clears the
  // fragment, and re-resolving the address mid-flight would mount a second
  // client. StrictMode double-runs the mount effect in dev, so one mount is
  // two sockets here (the first is cancelled); a remount doubles that again.
  const sockets = { a: 0, b: 0 };
  page.on("websocket", (ws) => {
    if (ws.url() === `${hostA.url}/secure`) sockets.a += 1;
    if (ws.url() === `${hostB.url}/secure`) sockets.b += 1;
  });

  // Pair host A by pasting its loopback link.
  await page.goto(webOrigin);
  // On the desktop bridge the empty screen leads with account sign-in; the
  // pairing-link form sits under it.
  await page.getByLabel("Pairing link").waitFor();
  await page.getByLabel("Pairing link").fill(pairA);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const composer = prompt(page);
  await composer.waitFor();
  await composer.fill("hello A");
  await composer.press("Enter");
  await page.getByText("host A answer", { exact: true }).waitFor();
  expect(sockets.a).toBe(2);

  // Pair host B from Settings → Hosts — a second pairing never warns about
  // replacing in multi-host mode.
  const dialog = await openSettings(page, "Hosts");
  await dialog.getByLabel("Pairing link").fill(pairB);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Pair with this host?").waitFor();
  expect(await page.getByText("Replaces your current pairing").count()).toBe(0);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await composer.waitFor();
  await composer.fill("hello B");
  await composer.press("Enter");
  await page.getByText("host B answer", { exact: true }).waitFor();
  await waitForView(tokenB.view, (view) => view.devices.length === 1);
  expect(sockets.b).toBe(2);

  // The host menu lists both hosts with their status; selecting A reconnects
  // to it (the "hello A" conversation only exists on A).
  await openHostsMenu(page);
  await page.getByRole("menuitem", { name: `${labelB} (connected)`, exact: true }).waitFor();
  await page.getByRole("menuitem", { name: `${labelA} (not connected)`, exact: true }).click();
  await page.getByRole("button", { name: "hello A", exact: true }).waitFor();
  expect(sockets.a).toBe(4);

  // A dead host lands on a failure screen that still lists the hosts.
  await hostB.close();
  await openHostsMenu(page);
  await page.getByRole("menuitem", { name: `${labelB} (not connected)`, exact: true }).click();
  await page.getByText("Could not connect to the host", { exact: true }).waitFor();
  await page.getByRole("button", { name: `Switch to ${labelA}`, exact: true }).click();
  await page.getByRole("button", { name: "hello A", exact: true }).waitFor();
  expect(sockets.a).toBe(6);
});

it("forgets a host from Settings → Hosts only after confirmation", async () => {
  const webOrigin = await startWeb();
  // Named like the switch test above: labels are the announced machine names.
  const dirA = await tempDir();
  defer(dirA.remove);
  const dirB = await tempDir();
  defer(dirB.remove);
  await writeFile(join(dirA.path, "settings.json"), JSON.stringify({ hostName: "Host A" }));
  await writeFile(join(dirB.path, "settings.json"), JSON.stringify({ hostName: "Host B" }));
  const hostA = await startFauxHost(defer, { dataDir: dirA.path, browserOrigins: [webOrigin], answers: ["host A answer"] });
  const hostB = await startFauxHost(defer, { dataDir: dirB.path, browserOrigins: [webOrigin], answers: ["host B answer"] });
  const tokenA = await connectTo(defer, hostA);
  const tokenB = await connectTo(defer, hostB);
  const { url: pairA } = await tokenA.controller.createPairing();
  const { url: pairB } = await tokenB.controller.createPairing();
  const labelA = "Host A";
  const labelB = "Host B";

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  await stubDesktopBridge(context);
  const page = await context.newPage();

  // Pair A by pasting its loopback link, then B from Settings → Hosts — the
  // workbench now sits on B.
  await page.goto(webOrigin);
  await page.getByLabel("Pairing link").fill(pairA);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await prompt(page).waitFor();
  const pairDialog = await openSettings(page, "Hosts");
  await pairDialog.getByLabel("Pairing link").fill(pairB);
  await pairDialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await prompt(page).waitFor();
  expect(await storedHostCount(page)).toBe(2);

  // Cancelling the confirmation touches nothing: still on B, both stored.
  const settings = await openSettings(page, "Hosts");
  await settings.getByRole("button", { name: `Forget ${labelB}…`, exact: true }).click();
  const confirm = settings.getByRole("group", { name: `Forget ${labelB}?`, exact: true });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => confirm.count()).toBe(0);
  expect(await storedHostCount(page)).toBe(2);
  await settings.getByRole("button", { name: `Switch to ${labelA}`, exact: true }).waitFor();

  // Confirming forgets B: the reload lands on A, the only host left.
  await settings.getByRole("button", { name: `Forget ${labelB}…`, exact: true }).click();
  await settings.getByRole("button", { name: "Forget this host", exact: true }).click();
  await openHostsMenu(page);
  await page.getByRole("menuitem", { name: `${labelA} (connected)`, exact: true }).waitFor();
  await page.keyboard.press("Escape");
  expect(await storedHostCount(page)).toBe(1);
  await prompt(page).fill("hello again");
  await prompt(page).press("Enter");
  await page.getByText("host A answer", { exact: true }).waitFor();

  // Forgetting under a live #token fragment must not resurrect the fragment's
  // address: clearing it before the reload is what lets the emptied list land
  // on the no-link screen (the pairing-link form only exists there).
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(hostB.token)}&url=${encodeURIComponent(hostB.url)}`);
  await prompt(page).waitFor();
  const lastSettings = await openSettings(page, "Hosts");
  await lastSettings.getByRole("button", { name: `Forget ${labelA}…`, exact: true }).click();
  await lastSettings.getByRole("button", { name: "Forget this host", exact: true }).click();
  await page.getByLabel("Pairing link").waitFor();
  expect(await storedHostCount(page)).toBe(0);
});

it("warns and retries when saving a pairing fails on the desktop bridge", async () => {
  const webOrigin = await startWeb();
  const hostA = await startFauxHost(defer, { browserOrigins: [webOrigin], answers: ["host A answer"] });
  const tokenA = await connectTo(defer, hostA);
  const { url: pairA } = await tokenA.controller.createPairing();

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  // The preload-bridge stand-in, but save() rejects until the test allows it.
  await context.addInitScript(() => {
    const KEY = "test.desktopHosts";
    let failSaves = true;
    const read = (): { hostKey: string }[] => JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const write = (hosts: { hostKey: string }[]): void => {
      localStorage.setItem(KEY, JSON.stringify(hosts));
    };
    (window as unknown as { pinomadDesktop: unknown }).pinomadDesktop = {
      hosts: {
        list: () => Promise.resolve(read()),
        save: (host: { hostKey: string }) => {
          if (failSaves) return Promise.reject(new Error("keychain locked"));
          write([...read().filter((each) => each.hostKey !== host.hostKey), host]);
          return Promise.resolve();
        },
        remove: (hostKey: string) => {
          write(read().filter((each) => each.hostKey !== hostKey));
          return Promise.resolve();
        },
        setName: (hostKey: string, name: string) => {
          write(read().map((each) => (each.hostKey === hostKey ? { ...each, name } : each)));
          return Promise.resolve();
        },
      },
    };
    (window as unknown as { testAllowSaves: () => void }).testAllowSaves = () => {
      failSaves = false;
    };
  });
  const page = await context.newPage();
  const sockets = { a: 0 };
  page.on("websocket", (ws) => {
    if (ws.url() === `${hostA.url}/secure`) sockets.a += 1;
  });

  await page.goto(webOrigin);
  // On the desktop bridge the empty screen leads with account sign-in; the
  // pairing-link form sits under it.
  await page.getByLabel("Pairing link").waitFor();
  await page.getByLabel("Pairing link").fill(pairA);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const composer = prompt(page);
  await composer.waitFor();
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByText("host A answer", { exact: true }).waitFor();

  // The workbench stays connected — only persisting the pairing failed.
  const banner = page.getByText("This pairing wasn't saved", { exact: true });
  await banner.waitFor();
  expect(sockets.a).toBe(2);

  await page.evaluate(() => (window as unknown as { testAllowSaves: () => void }).testAllowSaves());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => banner.count()).toBe(0);

  // The retried save persisted the very identity the host registered.
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem("test.desktopHosts") ?? "[]") as { privateKey: string }[],
  );
  expect(saved).toHaveLength(1);
  await waitForView(tokenA.view, (view) => view.devices.length === 1);
  expect(toBase64Url(keyPairFromPrivate(fromBase64Url(saved[0]!.privateKey)).publicKey)).toBe(
    tokenA.view.current().devices[0]!.publicKey,
  );
});

// A preload-bridge stand-in with an `updates` member the test steers through
// `__setUpdateStatus`; `__updateCalls` records every invoke.
const fakeUpdatesBridge = `{
  const KEY = "test.desktopHosts";
  const calls = [];
  const listeners = new Set();
  let status = { state: "idle", currentVersion: "0.1.0" };
  const w = window;
  w.__updateCalls = calls;
  w.__setUpdateStatus = (next) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  const read = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
  const write = (hosts) => {
    localStorage.setItem(KEY, JSON.stringify(hosts));
  };
  w.pinomadDesktop = {
    hosts: {
      list: () => Promise.resolve(read()),
      save: (host) => {
        write([...read().filter((each) => each.hostKey !== host.hostKey), host]);
        return Promise.resolve();
      },
      remove: (hostKey) => {
        write(read().filter((each) => each.hostKey !== hostKey));
        return Promise.resolve();
      },
      setName: (hostKey, name) => {
        write(read().map((each) => (each.hostKey === hostKey ? { ...each, name } : each)));
        return Promise.resolve();
      },
    },
    updates: {
      status: () => Promise.resolve().then(() => status),
      check: () => {
        calls.push("check");
        return Promise.resolve().then(() => status);
      },
      install: () => {
        calls.push("install");
        return Promise.resolve().then(() => status);
      },
      onStatus: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}`;

it("marks Settings when the desktop bridge has an update downloaded and restarts from Settings → Updates", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  await context.addInitScript(fakeUpdatesBridge);
  const page = await context.newPage();
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await prompt(page).waitFor();

  // Nothing until the download completes; the sidebar never carries the button itself.
  expect(await page.getByRole("img", { name: "Update ready" }).count()).toBe(0);
  await page.evaluate(
    () => (window as unknown as { __setUpdateStatus: (s: unknown) => void }).__setUpdateStatus({
      state: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
    }),
  );
  await page.getByRole("img", { name: "Update ready" }).waitFor();
  expect(await page.getByText("Restart to update", { exact: true }).count()).toBe(0);
  await page.screenshot({ path: "/tmp/pinomad-update-ready-sidebar.png" });
  const settings = await openSettings(page, "Updates");
  await settings.getByText("PiNomad 0.1.0", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Restart to update", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __updateCalls: string[] }).__updateCalls)).toContain(
    "install",
  );
});

it("checks for updates instead of reloading on a desktop client-older mismatch", async () => {
  const webOrigin = await startWeb();
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });

  const browser = await chromium.launch();
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  defer(() => context.close());
  await context.addInitScript(fakeUpdatesBridge);
  // Bump the hello's protocol major so the host looks newer than this client.
  // The token path sends frames in plaintext; the secure channel's encrypted
  // blobs fail JSON.parse and pass through untouched.
  await context.addInitScript(() => {
    const Native = window.WebSocket;
    class Rewriting extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
      }
      set onmessage(fn: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
        super.onmessage =
          fn === null
            ? null
            : (event: MessageEvent) => {
                let data = event.data;
                if (typeof data === "string" && data.includes('"hello"')) {
                  try {
                    const frame = JSON.parse(data) as { type?: string; protocol?: { major: number } };
                    if (frame.type === "hello" && frame.protocol) {
                      frame.protocol = { ...frame.protocol, major: frame.protocol.major + 1 };
                      data = JSON.stringify(frame);
                    }
                  } catch {
                    // Not a JSON frame — pass it through.
                  }
                }
                fn.call(this, new MessageEvent("message", { data }));
              };
      }
      get onmessage() {
        return super.onmessage;
      }
    }
    window.WebSocket = Rewriting;
  });
  const page = await context.newPage();
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);

  await page.getByText("Client out of date", { exact: true }).waitFor();
  // The desktop bundle is local: an update check fires instead of the
  // reload-once the browser would take, so the marker never lands.
  expect(await page.evaluate(() => sessionStorage.getItem("pinomad.reloadedForProtocol"))).toBeNull();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __updateCalls: string[] }).__updateCalls))
    .toContain("check");

  await page.evaluate(
    () => (window as unknown as { __setUpdateStatus: (s: unknown) => void }).__setUpdateStatus({
      state: "downloading",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 40,
    }),
  );
  await page.getByText(/Downloading PiNomad 0\.2\.0/).waitFor();
  await page.screenshot({ path: "/tmp/pinomad-mismatch-downloading.png" });

  await page.evaluate(
    () => (window as unknown as { __setUpdateStatus: (s: unknown) => void }).__setUpdateStatus({
      state: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
    }),
  );
  await page.getByRole("button", { name: "Restart to update" }).waitFor();
  await page.screenshot({ path: "/tmp/pinomad-mismatch-ready.png" });
});

it("manages named agents from the Agents settings section", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await settings.getByText("No named agents yet.", { exact: true }).waitFor();

  // Create: name, description, a pinned model and level, a prompt.
  await settings.getByRole("button", { name: "New agent", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New agent" });
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("reviewer");
  await editor.getByRole("textbox", { name: "Description", exact: true }).fill("Reviews code");
  await editor.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Faux Thinker (faux/faux-thinker)", exact: true }).click();
  await editor.getByRole("combobox", { name: "Thinking level", exact: true }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await editor.getByRole("textbox", { name: "Prompt", exact: true }).fill("Be strict.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();

  // The card appears only once the host's agents stream pushes the write.
  const card = settings.getByRole("heading", { name: "reviewer", exact: true });
  await card.waitFor();
  const cardBox = settings.locator("div").filter({ has: card }).last();
  const file = join(dir.path, "agents", "reviewer.md");
  const text = await readFile(file, "utf8");
  expect(text).toContain('description: "Reviews code"');
  expect(text).toContain('model: "faux/faux-thinker"');
  expect(text).toContain('thinkingLevel: "high"');
  expect(text).toContain("Be strict.");
  await settings.getByText("Faux Thinker", { exact: true }).waitFor();
  await settings.getByText("High", { exact: true }).waitFor();

  // Edit: the name stays the file name; the description updates the file and card.
  await settings.getByRole("button", { name: "reviewer actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit reviewer" });
  expect(await editDialog.getByRole("textbox", { name: "Name", exact: true }).isDisabled()).toBe(true);
  await editDialog.getByRole("textbox", { name: "Description", exact: true }).fill("Reviews pull requests");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await settings.getByText("Reviews pull requests", { exact: true }).waitFor();
  expect(await readFile(file, "utf8")).toContain('description: "Reviews pull requests"');

  // Delete: the menu arms the confirm inside the card, then both vanish.
  await settings.getByRole("button", { name: "reviewer actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
  await settings.getByText("Conversations already using this agent keep their copy.", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Delete", exact: true }).click();
  await settings.getByText("No named agents yet.", { exact: true }).waitFor();
  await expect.poll(async () => (await import("node:fs")).existsSync(file)).toBe(false);
});

it("shows the agent editor's name rule and the host's already-exists error inline", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await settings.getByRole("button", { name: "New agent", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New agent" });

  // A bad name trips the shared rule without touching the host.
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Reviewer");
  await editor.getByRole("textbox", { name: "Description", exact: true }).fill("d");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByText("Name must be lowercase letters, digits and hyphens (max 32)", { exact: true }).waitFor();
  await expect
    .poll(async () => (await import("node:fs/promises")).readdir(join(dir.path, "agents")))
    .toEqual([]);

  // A duplicate name passes the shape check and surfaces the host's error.
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("reviewer");
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Existing"\n---\n\nx\n');
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByText('Agent "reviewer" already exists', { exact: true }).waitFor();
});

it("lists a hand-written agent file live and reports a bad one as a problem", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await settings.getByText("No named agents yet.", { exact: true }).waitFor();

  // Hand-written files stream in without a reload.
  await writeFile(
    join(dir.path, "agents", "planner.md"),
    '---\ndescription: "Plans work"\nmodel: "nope/missing"\n---\n\nPlan it.\n',
  );
  await settings.getByRole("heading", { name: "planner", exact: true }).waitFor();
  await settings.getByText("Plans work", { exact: true }).waitFor();
  await settings.getByText("Model not available", { exact: true }).waitFor();

  await writeFile(join(dir.path, "agents", "bad-field.md"), '---\ndescription: "d"\ntools: read\n---\n\nx\n');
  await settings.getByRole("heading", { name: "bad-field.md", exact: true }).waitFor();
  await settings.getByText("Not loaded", { exact: true }).waitFor();
  await settings.getByText('Unknown field "tools"', { exact: true }).waitFor();
  await settings.getByText("Fix this file on the host.", { exact: true }).waitFor();
});

it("keeps a pinned thinking level the model no longer supports visible in the editor", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  // faux-1 reports only "off" — the file pins a level it can't take.
  await writeFile(
    join(dir.path, "agents", "legacy.md"),
    '---\ndescription: "Old pin"\nmodel: "faux/faux-1"\nthinkingLevel: "high"\n---\n\nPrompt.\n',
  );
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
  });
  const page = await openPage(host, 1280, webOrigin);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await settings.getByRole("heading", { name: "legacy", exact: true }).waitFor();

  await settings.getByRole("button", { name: "legacy actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit legacy" });
  // The pinned level is visible as an option it is, not silently dropped.
  const levelPicker = editor.getByRole("combobox", { name: "Thinking level", exact: true });
  await expect.poll(async () => levelPicker.textContent()).toContain("High (not supported by this model)");

  // Saving an unrelated change keeps the pin the file had.
  await editor.getByRole("textbox", { name: "Description", exact: true }).fill("New description");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await settings.getByText("New description", { exact: true }).waitFor();
  const text = await readFile(join(dir.path, "agents", "legacy.md"), "utf8");
  expect(text).toContain('description: "New description"');
  expect(text).toContain('thinkingLevel: "high"');
});

it("lists named agents in a @ mention menu and inserts @name as plain text", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // With no agent files the editable stays a plain textbox — no empty popup.
  const plain = page.getByRole("textbox", { name: "Prompt" });
  await plain.click();
  await plain.pressSequentially("@");
  await expect.poll(() => page.getByRole("listbox").count()).toBe(0);
  await plain.pressSequentially("x");

  // Hand-written files stream in; the editable becomes a combobox.
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Reviews code"\n---\n\nBe strict.\n');
  await writeFile(join(dir.path, "agents", "planner.md"), '---\ndescription: "Plans work"\n---\n\nPlan it.\n');
  const editable = page.getByRole("combobox", { name: "Prompt" });
  await editable.waitFor();
  await editable.click();

  // Clear the typed "@x", then query the menu.
  await editable.press("ControlOrMeta+a");
  await editable.press("Delete");
  await editable.pressSequentially("@rev");
  const menu = page.getByRole("listbox", { name: "Named agents" });
  await menu.waitFor();
  await menu.getByRole("option", { name: /reviewer/ }).waitFor();
  await expect.poll(() => menu.getByRole("option").count()).toBe(1);

  // Enter selects the highlighted item — nothing is submitted.
  await editable.press("Enter");
  await expect.poll(() => menu.count()).toBe(0);
  await expect.poll(async () => editable.textContent()).toBe("@reviewer ");

  await editable.pressSequentially("check auth");
  await editable.press("Enter");
  await page.getByText(LONG_ANSWER, { exact: true }).waitFor();
  const id = await followFirst(observer);
  await expect.poll(async () => userContentsOf(host, id)).toEqual(["@reviewer check auth"]);
});

it("shows the @ mention menu in a fork thread composer too", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Reviews code"\n---\n\nBe strict.\n');
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    answers: ["first answer", "fork answer"],
  });
  const page = await openPage(host, 1280, webOrigin);
  const mainComposer = page.getByRole("combobox", { name: "Prompt" });
  await mainComposer.fill("start");
  await mainComposer.press("Enter");
  await page.getByText("first answer", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();

  const threadComposer = panel.getByRole("combobox", { name: "Prompt" });
  await threadComposer.click();
  await threadComposer.pressSequentially("@rev");
  const menu = page.getByRole("listbox", { name: "Named agents" });
  await menu.waitFor();
  await menu.getByRole("option", { name: /reviewer/ }).waitFor();
  await threadComposer.press("Enter");
  await expect.poll(async () => threadComposer.textContent()).toBe("@reviewer ");
});

it("shows the named agent a subagent ran as on its done card", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Reviews code"\n---\n\nBe strict.\n');
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    extensions: (provided: { models: Models; modelSummaries: () => readonly ModelSummary[]; agentRoles: AgentRoleStore }) => [
      createSubagent({
        models: provided.models,
        modelSummaries: provided.modelSummaries,
        roles: () => provided.agentRoles.value.roles,
        exclude: [],
      }),
    ],
    answers: [
      fauxAssistantMessage(fauxToolCall("subagent", { task: "count the lines", role: "reviewer" }), { stopReason: "toolUse" }),
      "child answer",
      "parent final",
    ],
  });
  const page = await openPage(host, 1280, webOrigin);
  await page.getByRole("combobox", { name: "Prompt" }).fill("delegate");
  await page.getByRole("combobox", { name: "Prompt" }).press("Enter");
  await page.getByText("parent final", { exact: true }).waitFor();

  const card = page.locator('[data-slot="subagent-card"][data-status="done"]');
  await card.waitFor();
  await card.getByText(/Done · @reviewer · faux\/faux-1 · \d+s/).waitFor();
});


// Astryx's Popover ignores a trigger click within ~50ms of a hide — the guard
// exists so the light-dismiss click landing on the trigger doesn't reopen it,
// but it swallows any immediate reopen. Outside click + a beat is the reliable
// way to close one capsule's menu and open another.
const dismissPopovers = async (page: Page): Promise<void> => {
  await page.locator("h1").click();
  await page.waitForTimeout(100);
};

it("creates the draft with a named agent and shows @name on the conversation and its forks", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(
    join(dir.path, "agents", "reviewer.md"),
    '---\ndescription: "Reviews code"\nmodel: "faux/faux-thinker"\nthinkingLevel: "high"\n---\n\nBe strict.\n',
  );
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
    ],
    answers: ["reviewed", "fork answer"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  // The agent capsule lists the host's roles; picking one shows the inherited pick.
  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^reviewer/ }).click();
  const capsule = page.getByTestId("model-thinking-trigger");
  await expect.poll(() => capsule.textContent()).toContain("Faux Thinker · High");
  await expect.poll(() => capsule.textContent()).toContain("from @reviewer");
  await dismissPopovers(page);

  const composer = page.getByRole("combobox", { name: "Prompt" });
  await composer.fill("check this");
  await composer.press("Enter");
  await page.getByText("reviewed", { exact: true }).waitFor();

  // The draft sent only `agent` — the role's pins resolved host-side, not the
  // draft's remembered (default) pick.
  await expect.poll(async () => {
    const id = observer.view.current().organized.chats.find((node) => node.summary.title === "check this")?.summary.id;
    if (id === undefined) return undefined;
    const agent = await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    return `${agent?.model?.provider}/${agent?.model?.modelId}:${agent?.thinkingLevel}`;
  }).toBe("faux/faux-thinker:high");

  // The header names the agent next to the title, top-level…
  await page.locator("h1").getByText("@reviewer", { exact: true }).waitFor();

  // …and so does a fork, both in the Threads list and on the fork's own header.
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("fork answer", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Back to threads", exact: true }).click();
  const row = panel.getByRole("button", { name: /Continue from here/ });
  await row.getByText("@reviewer", { exact: true }).waitFor();
  await row.click();
  await panel.getByRole("button", { name: "Open in main", exact: true }).click();
  await page.locator("h1").getByText("@reviewer", { exact: true }).waitFor();
});

it("sends only the overridden side once an agent draft's pick is changed", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(
    join(dir.path, "agents", "reviewer.md"),
    '---\ndescription: "Reviews code"\nmodel: "faux/thinker-a"\nthinkingLevel: "high"\n---\n\nBe strict.\n',
  );
  await writeFile(join(dir.path, "agents", "planner.md"), '---\ndescription: "Plans work"\n---\n\nPlan it.\n');
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "thinker-a", name: "Thinker A", reasoning: true },
      { id: "thinker-b", name: "Thinker B", reasoning: true },
    ],
    answers: ["done"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^reviewer/ }).click();
  await dismissPopovers(page);

  // Overriding the model keeps the level inherited — the hint narrows to it.
  const capsule = page.getByTestId("model-thinking-trigger");
  await capsule.click();
  await page.getByRole("button", { name: "Thinker B", exact: false }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).toContain("level from @reviewer");

  const composer = page.getByRole("combobox", { name: "Prompt" });
  await composer.fill("work");
  await composer.press("Enter");
  await page.getByText("done", { exact: true }).waitFor();
  await expect.poll(async () => {
    const id = observer.view.current().organized.chats.find((node) => node.summary.title === "work")?.summary.id;
    if (id === undefined) return undefined;
    const agent = await host.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    return `${agent?.model?.provider}/${agent?.model?.modelId}:${agent?.thinkingLevel}`;
  }).toBe("faux/thinker-b:high");
});

it("resets to inheritance on a new agent and back to the remembered pick on clear", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(
    join(dir.path, "agents", "reviewer.md"),
    '---\ndescription: "Reviews code"\nmodel: "faux/thinker-a"\nthinkingLevel: "high"\n---\n\nBe strict.\n',
  );
  await writeFile(join(dir.path, "agents", "planner.md"), '---\ndescription: "Plans work"\n---\n\nPlan it.\n');
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [
      { id: "faux-1", name: "Faux Model" },
      { id: "thinker-a", name: "Thinker A", reasoning: true },
      { id: "thinker-b", name: "Thinker B", reasoning: true },
    ],
  });
  const page = await openPage(host, 1280, webOrigin);
  const capsule = page.getByTestId("model-thinking-trigger");

  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^reviewer/ }).click();
  await dismissPopovers(page);
  await capsule.click();
  await page.getByRole("button", { name: "Thinker B", exact: false }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).toContain("Thinker B");

  // Switching agents drops the override — planner pins nothing, so the
  // capsule falls back to the host default and reads "from @planner" again.
  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^planner/ }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).toContain("Faux Model");
  await expect.poll(() => capsule.textContent()).toContain("from @planner");

  // Clearing the agent returns to the remembered draft pick, not the agent's.
  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: "No agent", exact: true }).click();
  await dismissPopovers(page);
  await expect.poll(() => page.getByTestId("agent-trigger").textContent()).toContain("No agent");
  await expect.poll(() => capsule.textContent()).toContain("Faux Model");
  await expect.poll(() => capsule.textContent()).not.toContain("from @");

  // Overrides made while an agent was picked never touched the remembered pick.
  await capsule.click();
  await page.getByRole("button", { name: "Thinker B", exact: false }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).toContain("Thinker B");
  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^reviewer/ }).click();
  await dismissPopovers(page);
  await capsule.click();
  await page.getByRole("button", { name: "Thinker A", exact: false }).click();
  await dismissPopovers(page);
  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: "No agent", exact: true }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).toContain("Thinker B");
});

it("blocks the draft send while the agent's model is unavailable and unblocks on an override", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(
    join(dir.path, "agents", "broken.md"),
    '---\ndescription: "Broken pins"\nmodel: "gone/claude-z"\n---\n\nBe strict.\n',
  );
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    fauxModels: [{ id: "faux-1", name: "Faux Model" }],
    answers: ["done"],
  });
  const observer = await connectTo(defer, host);
  const page = await openPage(host, 1280, webOrigin);

  await page.getByTestId("agent-trigger").click();
  await page.getByRole("button", { name: /^broken/ }).click();
  await dismissPopovers(page);
  const capsule = page.getByTestId("model-thinking-trigger");
  await expect.poll(() => capsule.textContent()).toContain("gone/claude-z unavailable");

  const composer = page.getByRole("combobox", { name: "Prompt" });
  await composer.fill("still a draft");
  await composer.press("Enter");
  // The send is blocked: nothing is created and the draft stays put.
  await expect.poll(async () => observer.view.current().organized.chats.length, { timeout: 3000 }).toBe(0);
  await expect.poll(() => composer.textContent()).toBe("still a draft");

  // Overriding the model with an available one clears the problem.
  await capsule.click();
  await page.getByRole("button", { name: "Faux Model", exact: false }).click();
  await dismissPopovers(page);
  await expect.poll(() => capsule.textContent()).not.toContain("unavailable");
  await composer.press("Enter");
  await page.getByText("done", { exact: true }).waitFor();
});

it("completes agents and files in the draft's @ menu, inserting @./path", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Reviews code"\n---\n\nBe strict.\n');
  const project = await tempDir();
  defer(project.remove);
  await mkdir(join(project.path, "src"), { recursive: true });
  await writeFile(join(project.path, "README.md"), "# proj\n");
  await writeFile(join(project.path, "src", "review-notes.ts"), "export const x = 1;\n");
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path, projects: [project.path] });
  const page = await openPage(host, 1280, webOrigin);

  const projectName = project.path.split("/").at(-1)!;
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: projectName, exact: true }).click();

  const composer = page.getByRole("combobox", { name: "Prompt" });
  await composer.click();
  await composer.pressSequentially("@re");
  const menu = page.getByRole("listbox", { name: "Agents and files" });
  await menu.waitFor();
  // The agent answers immediately; the file candidate joins once the listing lands.
  await menu.getByRole("option", { name: /reviewer/ }).waitFor();
  await menu.getByRole("group", { name: "Files" }).getByRole("option", { name: /README\.md|review-notes\.ts/ }).first().waitFor();

  // Selecting the file inserts the `@./path` mention.
  await menu.getByRole("option", { name: /README\.md/ }).click();
  await expect.poll(async () => composer.textContent()).toBe("@./README.md ");
});

it("keeps the agent candidates when the draft's file listing fails", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  await mkdir(join(dir.path, "agents"), { recursive: true });
  await writeFile(join(dir.path, "agents", "reviewer.md"), '---\ndescription: "Reviews code"\n---\n\nBe strict.\n');
  const project = await tempDir();
  defer(project.remove);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dir.path, projects: [project.path] });
  const page = await openPage(host, 1280, webOrigin);

  // A registered project whose directory is gone makes the listing an error.
  await rm(project.path, { recursive: true, force: true });
  const projectName = project.path.split("/").at(-1)!;
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: projectName, exact: true }).click();

  const composer = page.getByRole("combobox", { name: "Prompt" });
  await composer.click();
  await composer.pressSequentially("@rev");
  const menu = page.getByRole("listbox", { name: "Agents and files" });
  await menu.getByRole("option", { name: /reviewer/ }).waitFor();
  // The failed request never clears the agent candidate and no Files group appears.
  await expect.poll(async () => menu.getByRole("option").count(), { timeout: 3000 }).toBe(1);
  expect(await menu.getByRole("group", { name: "Files" }).count()).toBe(0);
});
