// The Web ref path end to end (ADR-0027): a 5.15 connection subscribes to
// conversation streams with `images: "ref"`, so snapshots carry refs instead
// of base64; thumbnails fetch bytes on demand, and a reload refetches them.
// Also covers the queued-edit rule: if any original image cannot load, the
// client must not withdraw the queued message.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { chromium, type Page } from "@playwright/test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { startFauxHost, useCleanups } from "@pinomad/host/test/support.ts";
import { startWeb } from "./support.ts";
import type { OpenedHost } from "@pinomad/host/src/host.ts";

const defer = useCleanups();

const prompt = (root: Page) =>
  root.getByRole("textbox", { name: "Prompt" }).or(root.getByRole("combobox", { name: "Prompt" }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hold the run at the model request until the gate opens. */
function gatedAnswer(gate: Promise<void>): FauxResponseStep {
  return async () => {
    await gate;
    return fauxAssistantMessage("turn done");
  };
}

async function openPage(host: OpenedHost, webOrigin: string, setup?: (page: Page) => Promise<void>): Promise<Page> {
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  await setup?.(page);
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await prompt(page).waitFor();
  return page;
}

/** Build a PNG in the page and paste it into the composer. */
async function pasteImage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2266cc";
    context.fillRect(0, 0, 400, 300);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "shot.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.querySelector('[aria-multiline="true"]')!.dispatchEvent(event);
  });
}

const staged = (page: Page) => page.locator('[data-testid="composer-attachments"] [role="group"]').getByRole("img", { name: "Image 1" });

/** The conversation's own pi.user contents, oldest first. */
async function userContentsOf(host: OpenedHost, id: ConversationId): Promise<unknown[]> {
  const conversation = (await host.harness.conversation(id, BACKGROUND_CONTEXT))!;
  const items = (await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items;
  return items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => entry.model![0]!.content)
    .reverse();
}

type Frame = { type?: string; stream?: string; method?: string; args?: { ref?: string; variant?: string } };

function recordFrame(raw: unknown): Frame | undefined {
  try {
    return JSON.parse(String(raw)) as Frame;
  } catch {
    return undefined;
  }
}

it("serves conversation images by ref, fetches on demand, and survives a reload", async () => {
  const webOrigin = await startWeb(defer);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin] });
  const snapshots: string[] = [];
  const conversationFrames: string[] = [];
  const refCalls: { ref: string; variant?: string }[] = [];
  const page = await openPage(host, webOrigin, async (page) => {
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = recordFrame(payload);
        if (frame?.type === "call" && frame.method === "image" && frame.args?.ref !== undefined) {
          refCalls.push({ ref: frame.args.ref, variant: frame.args.variant });
        }
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = recordFrame(payload);
        if ((frame?.type === "snapshot" || frame?.type === "ops") && frame.stream?.startsWith("conversation:")) {
          conversationFrames.push(String(payload));
          if (frame.type === "snapshot") snapshots.push(String(payload));
        }
      });
    });
  });

  await prompt(page).fill("hi");
  await prompt(page).press("Enter");
  await page.getByText("step-0", { exact: false }).waitFor();

  await pasteImage(page);
  await staged(page).waitFor();
  await prompt(page).fill("look at this");
  await prompt(page).press("Enter");

  const transcript = page.getByTestId("message-images");
  await transcript.getByRole("button", { name: /Image 1/ }).waitFor();
  const image = transcript.getByRole("img", { name: "Image 1" });
  await expect.poll(async () => (await image.getAttribute("src"))?.startsWith("data:image/jpeg;base64,")).toBe(true);

  const [record] = (await host.harness.commit((tx) => tx.scanConversations({}, 10), BACKGROUND_CONTEXT)).items;
  const contents = await userContentsOf(host, record.id);
  const blocks = contents.at(-1) as { type: string; data?: string }[];
  const data = blocks.find((block) => block.type === "image")?.data;
  expect(data).toBeDefined();

  // No conversation frame carries the bytes — neither the snapshot nor a
  // later ops batch may smuggle the base64 back in.
  expect(conversationFrames.length).toBeGreaterThan(0);
  expect(conversationFrames.some((frame) => frame.includes(data!))).toBe(false);
  // The send prefilled the cache, so showing its own upload needed no fetch.
  expect(refCalls).toHaveLength(0);

  // A reload drops the memory cache; the new page must fetch the ref and
  // render it again. It also takes a fresh snapshot, which is where the ref
  // form of the image is observable.
  await page.reload();
  await prompt(page).waitFor();
  await page.getByRole("button", { name: "hi", exact: true }).click();
  await transcript.getByRole("button", { name: /Image 1/ }).waitFor();
  await expect.poll(async () => (await transcript.getByRole("img", { name: "Image 1" }).getAttribute("src"))?.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(refCalls.length).toBeGreaterThan(0);
  expect(refCalls.every((call) => call.variant === "thumbnail")).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.includes('"ref"'))).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.includes(data!))).toBe(false);
});

it("does not withdraw a queued message when its original image cannot load", async () => {
  const webOrigin = await startWeb(defer);
  const gate = deferred();
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    answers: [gatedAnswer(gate.promise), "done"],
  });
  defer(gate.resolve);
  let withdrawals = 0;
  const page = await openPage(host, webOrigin, async (page) => {
    await page.routeWebSocket(
      (url) => url.origin === new URL(host.url).origin,
      (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          const frame = recordFrame(message);
          if (frame?.type === "call" && frame.method === "image" && typeof (frame as { id?: number }).id === "number") {
            // The queued copy's ref is still in the conversation, but the
            // bytes are gone; fail the fetch the way a dropped host would.
            ws.send(JSON.stringify({ type: "result", id: (frame as { id: number }).id, ok: false, error: "host offline" }));
            return;
          }
          if (frame?.type === "call" && frame.method === "withdrawQueued") withdrawals += 1;
          server.send(message);
        });
        server.onMessage((message) => ws.send(message));
      },
    );
  });

  await prompt(page).fill("go");
  await prompt(page).press("Enter");
  await page.getByRole("button", { name: /stop/i, exact: true }).waitFor();

  await pasteImage(page);
  await staged(page).waitFor();
  await prompt(page).fill("edit me");
  await page.getByRole("button", { name: "Follow-up", exact: true }).click();
  const row = page.getByTestId("chat-queued-message").filter({ hasText: "edit me" });
  await row.waitFor();

  // Reload to clear the client cache, so the edit really has to fetch the ref.
  await page.reload();
  await prompt(page).waitFor();
  await page.getByRole("button", { name: "go", exact: true }).click();
  await row.waitFor();
  await row.getByRole("button", { name: "Edit queued message", exact: true }).click();

  await page.locator("[data-toast-id]").getByText("Couldn't load the original images — try again", { exact: true }).waitFor();
  expect(withdrawals).toBe(0);
  await row.waitFor();
});
