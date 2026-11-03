// The built client under the CSP that serveWebClient sends (#454). The other
// browser tests run on the Vite dev server, which sends no policy and injects
// an inline preamble, so only a production build served by the host shows
// whether a dependency started needing inline script, eval or a foreign origin.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { expect, it } from "vitest";
import { coding } from "@pinomad/host/src/extensions/coding.ts";
import { startFauxHost, tempDir, useCleanups } from "@pinomad/host/test/support.ts";

const defer = useCleanups();
const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

it("runs the built client served by the host without CSP violations", async () => {
  const out = await tempDir();
  defer(out.remove);
  await build({ configFile: webConfig, logLevel: "error", build: { outDir: join(out.path, "dist"), emptyOutDir: true } });
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
  const refused: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) refused.push(message.text().slice(0, 200));
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.effectiveDirective} ${event.blockedURI}`);
    });
  });

  const response = await page.goto(`${origin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  const prompt = page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));
  await prompt.waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).hover();
  await page.getByRole("button", { name: `New conversation in ${projectName}`, exact: true }).click();

  // A pasted image renders from a data: URL; the fenced answer runs Astryx's
  // highlighter, which injects its <style> elements at runtime.
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
