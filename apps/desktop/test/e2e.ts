// `bun run desktop:e2e` — launches the electron-vite build (not the packaged
// .app) with Playwright's Electron driver, pairs with a faux host through a
// pasted loopback link, and saves screenshots to /tmp.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { connectTo, startFauxHost } from "../../host/test/support.ts";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
const defer = (cleanup: () => Promise<void> | void): void => void cleanups.push(cleanup);
const done = async (code: number): Promise<never> => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.exit(code);
};

try {
  // No remote listener: the desktop pairs over the loopback /secure path.
  const host = await startFauxHost(defer, { answers: ["hello from the desktop"] });
  const tokenClient = await connectTo(defer, host);
  const { url: pairingUrl } = await tokenClient.controller.createPairing();

  // Agent/CI shells can inherit ELECTRON_RUN_AS_NODE=1, which makes the
  // Electron binary run as plain Node — the app never starts.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || value === undefined) continue;
    env[key] = value;
  }
  // The renderer's paired device lives in userData localStorage; isolate it
  // so a previous run's pairing can't skip the no-link screen.
  env["PINOMAD_USER_DATA_DIR"] = await mkdtemp(join(tmpdir(), "pinomad-desktop-e2e-"));
  const app = await electron.launch({ args: ["."], cwd: appDir, env });
  defer(() => app.close());
  const page = await app.firstWindow();
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  // Nothing stored → the paste-a-link screen over app:// with the CSP applied.
  await page.getByText("No host link").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-nolink.png" });

  await page.getByLabel("Pairing link").fill(pairingUrl);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // Pairing runs, the page reloads into the workbench, and the channel works.
  const composer = page.getByRole("textbox");
  await composer.waitFor({ timeout: 30_000 });
  await composer.fill("hello from electron");
  await composer.press("Enter");
  await page.getByText("hello from the desktop").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-connected.png" });

  if (cspViolations.length > 0) {
    throw new Error(`CSP violations:\n${cspViolations.join("\n")}`);
  }
  console.log("ok — screenshots: /tmp/pinomad-desktop-nolink.png, /tmp/pinomad-desktop-connected.png");
  await done(0);
} catch (error) {
  console.error(error);
  await done(1);
}
