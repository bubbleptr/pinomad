// Plugin hot reload in a real browser (ADR-0050): the host rebuilds a plugin
// when its files change and tells the open page, which swaps the plugin's
// panels and tool cards and follows a newly shared state, all on the one
// connection it opened. A deleted plugin goes, and an edit that does not
// build leaves the page as it was.
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { chromium, type Page } from "@playwright/test";
import { expect, it } from "vitest";
import type { OpenedHost } from "@pinomad/host/src/host.ts";
import { startFauxHost, tempDir, useCleanups } from "@pinomad/host/test/support.ts";
import { startWeb } from "./support.ts";

const defer = useCleanups();
const NOTES_PLUGIN = fileURLToPath(new URL("../../host/test/fixtures/plugins/notes", import.meta.url));
const ARTIFACT_EXAMPLE = fileURLToPath(new URL("../../../examples/plugins/artifact", import.meta.url));

/**
 * The page on `host`, counting the WebSockets to it that open and close and
 * the errors it logs: a reload must reach the page without a reconnect and
 * without an error.
 */
async function openPage(host: OpenedHost, webOrigin: string) {
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, colorScheme: "light" });
  const sockets = { opened: 0, closed: 0 };
  page.on("websocket", (socket) => {
    if (!socket.url().startsWith(host.url)) return;
    sockets.opened += 1;
    socket.on("close", () => (sockets.closed += 1));
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 200));
  });
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await prompt(page).waitFor();
  return { page, sockets, errors };
}

const prompt = (page: Page) => page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));

async function startConversation(page: Page, projectName: string, text: string): Promise<void> {
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await prompt(page).fill(text);
  await prompt(page).press("Enter");
}

/** An editor's save: the file written beside the data dir's plugins and renamed over the old one, never half-written. */
async function save(dataDir: string, file: string, source: string): Promise<void> {
  const draft = join(dataDir, `draft-${Math.random().toString(36).slice(2)}`);
  await writeFile(draft, source);
  await rename(draft, join(dataDir, "plugins", file));
}

/** `source` with each `[from, to]` replaced once; a replacement that no longer matches fails the test, not just the wait. */
function edited(source: string, replacements: readonly (readonly [string, string])[]): string {
  return replacements.reduce((text, [from, to]) => {
    expect(text, `web.tsx no longer contains ${from}`).toContain(from);
    return text.replace(from, to);
  }, source);
}

async function projectDir(): Promise<{ path: string; name: string }> {
  const project = await tempDir();
  defer(project.remove);
  return { path: project.path, name: project.path.split("/").at(-1)! };
}

it("swaps a plugin's open panel and its tool card for the edited web.tsx without reconnecting", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(ARTIFACT_EXAMPLE, join(dataDir.path, "plugins", "artifact"), { recursive: true });
  const project = await projectDir();
  const html = '<!doctype html><p id="out">static</p><script>document.getElementById("out").textContent = "Drawn by its script";</script>';
  const webOrigin = await startWeb(defer);
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dataDir.path,
    projects: [project.path],
    answers: [fauxAssistantMessage(fauxToolCall("artifact_write", { title: "Greeting page", html }), { stopReason: "toolUse" }), "Wrote the page."],
  });
  const { page, sockets, errors } = await openPage(host, webOrigin);
  await startConversation(page, project.name, "make a page");
  await page.getByText("Wrote the page.").waitFor();
  await page.locator('[data-slot="chat-trace-trigger"]').click();
  await page.locator(".chat-step__trigger", { hasText: "artifact_write" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.frameLocator('iframe[title="Greeting page"]').getByText("Drawn by its script").waitFor();

  const connected = { ...sockets };
  const web = join(dataDir.path, "plugins", "artifact", "web.tsx");
  await save(
    dataDir.path,
    "artifact/web.tsx",
    edited(await readFile(web, "utf8"), [
      ["<pinomad.Sandbox title={page.title}", "<p>Edited panel ✓</p>\n        <pinomad.Sandbox title={page.title}"],
      ['onClick={() => pinomad.openPanel("page")}>\n          Open\n', 'onClick={() => pinomad.openPanel("page")}>\n          Show page\n'],
    ]),
  );

  // The panel stays open on the new version, page and all; the card in the open trace is the new one.
  await panel.getByText("Edited panel ✓").waitFor();
  await panel.frameLocator('iframe[title="Greeting page"]').getByText("Drawn by its script").waitFor();
  await page.getByRole("button", { name: "Show page", exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Open", exact: true }).count()).toBe(0);
  if (process.env.PINOMAD_PLUGIN_SHOT !== undefined) await page.screenshot({ path: process.env.PINOMAD_PLUGIN_SHOT });
  expect(sockets).toEqual(connected);
  expect(errors).toEqual([]);
});

it("shows a plugin added while the page is open, with its shared state", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  const project = await projectDir();
  const webOrigin = await startWeb(defer);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dataDir.path, projects: [project.path], answers: ["No plugins yet."] });
  const { page, sockets, errors } = await openPage(host, webOrigin);
  await startConversation(page, project.name, "hello");
  await page.getByText("No plugins yet.").waitFor();

  const connected = { ...sockets };
  // Staged outside plugins/ and moved in whole, so no build sees it half-copied.
  const staged = await tempDir();
  defer(staged.remove);
  await cp(NOTES_PLUGIN, join(staged.path, "notes"), { recursive: true });
  await mkdir(join(dataDir.path, "plugins"), { recursive: true });
  await rename(join(staged.path, "notes"), join(dataDir.path, "plugins", "notes"));

  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("0 on the board ✓").waitFor();
  await panel.getByRole("button", { name: "Add note" }).click();
  // The board reaches the panel only through the doc: stream the page subscribed to after the reload.
  await panel.getByText("1 on the board ✓").waitFor();
  expect(await panel.getByRole("list", { name: "Notes" }).getByRole("listitem").allTextContents()).toEqual(["Note from the panel"]);
  expect(sockets).toEqual(connected);
  expect(errors).toEqual([]);
});

it("takes a deleted plugin's open panel away and leaves the conversation as it was", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(NOTES_PLUGIN, join(dataDir.path, "plugins", "notes"), { recursive: true });
  const project = await projectDir();
  const webOrigin = await startWeb(defer);
  const host = await startFauxHost(defer, { browserOrigins: [webOrigin], dataDir: dataDir.path, projects: [project.path], answers: ["Board ready."] });
  const { page, sockets, errors } = await openPage(host, webOrigin);
  await startConversation(page, project.name, "hello");
  await page.getByText("Board ready.").waitFor();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByText("1 on the board ✓").waitFor();

  const connected = { ...sockets };
  await rm(join(dataDir.path, "plugins", "notes"), { recursive: true });
  await page.getByRole("button", { name: "Notes", exact: true }).waitFor({ state: "detached" });
  expect(await panel.getByText("1 on the board ✓").count()).toBe(0);
  await page.getByText("Board ready.").waitFor();
  expect(sockets).toEqual(connected);
  expect(errors).toEqual([]);
});

it("keeps the open panel when an edit does not build, and takes the next edit that does", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(ARTIFACT_EXAMPLE, join(dataDir.path, "plugins", "artifact"), { recursive: true });
  const project = await projectDir();
  const webOrigin = await startWeb(defer);
  let buildFailed!: () => void;
  const failed = new Promise<void>((resolve) => (buildFailed = resolve));
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dataDir.path,
    projects: [project.path],
    answers: ["Nothing to draw."],
    plugins: {
      onReload: (outcome) => {
        if (outcome.failed.some((failure) => failure.plugin === "artifact")) buildFailed();
      },
    },
  });
  const { page, sockets, errors } = await openPage(host, webOrigin);
  await startConversation(page, project.name, "hello");
  await page.getByText("Nothing to draw.").waitFor();
  await page.getByRole("button", { name: "Artifact", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const empty = "No artifact yet. Ask the agent to make a page.";
  await panel.getByText(empty).waitFor();

  const connected = { ...sockets };
  const source = await readFile(join(dataDir.path, "plugins", "artifact", "web.tsx"), "utf8");
  await save(dataDir.path, "artifact/web.tsx", `${source}\nexport const broken = (;\n`);
  await failed;
  expect(await panel.getByText(empty).count()).toBe(1);

  await save(dataDir.path, "artifact/web.tsx", edited(source, [[empty, "Still nothing here ✓"]]));
  await panel.getByText("Still nothing here ✓").waitFor();
  expect(sockets).toEqual(connected);
  expect(errors).toEqual([]);
});
