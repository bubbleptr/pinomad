// Email accounts and provider sign-in in a real browser against a real
// account server (ADR-0044): the page is the server's own origin (the Vite
// dev server proxies /api to it), mail goes to an in-process mailer, and the
// identity provider is the fake from the server's tests, whose "authorize
// page" is played by intercepting the browser's request to it.
//
// PINOMAD_SHOTS_DIR=<dir> also saves light and dark screenshots of each screen.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { expect, it } from "vitest";
import { freePort, tempDir, useCleanups } from "@pinomad/host/test/support.ts";
import { openAccounts } from "../../server/src/accounts.ts";
import { createOAuth } from "../../server/src/oauth.ts";
import { startRelay } from "../../server/src/relay.ts";
import { startFakeIdp, type FakeIdentity } from "../../server/test/oauth-fake.ts";
import { fakeMailer } from "../../server/test/support.ts";
import { startWeb } from "./support.ts";

const defer = useCleanups();
const shotsDir = process.env.PINOMAD_SHOTS_DIR;

/** A web page that is an account server with open sign-up, mail and Google, GitHub and Apple. */
async function startAccountsPage() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const data = await tempDir();
  defer(data.remove);
  const mail = fakeMailer();
  const idp = await startFakeIdp();
  defer(() => idp.close());
  const accounts = await openAccounts({
    dataDir: data.path,
    bootstrapUser: "owner@example.com",
    bootstrapPassword: "correct horse battery",
    registration: "open",
    mailer: mail,
  });
  const relay = await startRelay({ port: 0, publicOrigin: origin, accounts, oauth: createOAuth(idp.config) });
  defer(() => relay.close());
  await startWeb(defer, { port, apiTarget: `http://127.0.0.1:${relay.port}` });
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  /**
   * Plays the provider's page: whoever signs in there comes back with a code.
   * Playwright doesn't intercept a redirect's target, so the server's start
   * route is answered here instead: its redirect to the provider is followed
   * in-process and the browser goes straight on to the callback, with the
   * start's binding cookie.
   */
  const signInAtProvider = async (provider: "google" | "github" | "apple", identity: FakeIdentity): Promise<void> => {
    await page.route(
      (url) => url.pathname === `/api/oauth/${provider}/start`,
      async (route) => {
        const started = await route.fetch({ maxRedirects: 0 });
        const { code, state, redirectUri } = idp.authorize(provider, started.headers()["location"]!, identity);
        const back = new URL(redirectUri);
        back.search = new URLSearchParams({ code, state }).toString();
        await route.fulfill({ status: 302, headers: { location: back.toString(), "set-cookie": started.headers()["set-cookie"]! } });
      },
    );
  };
  return { origin, mail, page, signInAtProvider };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (shotsDir === undefined) return;
  await mkdir(shotsDir, { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    // Theme switches animate; let them settle.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

it("creates an account with an emailed code and lands signed in", async () => {
  const { origin, mail, page } = await startAccountsPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Continue with Google" }).waitFor();
  await shoot(page, "signed-out-providers");

  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByText("Enter the 6-digit code we sent to ada@example.com.").waitFor();
  const code = mail.codeFor("ada@example.com");
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel("Code", { exact: true }).fill(code!);
  await page.getByLabel("New password").fill("correct horse battery");
  await shoot(page, "create-account-code");
  await page.getByRole("button", { name: "Create account" }).click();

  // Signed in with no hosts yet: the first-host home, under the new account.
  await page.getByRole("button", { name: "Account…" }).waitFor();
  const me = await page.evaluate(async () => (await fetch("/api/me")).json());
  expect(me).toMatchObject({ user: { email: "ada@example.com" } });
}, 120_000);

it("signs up with Google through the no-account-yet page, then confirms by mailed code", async () => {
  const { origin, mail, page, signInAtProvider } = await startAccountsPage();
  await signInAtProvider("google", { sub: "google-ada", email: "ada@gmail.com", name: "Ada" });
  await page.goto(origin);
  await page.getByRole("button", { name: "Continue with Google" }).click();

  // The server found no account for this Google identity and sent the page back.
  await page.getByRole("heading", { name: "No PiNomad account for ada@gmail.com yet" }).waitFor();
  expect(new URL(page.url()).search).toBe("");
  await shoot(page, "pending-sign-in");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Account…" }).waitFor();

  // A Google-only account: no password, so the confirmation is a mailed code.
  await page.getByRole("button", { name: "Account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByText("Sign-in methods").waitFor();
  await dialog.getByText("Not set").waitFor();
  await dialog.getByRole("button", { name: "Link GitHub" }).waitFor();
  await dialog.getByText("Sign-in methods").scrollIntoViewIfNeeded();
  await shoot(page, "sign-in-methods");

  await dialog.getByRole("button", { name: "Set password" }).click();
  await dialog.getByText("We'll email a code to ada@gmail.com.").waitFor();
  await dialog.getByRole("button", { name: "Send code" }).click();
  await dialog.getByLabel("Code", { exact: true }).waitFor();
  const code = mail.codeFor("ada@gmail.com");
  expect(code).toMatch(/^\d{6}$/);
  await dialog.getByLabel("Code", { exact: true }).fill(code!);
  await dialog.getByLabel("New password").fill("a brand new password");
  await shoot(page, "confirm-by-code");
  // The row's button opened the form; the form's own is the last.
  await dialog.getByRole("button", { name: "Set password" }).last().click();
  await dialog.getByText("Password set.").waitFor();
  await dialog.getByText("Set", { exact: true }).waitFor();
}, 120_000);
