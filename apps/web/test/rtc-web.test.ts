// The real browser path: a Node host child (native node-datachannel callbacks
// never fire inside a vitest worker) plus Chromium. The page pairs for real,
// connects over the relay/loopback WebSocket, then upgrades to WebRTC.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { chromium, type Page } from "@playwright/test";
import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";

const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const hostDir = fileURLToPath(new URL("../../host", import.meta.url));

const cleanups: Array<() => Promise<void> | void> = [];
const defer = (cleanup: () => Promise<void> | void): void => void cleanups.push(cleanup);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function startWeb(): Promise<string> {
  const vite = await createServer({ configFile: webConfig, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  return new URL(vite.resolvedUrls!.local[0]!).origin;
}

interface StartedHost {
  readonly child: ChildProcess;
  readonly url: string;
  readonly token: string;
}

function startHost(dataDir: string, webOrigin: string): Promise<StartedHost> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "src/main.ts",
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--faux",
        "rtc answer",
        "--browser-origin",
        webOrigin,
      ],
      { cwd: hostDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`host exited ${code} before ready: ${stderr}`)));
    const lines = createInterface({ input: child.stdout! });
    void (async () => {
      for await (const line of lines) {
        let frame: { event?: string; url?: string };
        try {
          frame = JSON.parse(line) as { event?: string; url?: string };
        } catch {
          continue;
        }
        if (frame.event === "ready" && frame.url !== undefined) {
          void readFile(join(dataDir, "token"), "utf8").then(
            (token) => resolve({ child, url: frame.url!, token: token.trim() }),
            reject,
          );
          return;
        }
      }
      reject(new Error(`host produced no ready line: ${stderr}`));
    })();
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

/** Call one host method over a plain token connection, before any device exists. */
function tokenCall(hostUrl: string, token: string, method: string, args: unknown): Promise<unknown> {
  const socket = new WebSocket(`${hostUrl}?token=${encodeURIComponent(token)}`);
  return new Promise((resolve, reject) => {
    const id = 1;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as {
        type?: string;
        id?: number;
        ok?: boolean;
        value?: unknown;
        error?: string;
      };
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "call", id, method, args }));
        return;
      }
      if (frame.type !== "result" || frame.id !== id) return;
      socket.close();
      if (frame.ok === true) resolve(frame.value);
      else reject(new Error(frame.error ?? "token call failed"));
    });
    socket.addEventListener("error", () => reject(new Error("token socket failed")));
    socket.addEventListener("close", (event) => {
      if (event.code !== 1000) reject(new Error(`token socket closed with ${event.code}`));
    });
  });
}

const prompt = (page: Page) =>
  page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));

describe("web RTC carrier", () => {
  it(
    "upgrades the paired host to P2P and falls back from Relay only",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pinomad-rtc-web-"));
      defer(() => rm(dir, { recursive: true, force: true }));
      await writeFile(join(dir, "settings.json"), `${JSON.stringify({ rtcStun: [] })}\n`);

      const webOrigin = await startWeb();
      const host = await startHost(dir, webOrigin);
      defer(() => stopChild(host.child));

      const pairing = (await tokenCall(host.url, host.token, "createPairing", {})) as { url: string };
      const fragment = pairingFragment(pairing.url);
      if (fragment === undefined) throw new Error("host returned no usable pairing link");

      const browser = await chromium.launch();
      defer(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${webOrigin}/#${fragment}`);
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await prompt(page).waitFor({ timeout: 30_000 });

      const settings = page.getByRole("button", { name: "Settings", exact: true });
      await settings.click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.getByRole("button", { name: "Hosts", exact: true }).click();

      // The coordinator starts the upgrade 1s after the WebSocket is ready;
      // the row description is polled from rtcDiagnostics every second.
      await dialog.getByText(/^Connected · P2P$/).waitFor({ timeout: 90_000 });

      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const hosts = JSON.parse(localStorage.getItem("pinomad.hosts") ?? "[]") as { rtcSignalOnly?: boolean }[];
              return hosts[0]?.rtcSignalOnly === true;
            }),
          { timeout: 10_000 },
        )
        .toBe(true);

      await dialog.getByRole("button", { name: /^Connection to / }).click();
      const panel = dialog.getByRole("group", { name: /^Connection to / });
      await panel.waitFor();
      expect(await panel.getByRole("radio", { name: "Auto", exact: true }).isChecked()).toBe(true);
      await panel.getByText("Active", { exact: true }).waitFor();
      await panel.getByText(/^P2P(?: · |$)/).waitFor();

      await panel.getByRole("radio", { name: "Relay only", exact: true }).click();
      await expect
        .poll(
          async () => {
            const descriptions = await dialog.getByText(/^Connected · /).allTextContents();
            const description = descriptions[0] ?? "";
            return description !== "" && !description.includes("P2P");
          },
          { timeout: 60_000 },
        )
        .toBe(true);

      const saved = await page.evaluate(
        () => JSON.parse(localStorage.getItem("pinomad.hosts") ?? "[]") as { connectionMode?: string }[],
      );
      expect(saved[0]?.connectionMode).toBe("relayOnly");
    },
    180_000,
  );
});
