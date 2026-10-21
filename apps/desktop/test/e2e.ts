// `bun run desktop:e2e` — launches the electron-vite build (not the packaged
// .app) with Playwright's Electron driver, pairs with a faux host through a
// pasted loopback link, and saves screenshots to /tmp.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";
import { connectTo, startFauxHost } from "../../host/test/support.ts";
import { desktopDeviceName } from "../electron/device-name.ts";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const cleanups: (() => Promise<void> | void)[] = [];
const defer = (cleanup: () => Promise<void> | void): void => void cleanups.push(cleanup);
const done = async (code: number): Promise<never> => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.exit(code);
};

// Both faux hosts run on this machine, so they would announce the same
// hostname (5.12) and the switcher would suffix their labels with hostKey
// prefixes; distinct names keep the labels predictable.
const namedDataDir = async (hostName: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-desktop-e2e-host-"));
  defer(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ hostName }));
  return dir;
};

try {
  // No remote listener: the desktop pairs over the loopback /secure path.
  const host = await startFauxHost(defer, { dataDir: await namedDataDir("Host A"), answers: ["hello from the desktop"] });
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
  // The unpackaged build already disables the updater via !app.isPackaged;
  // the flag is belt-and-braces for an E2E that ever drives a packaged app.
  env["PINOMAD_E2E"] = "1";
  const app = await electron.launch({ args: ["."], cwd: appDir, env });
  defer(() => app.close());
  const page = await app.firstWindow();
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  // Nothing stored → account sign-in with the paste-a-link form under it,
  // over app:// with the CSP applied.
  await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-nolink.png" });

  await page.getByLabel("Pairing link").fill(pairingUrl);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // The pair link lands on the confirmation screen — no socket until "Pair".
  await page.getByText("Pair with this host?").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-confirm.png" });
  await page.getByRole("button", { name: "Pair", exact: true }).click();

  // Pairing runs, the page reloads into the workbench, and the channel works.
  const composer = page.getByRole("textbox");
  await composer.waitFor({ timeout: 30_000 });
  await composer.fill("hello from electron");
  await composer.press("Enter");
  await page.getByText("hello from the desktop").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-connected.png" });

  // The pairing registered the bridge's machine-aware label ("Linux Desktop
  // (omarchy)" here, "Mac Desktop (…)" on macOS), not a browser UA name. The
  // host trims and clips names at 64 chars (devices.ts), so compare against
  // the same truncation rather than the composed string.
  const expectedName = desktopDeviceName(process.platform, hostname()).trim().slice(0, 64) || "Unknown device";
  const registeredName = tokenClient.view.current().devices.at(-1)?.name ?? "";
  if (registeredName !== expectedName) {
    throw new Error(`unexpected device name: ${registeredName} (expected ${expectedName})`);
  }

  // Native-chrome check: capture the real window — traffic lights included —
  // with the sidebar open and collapsed. Needs Screen Recording permission;
  // report and move on when it's denied.
  const captureWindow = async (path: string): Promise<void> => {
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    await run("screencapture", [
      "-x",
      `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      path,
    ]);
    console.log(`window capture: ${path}`);
  };
  // A pinomad:// deep link into the already-open window: the same-document
  // hash hop reloads and lands on the confirmation, not a silent pairing.
  const { url: link2 } = await tokenClient.controller.createPairing();
  const fragment2 = pairingFragment(link2);
  await app.evaluate(
    ({ app: electronApp }, url) =>
      electronApp.emit("open-url", { preventDefault() {
        // open-url's event arg isn't a real event here; preventDefault is all
        // the handler calls on it.
      } }, url),
    `pinomad://pair#${fragment2}`,
  );
  await page.getByText("Pair with this host?").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("textbox").waitFor({ timeout: 30_000 });

  // Multi-host: a second faux host pairs from Settings → Hosts, and the
  // sidebar's host menu swaps between the two — one connection at a time.
  const hostB = await startFauxHost(defer, { dataDir: await namedDataDir("Host B"), answers: ["hello from host B"] });
  const tokenB = await connectTo(defer, hostB);
  const { url: pairB } = await tokenB.controller.createPairing();
  const labelA = "Host A";
  const labelB = "Host B";

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const pairDialog = page.getByRole("dialog", { name: "Settings" });
  await pairDialog.getByRole("button", { name: "Hosts", exact: true }).click();
  await pairDialog.getByLabel("Pairing link").fill(pairB);
  await pairDialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Pair with this host?").waitFor({ timeout: 30_000 });
  // Multi-host never warns about replacing — every pairing is kept.
  if ((await page.getByText("Replaces your current pairing").count()) !== 0) {
    throw new Error("multi-host pairing showed the replace warning");
  }
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const composerB = page.getByRole("textbox");
  await composerB.waitFor({ timeout: 30_000 });
  await composerB.fill("hello from electron on B");
  await composerB.press("Enter");
  await page.getByText("hello from host B").waitFor({ timeout: 30_000 });

  // The menu fades in on open; wait for the entry animation so screenshots
  // don't catch a mid-fade menu that reads as disabled items.
  const settleMenu = (): Promise<void> =>
    page
      .getByRole("menu")
      .evaluate(async (el) => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => {
              const target = (animation.effect as KeyframeEffect | null)?.target;
              return target instanceof Element && (target === el || target.contains(el));
            })
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      })
      .then(() => undefined);

  // The host menu lists both hosts with their status; selecting A reloads onto it.
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  await page.getByRole("menuitem", { name: `${labelB} (connected)`, exact: true }).waitFor();
  await settleMenu();
  await page.screenshot({ path: "/tmp/pinomad-desktop-host-switcher.png" });
  await page.getByRole("menuitem", { name: `${labelA} (not connected)`, exact: true }).click();
  await page.getByRole("textbox").waitFor({ timeout: 30_000 });

  // A dead host lands on a failure screen that still lists the hosts.
  await hostB.close();
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  await page.getByRole("menuitem", { name: `${labelB} (not connected)`, exact: true }).click();
  await page.getByText("Could not connect to the host", { exact: true }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/pinomad-desktop-failure-switcher.png" });
  await page.getByRole("button", { name: `Switch to ${labelA}`, exact: true }).click();
  await page.getByRole("textbox").waitFor({ timeout: 30_000 });

  // The list is one encrypted blob: neither hostKey appears in plaintext.
  const blob = await readFile(join(env["PINOMAD_USER_DATA_DIR"]!, "hosts.bin"));
  const hostKeyA = pairingUrl.split("#pair=")[1]!.split(".")[0]!;
  const hostKeyB = pairB.split("#pair=")[1]!.split(".")[0]!;
  if (blob.includes(hostKeyA) || blob.includes(hostKeyB)) {
    throw new Error("hosts.bin contains a hostKey in plaintext");
  }

  try {
    await captureWindow("/tmp/pinomad-desktop-window-sidebar-open.png");
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
    await captureWindow("/tmp/pinomad-desktop-window-sidebar-closed.png");
  } catch (error) {
    console.log(`window capture skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (cspViolations.length > 0) {
    throw new Error(`CSP violations:\n${cspViolations.join("\n")}`);
  }
  console.log("ok — screenshots: /tmp/pinomad-desktop-nolink.png, /tmp/pinomad-desktop-connected.png");
  await done(0);
} catch (error) {
  console.error(error);
  await done(1);
}
