// Runs on mbp under playwright-core + the system Chrome. It only navigates to
// the relay served by omarchy and reports the page's window.__SPIKE back.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const configPath = process.argv[2];
if (configPath === undefined) {
  console.error("REMOTE_BROWSER_ERROR missing config path");
  process.exit(1);
}

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const args = config.mdns === false ? ["--disable-features=WebRtcHideLocalIpsWithMdns"] : [];
  const browser = await chromium.launch({ channel: "chrome", headless: true, args });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("PAGE_ERROR " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("PAGE_CONSOLE_ERROR " + message.text());
  });
  await page.addInitScript((browserConfig) => {
    window.__SPIKE_CONFIG = browserConfig;
  }, config.browser);
  await page.goto(config.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => window.__SPIKE && window.__SPIKE.done === true, undefined, {
    timeout: config.timeoutMs ?? 180_000,
  });
  const result = await page.evaluate(() => window.__SPIKE);
  console.log("REMOTE_BROWSER_RESULT " + JSON.stringify(result));
  await browser.close();
} catch (error) {
  console.error("REMOTE_BROWSER_ERROR " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
