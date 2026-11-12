// The built client under the CSP that serveWebClient sends (#454). The other
// browser tests run on the Vite dev server, which sends no policy and injects
// an inline preamble, so only a production build served by the host shows
// whether a dependency started needing inline script, eval or a foreign origin.
// The same build loads a plugin's UI from a blob: module (ADR-0049).

import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { coding } from "@pinomad/host/src/extensions/coding.ts";
import { startFauxHost, tempDir, useCleanups } from "@pinomad/host/test/support.ts";

const defer = useCleanups();
const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const NOTES_PLUGIN = fileURLToPath(new URL("../../host/test/fixtures/plugins/notes", import.meta.url));
const ARTIFACT_EXAMPLE = fileURLToPath(new URL("../../../examples/plugins/artifact", import.meta.url));

let out: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  out = await tempDir();
  await build({ configFile: webConfig, logLevel: "error", build: { outDir: join(out.path, "dist"), emptyOutDir: true } });
}, 120_000);
afterAll(() => out?.remove());

/** Logs every CSP violation to the console, where `refused` collects it. */
async function watchCsp(page: import("@playwright/test").Page): Promise<string[]> {
  const refused: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) refused.push(message.text().slice(0, 200));
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return refused;
}

it("runs the built client served by the host without CSP violations", async () => {
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    webRoot: join(out.path, "dist"),
    projects: [project.path],
    extensions: [coding],
    answers: [
      fauxAssistantMessage(fauxToolCall("write", { path: "answer.ts", content: "const answer = 41;\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("edit", { path: "answer.ts", edits: [{ oldText: "41", newText: "42" }] }), {
        stopReason: "toolUse",
      }),
      "Here it is:\n\n```ts\nconst answer: number = 42;\n```\n",
    ],
  });
  const origin = new URL(host.url.replace(/^ws/, "http")).origin;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  const refused = await watchCsp(page);

  const response = await page.goto(`${origin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  const prompt = page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));
  await prompt.waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();

  // A pasted image renders from a data: URL; the fenced answer runs the code
  // block's highlighter.
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "shot.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.querySelector('[aria-multiline="true"]')!.dispatchEvent(event);
  });
  // Enter is ignored while the image is still being prepared.
  await page.locator('[data-testid="composer-attachments"] [role="group"]').getByRole("img", { name: "Image 1" }).waitFor();
  await prompt.fill("show me code");
  await prompt.press("Enter");
  await page.getByTestId("message-images").getByRole("button", { name: /Image 1/ }).waitFor();
  await page.getByText("const answer: number").waitFor();

  // The edit's diff compiles the highlighter's WebAssembly engine
  // (wasm-unsafe-eval) and colors its tokens.
  await page.locator('[data-slot="chat-trace-trigger"]').click();
  await page.getByRole("button", { name: /Edited answer.ts/ }).click();
  await page
    .locator('[data-line-type="change-addition"]', { hasText: "42" })
    .locator('span[style*="--diffs-token-light"]')
    .first()
    .waitFor();

  expect(refused).toEqual([]);
});

it("loads a plugin's panel under the CSP and updates it through a plugin call", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(NOTES_PLUGIN, join(dataDir.path, "plugins", "notes"), { recursive: true });
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    dataDir: dataDir.path,
    webRoot: join(out.path, "dist"),
    projects: [project.path],
    answers: ["Board ready."],
  });
  const origin = new URL(host.url.replace(/^ws/, "http")).origin;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, colorScheme: "light" });
  const refused = await watchCsp(page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 200));
  });
  await page.goto(`${origin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  const prompt = page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));
  await prompt.waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await prompt.fill("hello");
  await prompt.press("Enter");
  await page.getByText("Board ready.").waitFor();

  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByText("0 on the board ✓").waitFor();
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByText("1 on the board ✓").waitFor();
  expect(await panel.getByRole("list", { name: "Notes" }).getByRole("listitem").allTextContents()).toEqual(["Note from the panel"]);
  if (process.env.PINOMAD_PLUGIN_SHOT !== undefined) await page.screenshot({ path: process.env.PINOMAD_PLUGIN_SHOT });

  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});

it("opens the artifact example's page from its tool card and runs it in the sandbox", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(ARTIFACT_EXAMPLE, join(dataDir.path, "plugins", "artifact"), { recursive: true });
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const html = '<!doctype html><p id="out">static</p><script>document.getElementById("out").textContent = "Drawn by its script";</script>';
  const host = await startFauxHost(defer, {
    dataDir: dataDir.path,
    webRoot: join(out.path, "dist"),
    projects: [project.path],
    answers: [
      fauxAssistantMessage(fauxToolCall("artifact_write", { title: "Greeting page", html }), { stopReason: "toolUse" }),
      "Wrote the page.",
    ],
  });
  const origin = new URL(host.url.replace(/^ws/, "http")).origin;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, colorScheme: "light" });
  const refused = await watchCsp(page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 200));
  });
  await page.goto(`${origin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  const prompt = page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));
  await prompt.waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await prompt.fill("make a page");
  await prompt.press("Enter");
  await page.getByText("Wrote the page.").waitFor();

  await page.locator('[data-slot="chat-trace-trigger"]').click();
  await page.locator(".chat-step__trigger", { hasText: "artifact_write" }).click();
  await page.getByText("Greeting page").waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();

  const panel = page.getByRole("complementary", { name: "Side panel" });
  const frame = panel.locator('iframe[title="Greeting page"]');
  await panel.frameLocator('iframe[title="Greeting page"]').getByText("Drawn by its script").waitFor();
  expect((await frame.boundingBox())!.height).toBeGreaterThan(300);
  if (process.env.PINOMAD_PLUGIN_SHOT !== undefined) await page.screenshot({ path: process.env.PINOMAD_PLUGIN_SHOT });

  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});

it("runs a plugin's model-written HTML in the sandbox, cut off from the shell and from fetch", async () => {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  await cp(NOTES_PLUGIN, join(dataDir.path, "plugins", "notes"), { recursive: true });
  const project = await tempDir();
  defer(project.remove);
  const projectName = project.path.split("/").at(-1)!;
  const host = await startFauxHost(defer, {
    dataDir: dataDir.path,
    webRoot: join(out.path, "dist"),
    projects: [project.path],
    answers: ["Artifact ready."],
  });
  const origin = new URL(host.url.replace(/^ws/, "http")).origin;

  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, colorScheme: "light" });
  const refused = await watchCsp(page);
  await page.goto(`${origin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  const prompt = page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));
  await prompt.waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();
  await prompt.fill("hello");
  await prompt.press("Enter");
  await page.getByText("Artifact ready.").waitFor();

  await page.getByRole("button", { name: "Artifact", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const sandbox = panel.frameLocator('iframe[title="Artifact"]');
  await sandbox.getByText("script ran ✓").waitFor();
  await sandbox.getByText("fetch: ").waitFor();
  const outcomes = await sandbox.locator("p[id]:not(#ran)").allTextContents();
  expect(outcomes.sort()).toEqual([
    "fetch: blocked TypeError",
    "indexedDB: blocked SecurityError",
    "localStorage: blocked SecurityError",
    "top: blocked SecurityError",
  ]);
  // The only violations are the sandbox's refused fetch; the shell ran clean.
  expect(refused.length).toBeGreaterThan(0);
  expect(refused.filter((text) => !text.includes(`${origin}/index.html`))).toEqual([]);

  await panel.getByRole("button", { name: "Show second page" }).click();
  await sandbox.getByText("Second page ✓").waitFor();
  await expect.poll(() => sandbox.getByText("script ran ✓").count()).toBe(0);
});
