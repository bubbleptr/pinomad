// Email accounts (ADR-0044 §1, §2, §7, §8): sign-up and password reset by
// mailed code, adding an email to a legacy username account, and the
// operator's CLI paths.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { addUser, openAccounts, setUserEmail, type CodeLimits, type LoginLimits, type Mailer } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { downgradeToSchema8, fakeMailer, removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a different long password";
const MINUTE = 60_000;

const dirs: string[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

interface Started {
  readonly relay: Relay;
  readonly dataDir: string;
  readonly mail: ReturnType<typeof fakeMailer>;
}

async function startServer(options?: {
  readonly dataDir?: string;
  readonly bootstrapUser?: string;
  /** Default: a fake mailer; `null` runs without one. */
  readonly mailer?: Mailer | null;
  readonly registration?: "open" | "closed";
  readonly now?: () => number;
  readonly limits?: LoginLimits;
  readonly codeLimits?: CodeLimits;
}): Promise<Started> {
  const dataDir = options?.dataDir ?? (await tempDir(dirs));
  const mail = fakeMailer();
  const mailer = options?.mailer === undefined ? mail : options.mailer;
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: options?.bootstrapUser ?? "admin",
    bootstrapPassword: PASSWORD,
    registration: options?.registration ?? "open",
    ...(mailer === null ? {} : { mailer }),
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.limits === undefined ? {} : { limits: options.limits }),
    ...(options?.codeLimits === undefined ? {} : { codeLimits: options.codeLimits }),
  });
  const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, accounts });
  relays.push(relay);
  return { relay, dataDir, mail };
}

async function stop(started: Started): Promise<void> {
  relays.splice(relays.indexOf(started.relay), 1);
  await started.relay.close();
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

function api(
  relay: Relay,
  options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: unknown },
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Empty bodies surface as {}.
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

const post = (relay: Relay, path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse> =>
  api(relay, { method: "POST", path, body, ...(headers === undefined ? {} : { headers }) });
const bearer = (token: unknown): Record<string, string> => ({ authorization: `Bearer ${token as string}` });
const login = (relay: Relay, username: string, password = PASSWORD): Promise<ApiResponse> =>
  post(relay, "/api/login", { username, password });

/** Mails a sign-up code to `email` and signs up with it; resolves to the register response. */
async function signUp(started: Started, email: string, headers?: Record<string, string>): Promise<ApiResponse> {
  expect((await post(started.relay, "/api/register/code", { email }, headers)).status).toBe(202);
  // Mail goes to the stored, lowercased address.
  const code = started.mail.codeFor(email.toLowerCase());
  expect(code).toBeDefined();
  return post(started.relay, "/api/register", { email, code, password: PASSWORD }, headers);
}

/** Any six digits other than `code`. */
const wrongCode = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("sign-in methods", () => {
  it("says separately whether registration is open and whether mail can be sent", async () => {
    const open = await startServer();
    expect((await api(open.relay, { path: "/api/auth/methods" })).json).toEqual({ registration: true, email: true, providers: [] });
    const closed = await startServer({ registration: "closed" });
    expect((await api(closed.relay, { path: "/api/auth/methods" })).json).toEqual({ registration: false, email: true, providers: [] });
    // Open without mail: provider sign-ups work, email sign-up doesn't.
    const mailless = await startServer({ mailer: null });
    expect((await api(mailless.relay, { path: "/api/auth/methods" })).json).toEqual({ registration: true, email: false, providers: [] });
    expect((await post(mailless.relay, "/api/register/code", { email: "new@example.com" })).status).toBe(403);
  });
});

describe("email sign-up", () => {
  it("answers the same whether or not the email has an account, and mails a code only to a new one", async () => {
    const started = await startServer({ bootstrapUser: "taken@example.com" });
    const fresh = await post(started.relay, "/api/register/code", { email: "new@example.com" });
    const taken = await post(started.relay, "/api/register/code", { email: "Taken@Example.com" });
    expect([fresh.status, fresh.text]).toEqual([taken.status, taken.text]);
    expect(fresh.status).toBe(202);

    expect(started.mail.sent.map((mail) => mail.to)).toEqual(["new@example.com", "taken@example.com"]);
    expect(started.mail.codeFor("new@example.com")).toMatch(/^\d{6}$/);
    expect(started.mail.codeFor("taken@example.com")).toBeUndefined();
    expect(started.mail.sent[1]!.text).toMatch(/already have an account/i);
  });

  it("creates the account with a verified email and signs it in, in the caller's credential style", async () => {
    const started = await startServer();
    const page = await signUp(started, "Bob@Example.com", { origin: ORIGIN });
    expect(page.status).toBe(200);
    expect(page.json.user).toEqual({ accountId: expect.any(String), username: "bob@example.com", email: "bob@example.com" });
    expect(page.json.token).toBeUndefined();
    expect(page.json.needsEmail).toBeUndefined();
    const cookie = String((page.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    expect((await api(started.relay, { path: "/api/me", headers: { cookie } })).json).toEqual({
      user: { accountId: expect.any(String), username: "bob@example.com", email: "bob@example.com" },
    });

    const desktop = await signUp(started, "carol@example.com", { origin: "app://pinomad" });
    expect(desktop.status).toBe(200);
    expect(typeof desktop.json.token).toBe("string");
    // Signs in by email afterwards, in any case.
    expect((await login(started.relay, "CAROL@example.com")).status).toBe(200);
  });

  it("keeps accounts apart: a new account sees none of another account's hosts", async () => {
    const started = await startServer();
    const hostId = relayHostId(ed25519.keygen().publicKey);
    const db = new DatabaseSync(`${started.dataDir}/server.sqlite`);
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, 'k', 'admin-host', 1, 1)").run(hostId);
    db.close();
    const bob = (await signUp(started, "bob@example.com")).json.token;

    expect((await api(started.relay, { path: "/api/hosts", headers: bearer(bob) })).json).toEqual([]);
    expect((await post(started.relay, `/api/hosts/${hostId}/pairing`, undefined, bearer(bob))).status).toBe(404);
    const admin = (await login(started.relay, "admin")).json.token;
    expect((await api(started.relay, { path: "/api/hosts", headers: bearer(admin) })).json).toHaveLength(1);
  });

  it("refuses a code that expired, was used, or took five wrong guesses", async () => {
    let clock = 1_000_000;
    const started = await startServer({ now: () => clock, limits: { userMaxFailures: 100, ipMaxAttempts: 100 } });
    const { relay, mail } = started;
    const register = (email: string, code: string) => post(relay, "/api/register", { email, code, password: PASSWORD });

    await post(relay, "/api/register/code", { email: "late@example.com" });
    clock += 10 * MINUTE;
    const expired = await register("late@example.com", mail.codeFor("late@example.com")!);
    expect([expired.status, expired.json.error]).toEqual([400, "invalid_code"]);

    const used = await signUp(started, "once@example.com");
    expect(used.status).toBe(200);
    expect((await register("once@example.com", mail.codeFor("once@example.com")!)).json.error).toBe("invalid_code");

    await post(relay, "/api/register/code", { email: "guess@example.com" });
    const code = mail.codeFor("guess@example.com")!;
    for (let i = 0; i < 5; i += 1) expect((await register("guess@example.com", wrongCode(code))).json.error).toBe("invalid_code");
    expect((await register("guess@example.com", code)).json.error).toBe("invalid_code");
    // A fresh code works again.
    await post(relay, "/api/register/code", { email: "guess@example.com" });
    expect((await register("guess@example.com", mail.codeFor("guess@example.com")!)).status).toBe(200);
  });

  it("counts wrong codes toward the login lockout", async () => {
    const started = await startServer({ limits: { userMaxFailures: 2, ipMaxAttempts: 100 } });
    await post(started.relay, "/api/register/code", { email: "bob@example.com" });
    const code = started.mail.codeFor("bob@example.com")!;
    for (let i = 0; i < 2; i += 1) {
      expect((await post(started.relay, "/api/register", { email: "bob@example.com", code: wrongCode(code), password: PASSWORD })).status).toBe(400);
    }
    expect((await post(started.relay, "/api/register", { email: "bob@example.com", code, password: PASSWORD })).status).toBe(429);
  });

  it("refuses a weak password without spending the code", async () => {
    const started = await startServer();
    await post(started.relay, "/api/register/code", { email: "bob@example.com" });
    const code = started.mail.codeFor("bob@example.com")!;
    const weak = await post(started.relay, "/api/register", { email: "bob@example.com", code, password: "short" });
    expect([weak.status, weak.json.error]).toEqual([400, "weak_password"]);
    expect((await post(started.relay, "/api/register", { email: "bob@example.com", code, password: PASSWORD })).status).toBe(200);
  });

  it("is closed when registration is off or no mail can be sent", async () => {
    for (const started of [await startServer({ registration: "closed" }), await startServer({ mailer: null })]) {
      const code = await post(started.relay, "/api/register/code", { email: "bob@example.com" });
      expect([code.status, code.json.error]).toEqual([403, "registration_closed"]);
      const register = await post(started.relay, "/api/register", { email: "bob@example.com", code: "123456", password: PASSWORD });
      expect([register.status, register.json.error]).toEqual([403, "registration_closed"]);
      expect(started.mail.sent).toEqual([]);
    }
  });

  it("answers desktop and native callers but not foreign pages", async () => {
    const started = await startServer();
    expect((await post(started.relay, "/api/register/code", { email: "a@example.com" }, { origin: "app://pinomad" })).status).toBe(202);
    expect((await post(started.relay, "/api/password/reset/code", { email: "a@example.com" })).status).toBe(202);
    const foreign = await post(started.relay, "/api/register/code", { email: "b@example.com" }, { origin: "https://evil.example" });
    expect([foreign.status, foreign.json.error]).toEqual([403, "origin_mismatch"]);
  });

  it("refuses malformed emails", async () => {
    const started = await startServer();
    for (const email of [
      "",
      "no-at-sign",
      "two@@example.com",
      "a b@example.com",
      `${"x".repeat(250)}@example.com`,
      7,
      // Header address syntax names another mailbox than the string it is,
      // so it would dodge the per-email limit.
      "a<victim@example.com>",
      "<victim@example.com>",
      "Name <victim@example.com>",
      "a@example.com,victim@example.com",
      '"a b"@example.com',
      "a@example.com\r\nBcc: victim@example.com",
      "a@exa mple.com",
    ]) {
      const response = await post(started.relay, "/api/register/code", { email });
      expect([response.status, response.json.error], String(email)).toEqual([400, "invalid_email"]);
    }
    expect(started.mail.sent).toEqual([]);
  });

  it("limits codes per address, per email, and server-wide", async () => {
    const started = await startServer({ codeLimits: { ipMax: 3, emailMax: 2, dailyMax: 100 } });
    const send = (email: string) => post(started.relay, "/api/register/code", { email });
    expect((await send("a@example.com")).status).toBe(202);
    expect((await send("a@example.com")).status).toBe(202);
    expect((await send("a@example.com")).status).toBe(429);
    expect((await send("b@example.com")).status).toBe(429);

    const global = await startServer({ codeLimits: { dailyMax: 2 } });
    expect((await post(global.relay, "/api/register/code", { email: "a@example.com" })).status).toBe(202);
    expect((await post(global.relay, "/api/password/reset/code", { email: "b@example.com" })).status).toBe(202);
    expect((await post(global.relay, "/api/register/code", { email: "c@example.com" })).status).toBe(429);
  });
});

describe("password reset by email", () => {
  it("mails a code only to an existing account, answering the same either way", async () => {
    const started = await startServer({ bootstrapUser: "admin@example.com" });
    const known = await post(started.relay, "/api/password/reset/code", { email: "admin@example.com" });
    const unknown = await post(started.relay, "/api/password/reset/code", { email: "nobody@example.com" });
    expect([known.status, known.text]).toEqual([unknown.status, unknown.text]);
    expect(started.mail.sent.map((mail) => mail.to)).toEqual(["admin@example.com"]);
  });

  it("sets the new password and ends every session, without signing in", async () => {
    const started = await startServer({ bootstrapUser: "admin@example.com" });
    const { relay, mail } = started;
    const token = (await login(relay, "admin@example.com")).json.token;
    await post(relay, "/api/password/reset/code", { email: "admin@example.com" });
    const code = mail.codeFor("admin@example.com")!;

    const wrong = await post(relay, "/api/password/reset", { email: "admin@example.com", code: wrongCode(code), password: NEW_PASSWORD });
    expect([wrong.status, wrong.json.error]).toEqual([400, "invalid_code"]);
    const reset = await post(relay, "/api/password/reset", { email: "admin@example.com", code, password: NEW_PASSWORD });
    expect(reset.status).toBe(204);
    expect(reset.headers["set-cookie"]).toBeUndefined();

    expect((await api(relay, { path: "/api/me", headers: bearer(token) })).status).toBe(401);
    expect((await login(relay, "admin@example.com")).status).toBe(401);
    expect((await login(relay, "admin@example.com", NEW_PASSWORD)).status).toBe(200);
    // Single use.
    expect((await post(relay, "/api/password/reset", { email: "admin@example.com", code, password: PASSWORD })).status).toBe(400);
  });

  it("is unavailable without mail", async () => {
    const started = await startServer({ mailer: null });
    const response = await post(started.relay, "/api/password/reset/code", { email: "admin@example.com" });
    expect([response.status, response.json.error]).toEqual([403, "email_unavailable"]);
  });
});

describe("legacy username accounts", () => {
  it("keep signing in by username, and are asked for an email only when mail can be sent", async () => {
    const mailless = await startServer({ mailer: null });
    const plain = await login(mailless.relay, "admin");
    expect(plain.status).toBe(200);
    expect(plain.json.user).toEqual({ accountId: expect.any(String), username: "admin" });
    expect(plain.json.needsEmail).toBeUndefined();
    expect(plain.json.admin).toBeUndefined();

    const mailing = await startServer();
    const asked = await login(mailing.relay, "admin");
    expect(asked.json.user).toEqual({ accountId: expect.any(String), username: "admin" });
    expect(asked.json.needsEmail).toBe(true);
    expect((await api(mailing.relay, { path: "/api/me", headers: bearer(asked.json.token) })).json).toEqual({
      user: { accountId: expect.any(String), username: "admin" },
      needsEmail: true,
    });
  });

  it("add a verified email from a mailed code, then sign in by it", async () => {
    const started = await startServer();
    const { relay, mail } = started;
    const token = (await login(relay, "admin")).json.token;
    expect((await post(relay, "/api/me/email/code", { email: "Kieran@Example.com", password: PASSWORD }, bearer(token))).status).toBe(202);
    const code = mail.codeFor("kieran@example.com")!;
    const wrong = await post(relay, "/api/me/email", { email: "kieran@example.com", code: wrongCode(code), password: PASSWORD }, bearer(token));
    expect([wrong.status, wrong.json.error]).toEqual([400, "invalid_code"]);
    const set = await post(relay, "/api/me/email", { email: "kieran@example.com", code, password: PASSWORD }, bearer(token));
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ user: { accountId: expect.any(String), username: "kieran@example.com", email: "kieran@example.com" } });

    const byEmail = await login(relay, "kieran@example.com");
    expect(byEmail.status).toBe(200);
    expect(byEmail.json.user).toEqual({ accountId: expect.any(String), username: "kieran@example.com", email: "kieran@example.com" });
    expect(byEmail.json.needsEmail).toBeUndefined();
    // The username keeps working during the migration (ADR-0044 §8).
    expect((await login(relay, "admin")).status).toBe(200);
  });

  it("can't take an email another account already has", async () => {
    const started = await startServer();
    await signUp(started, "bob@example.com");
    const token = (await login(started.relay, "admin")).json.token;
    const response = await post(started.relay, "/api/me/email/code", { email: "bob@example.com", password: PASSWORD }, bearer(token));
    expect([response.status, response.json.error]).toEqual([409, "email_taken"]);
  });

  it("need the current password to ask for or confirm a new email, under the login lockout", async () => {
    const started = await startServer({ limits: { userMaxFailures: 2, ipMaxAttempts: 100 } });
    const { relay, mail } = started;
    const token = (await login(relay, "admin")).json.token;
    // A stolen session alone can't even get a code sent.
    expect((await post(relay, "/api/me/email/code", { email: "thief@example.com" }, bearer(token))).status).toBe(400);
    const wrong = await post(relay, "/api/me/email/code", { email: "thief@example.com", password: "not the password" }, bearer(token));
    expect([wrong.status, wrong.json.error]).toEqual([403, "wrong_password"]);
    expect(mail.sent).toEqual([]);

    // A code alone doesn't confirm it either.
    expect((await post(relay, "/api/me/email/code", { email: "me@example.com", password: PASSWORD }, bearer(token))).status).toBe(202);
    const code = mail.codeFor("me@example.com")!;
    const noPassword = await post(relay, "/api/me/email", { email: "me@example.com", code }, bearer(token));
    expect(noPassword.status).toBe(400);
    const wrongConfirm = await post(relay, "/api/me/email", { email: "me@example.com", code, password: "not the password" }, bearer(token));
    expect([wrongConfirm.status, wrongConfirm.json.error]).toEqual([403, "wrong_password"]);
    expect((await post(relay, "/api/me/email", { email: "me@example.com", code, password: "still not it" }, bearer(token))).status).toBe(403);
    // Two wrong passwords in a row lock the account, as for login.
    expect((await post(relay, "/api/me/email", { email: "me@example.com", code, password: PASSWORD }, bearer(token))).status).toBe(429);
    expect((await login(relay, "admin")).status).toBe(429);
  });

  it("tell the old address when an email is replaced", async () => {
    const started = await startServer({ bootstrapUser: "old@example.com" });
    const { relay, mail } = started;
    const token = (await login(relay, "old@example.com")).json.token;
    await post(relay, "/api/me/email/code", { email: "new@example.com", password: PASSWORD }, bearer(token));
    const code = mail.codeFor("new@example.com")!;
    expect((await post(relay, "/api/me/email", { email: "new@example.com", code, password: PASSWORD }, bearer(token))).status).toBe(200);
    const notice = mail.sent.findLast((message) => message.to === "old@example.com");
    expect(notice?.text).toContain("new@example.com");
    expect((await login(relay, "new@example.com")).status).toBe(200);
  });

  it("get an email from the operator's CLI, which signs in by it at once", async () => {
    const started = await startServer({ mailer: null });
    await setUserEmail({ dataDir: started.dataDir, user: "admin", email: "Ops@Example.com" });
    const response = await login(started.relay, "ops@example.com");
    expect(response.status).toBe(200);
    expect(response.json.user).toEqual({ accountId: expect.any(String), username: "ops@example.com", email: "ops@example.com" });
  });
});

describe("accounts without an admin", () => {
  it("lets the first account delete itself", async () => {
    const started = await startServer();
    const token = (await login(started.relay, "admin")).json.token;
    expect((await post(started.relay, "/api/me/delete", { password: PASSWORD }, bearer(token))).status).toBe(204);
  });

  it("no longer serves invites", async () => {
    const started = await startServer();
    const token = (await login(started.relay, "admin")).json.token;
    expect((await api(started.relay, { method: "POST", path: "/api/invites", headers: bearer(token) })).status).toBe(404);
  });

  it("bootstraps an email account when the first user is an email", async () => {
    const started = await startServer({ bootstrapUser: "Owner@Example.com" });
    const response = await login(started.relay, "owner@example.com");
    expect(response.json.user).toEqual({ accountId: expect.any(String), username: "owner@example.com", email: "owner@example.com" });
  });

  it("adds accounts from the operator's CLI beside a running server", async () => {
    const started = await startServer({ registration: "closed" });
    await addUser({ dataDir: started.dataDir, email: "new@example.com", password: PASSWORD });
    expect((await login(started.relay, "new@example.com")).status).toBe(200);
    await expect(addUser({ dataDir: started.dataDir, email: "NEW@example.com", password: PASSWORD })).rejects.toThrow(/exists/);
    await expect(addUser({ dataDir: started.dataDir, email: "x@example.com", password: "short" })).rejects.toThrow();
  });
});

describe("upgrading from schema 8", () => {
  it("keeps users, sessions and hosts, and drops invites and the admin flag", async () => {
    const first = await startServer();
    const token = (await login(first.relay, "admin")).json.token as string;
    const hostId = relayHostId(ed25519.keygen().publicKey);
    const seed = new DatabaseSync(`${first.dataDir}/server.sqlite`);
    seed.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, 'k', 'omarchy', 1, 1)").run(hostId);
    seed.close();
    await stop(first);
    downgradeToSchema8(first.dataDir);

    const second = await startServer({ dataDir: first.dataDir });
    expect((await api(second.relay, { path: "/api/me", headers: bearer(token) })).status).toBe(200);
    expect(((await api(second.relay, { path: "/api/hosts", headers: bearer(token) })).json as unknown as { hostId: string }[]).map((host) => host.hostId)).toEqual([hostId]);
    expect((await login(second.relay, "admin")).status).toBe(200);
    await stop(second);

    const db = new DatabaseSync(`${first.dataDir}/server.sqlite`);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    const columns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((row) => row.name);
    db.close();
    expect(tables).not.toContain("invites");
    expect(columns).not.toContain("admin");
  });
});

describe("server CLI user commands", () => {
  const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

  async function run(args: readonly string[], stdin: string): Promise<{ code: number | null; output: string }> {
    const child = spawn(process.execPath, [mainPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stdin.end(stdin);
    const [code] = (await once(child, "close")) as [number | null];
    return { code, output };
  }

  it("adds an email account, sets an email on a legacy one, and resets a password by email", async () => {
    const dataDir = await tempDir(dirs);
    await (await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: PASSWORD })).close();

    expect((await run(["user", "add", "bob@example.com", "--data-dir", dataDir], `${PASSWORD}\n`)).code).toBe(0);
    expect((await run(["user", "set-email", "admin", "admin@example.com", "--data-dir", dataDir], "")).code).toBe(0);
    expect((await run(["passwd", "--user", "BOB@example.com", "--data-dir", dataDir], `${NEW_PASSWORD}\n`)).code).toBe(0);
    const refused = await run(["user", "set-email", "nobody", "x@example.com", "--data-dir", dataDir], "");
    expect(refused.code).toBe(1);

    const started = await startServer({ dataDir });
    expect((await login(started.relay, "bob@example.com", NEW_PASSWORD)).status).toBe(200);
    expect((await login(started.relay, "admin@example.com")).status).toBe(200);
  });
});

describe("credentials around mailed codes", () => {
  it("never logs a code when a mail fails to send", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const sent: string[] = [];
      const failing: Mailer = {
        send(_to, subject, { text }) {
          sent.push(subject, text);
          return Promise.reject(new Error(`rejected: ${subject}`));
        },
      };
      const started = await startServer({ mailer: failing });
      expect((await post(started.relay, "/api/register/code", { email: "a@example.com" })).status).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      const code = /\b(\d{6})\b/.exec(sent.join(" "))![1]!;
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).not.toContain(code);
    } finally {
      console.error = original;
    }
  });

  it("drops a reset code once the password changes", async () => {
    const started = await startServer({ bootstrapUser: "admin@example.com" });
    const { relay, mail } = started;
    const token = (await login(relay, "admin@example.com")).json.token;
    await post(relay, "/api/password/reset/code", { email: "admin@example.com" });
    const code = mail.codeFor("admin@example.com")!;
    expect((await post(relay, "/api/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, bearer(token))).status).toBe(204);
    const reset = await post(relay, "/api/password/reset", { email: "admin@example.com", code, password: "yet another long password" });
    expect([reset.status, reset.json.error]).toEqual([400, "invalid_code"]);
  });
});
