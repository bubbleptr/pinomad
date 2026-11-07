// The account model's ADR-0044 calls against scripted fetches: email sign-up
// and the needsEmail gate, provider sign-in over the desktop loopback, and
// finishing a pending provider sign-in in cookie mode.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { AccountFetch, AccountFetchInit } from "@pinomad/client/account.ts";
import { createAccountModel, type AccountModel } from "./account-model.ts";
import type { DesktopBridge } from "../host/desktop-bridge.ts";

const ORIGIN = "https://relay.example.com";

beforeEach(() => localStorage.clear());

const fakeFetch = (...script: { status: number; body?: unknown }[]) => {
  const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
  const impl: AccountFetch = (url, init) => {
    calls.push({ url, init });
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next === undefined) return Promise.reject(new Error("no scripted response"));
    return Promise.resolve({
      status: next.status,
      json: () => (next.body === undefined ? Promise.reject(new Error("empty")) : Promise.resolve(next.body)),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  };
  return { impl, calls };
};

const store = () => ({
  list: () => Promise.resolve([]),
  save: () => Promise.resolve(),
  remove: () => Promise.resolve(),
});

function makeModel(fake: ReturnType<typeof fakeFetch>, options?: { bridge?: DesktopBridge; navigate?: (url: string) => void }): AccountModel {
  return createAccountModel({
    origin: ORIGIN,
    fetch: fake.impl,
    hosts: store(),
    paired: () => Promise.resolve(),
    autoRegister: false,
    device: () => ({ id: "d".repeat(22), name: "Mac Chrome" }),
    ...(options?.bridge === undefined ? {} : { bridge: options.bridge }),
    ...(options?.navigate === undefined ? {} : { navigate: options.navigate }),
  });
}

const settled = async (model: AccountModel): Promise<void> => {
  await vi.waitFor(() => expect(model.state.status).not.toBe("checking"));
};

const signedOutCookie = [{ status: 401 }, { status: 401, body: { error: "unauthenticated" } }];
const body = (call: { init: AccountFetchInit | undefined }): Record<string, unknown> =>
  JSON.parse(call.init!.body!) as Record<string, unknown>;

describe("account model: email accounts (ADR-0044)", () => {
  it("creates an account from the mailed code and signs it in", async () => {
    const fake = fakeFetch(
      ...signedOutCookie,
      { status: 204 }, // register/code
      { status: 201, body: { user: { username: "ada@example.com", email: "ada@example.com" }, expiresAt: 1 } },
      { status: 200, body: [] }, // listHosts
    );
    const model = makeModel(fake);
    await settled(model);
    expect(await model.requestSignupCode({ email: "ada@example.com" })).toEqual({ ok: true, value: undefined });
    expect(await model.register({ email: "ada@example.com", code: "123456", password: "a long password" })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fake.calls[3]!.url).toBe(`${ORIGIN}/api/register`);
    expect(body(fake.calls[3]!)).toMatchObject({ email: "ada@example.com", code: "123456", password: "a long password" });
    expect(model.state).toMatchObject({ status: "signed-in", user: "ada@example.com", email: "ada@example.com" });
  });

  it("holds a legacy account at needsEmail until an email is saved", async () => {
    const fake = fakeFetch(
      ...signedOutCookie,
      { status: 200, body: { user: { username: "kieran" }, needsEmail: true, expiresAt: 1 } },
      { status: 200, body: [] },
      { status: 204 }, // me/email/code
      { status: 200, body: { user: { username: "kieran@example.com", email: "kieran@example.com" } } }, // me/email
    );
    const model = makeModel(fake);
    await settled(model);
    await model.login({ username: "kieran", password: "pw" });
    expect(model.state).toMatchObject({ status: "signed-in", user: "kieran", needsEmail: true });
    await model.requestEmailCode({ email: "kieran@example.com", password: "pw" });
    expect(await model.setEmail({ email: "kieran@example.com", code: "123456", password: "pw" })).toMatchObject({ ok: true });
    expect(model.state).toMatchObject({ status: "signed-in", user: "kieran@example.com", email: "kieran@example.com" });
    expect(model.state).not.toHaveProperty("needsEmail");
  });

  it("reads needsEmail from a session that was already there", async () => {
    const model = makeModel(
      fakeFetch({ status: 401 }, { status: 200, body: { user: { username: "kieran" }, needsEmail: true } }, { status: 200, body: [] }),
    );
    await vi.waitFor(() => expect(model.state).toMatchObject({ status: "signed-in", needsEmail: true }));
  });
});

describe("account model: provider sign-in (ADR-0044 §5)", () => {
  it("sends a cookie page to the server's start route", async () => {
    const navigate = vi.fn();
    const model = makeModel(fakeFetch(...signedOutCookie), { navigate });
    await settled(model);
    expect(model.providerFlow).toBe("redirect");
    void model.providerSignIn({ provider: "github" });
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/api/oauth/github/start?client=web`);
  });

  it("runs the desktop loopback with S256 PKCE and trades the code for a stored session", async () => {
    const saved: unknown[] = [];
    const oauthSignIn = vi.fn((input: { serverOrigin: string; provider: string; codeChallenge: string; state: string }) => {
      void input;
      return Promise.resolve({ code: "one-time" });
    });
    const bridge = {
      hosts: store(),
      account: { get: () => Promise.resolve(undefined), save: (account: unknown) => {
          saved.push(account);
          return Promise.resolve();
        }, clear: () => Promise.resolve() },
      oauthSignIn,
    } as unknown as DesktopBridge;
    const fake = fakeFetch(
      { status: 200, body: { user: { username: "ada@example.com", email: "ada@example.com" }, expiresAt: 1, token: "tok" } },
      { status: 200, body: [] },
    );
    const model = makeModel(fake, { bridge });
    await settled(model);
    expect(model.providerFlow).toBe("loopback");
    expect(await model.providerSignIn({ provider: "google", serverOrigin: ORIGIN })).toEqual({ ok: true, value: undefined });
    const asked = oauthSignIn.mock.calls[0]![0];
    expect(asked).toMatchObject({ serverOrigin: ORIGIN, provider: "google" });
    expect(asked.state).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(fake.calls[0]!.url).toBe(`${ORIGIN}/api/oauth/token`);
    const { code, code_verifier: verifier } = body(fake.calls[0]!) as { code: string; code_verifier: string };
    expect(code).toBe("one-time");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(asked.codeChallenge).toBe(toBase64Url(digest));
    expect(fromBase64Url(asked.codeChallenge)).toHaveLength(32);
    expect(saved).toEqual([{ serverOrigin: ORIGIN, token: "tok" }]);
    expect(model.state).toMatchObject({ status: "signed-in", mode: "bearer", user: "ada@example.com" });
  });

  it("refuses a plaintext server before opening a browser", async () => {
    const oauthSignIn = vi.fn();
    const bridge = { hosts: store(), account: { get: () => Promise.resolve(undefined) }, oauthSignIn } as unknown as DesktopBridge;
    const model = makeModel(fakeFetch({ status: 500 }), { bridge });
    await settled(model);
    expect(await model.providerSignIn({ provider: "google", serverOrigin: "http://nomad.example.com" })).toEqual({
      ok: false,
      error: { code: "insecure_origin" },
    });
    expect(oauthSignIn).not.toHaveBeenCalled();
  });

  it("passes the loopback's error through without a session", async () => {
    const bridge = {
      hosts: store(),
      account: { get: () => Promise.resolve(undefined) },
      oauthSignIn: () => Promise.resolve({ error: "access_denied" }),
    } as unknown as DesktopBridge;
    const model = makeModel(fakeFetch({ status: 500 }), { bridge });
    await settled(model);
    expect(await model.providerSignIn({ provider: "google", serverOrigin: ORIGIN })).toEqual({
      ok: false,
      error: { code: "access_denied" },
    });
    expect(model.state.status).toBe("signed-out");
  });

  it("offers no provider flow on a desktop bridge without the loopback", async () => {
    const bridge = { hosts: store(), account: { get: () => Promise.resolve(undefined) } } as unknown as DesktopBridge;
    const model = makeModel(fakeFetch({ status: 500 }), { bridge });
    await settled(model);
    expect(model.providerFlow).toBeUndefined();
  });
});

describe("account model: pending provider sign-in (ADR-0044 §4)", () => {
  it("creating the account adopts the new cookie session", async () => {
    const fake = fakeFetch(
      ...signedOutCookie,
      { status: 200, body: { user: { username: "ada@example.com", email: "ada@example.com" }, expiresAt: 1 } }, // create
      { status: 200, body: [] },
    );
    const model = makeModel(fake);
    await settled(model);
    expect(await model.createFromPending("p".repeat(43))).toEqual({ ok: true, value: {} });
    expect(fake.calls[2]!.url).toBe(`${ORIGIN}/api/oauth/pending/${"p".repeat(43)}/create`);
    expect(model.state).toMatchObject({ status: "signed-in", user: "ada@example.com" });
  });

  it("hands a native app's redirect back without signing this page in", async () => {
    const redirect = "http://127.0.0.1:5000/callback?code=c&state=s";
    const model = makeModel(fakeFetch(...signedOutCookie, { status: 200, body: { redirect } }));
    await settled(model);
    expect(await model.createFromPending("p".repeat(43), { password: "a long password" })).toEqual({
      ok: true,
      value: { redirect },
    });
    expect(model.state.status).toBe("signed-out");
  });

  it("signs in with the password, then links with the same password", async () => {
    const fake = fakeFetch(
      ...signedOutCookie,
      { status: 200, body: { user: { username: "ada@example.com", email: "ada@example.com" }, expiresAt: 1 } }, // login
      { status: 200, body: [] }, // listHosts
      { status: 204 }, // link
    );
    const model = makeModel(fake);
    await settled(model);
    expect(await model.signInAndLinkPending("p".repeat(43), { username: "ada@example.com", password: "pw" })).toEqual({
      ok: true,
      value: {},
    });
    expect(fake.calls[4]!.url).toBe(`${ORIGIN}/api/oauth/pending/${"p".repeat(43)}/link`);
    expect(body(fake.calls[4]!)).toEqual({ password: "pw" });
  });
});

describe("account model: sign-ins that were overtaken (PR #630 review)", () => {
  /** A fetch that answers by path, recording each call. */
  const routed = (routes: Record<string, () => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>>) => {
    const calls: string[] = [];
    const impl: AccountFetch = async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const route = routes[path];
      if (route === undefined) return Promise.reject(new Error(`unrouted ${path}`));
      const answer = await route();
      return {
        status: answer.status,
        json: () => (answer.body === undefined ? Promise.reject(new Error("empty")) : Promise.resolve(answer.body)),
        text: () => Promise.resolve(JSON.stringify(answer.body)),
      };
    };
    return { impl, calls };
  };

  const bearerBridge = () => {
    const saved: unknown[] = [];
    let answer: ((result: { code: string }) => void) | undefined;
    const bridge = {
      hosts: store(),
      account: {
        get: () => Promise.resolve(undefined),
        save: (account: unknown) => {
          saved.push(account);
          return Promise.resolve();
        },
        clear: () => Promise.resolve(),
      },
      oauthSignIn: () => new Promise<{ code: string }>((resolve) => (answer = resolve)),
    } as unknown as DesktopBridge;
    return { bridge, saved, asked: () => answer !== undefined, answer: (code: string) => answer!({ code }) };
  };

  const bob = { status: 200, body: { user: { username: "bob@example.com", email: "bob@example.com" }, expiresAt: 1, token: "bob-token" } };
  const alice = { status: 200, body: { user: { username: "alice@example.com", email: "alice@example.com" }, expiresAt: 1, token: "alice-token" } };

  it("drops a loopback that comes back after another sign-in", async () => {
    const { bridge, saved, asked, answer } = bearerBridge();
    const fake = routed({ "/api/login": () => bob, "/api/hosts": () => ({ status: 200, body: [] }), "/api/oauth/token": () => alice });
    const model = makeModel({ impl: fake.impl, calls: [] }, { bridge });
    await settled(model);
    const google = model.providerSignIn({ provider: "google", serverOrigin: ORIGIN });
    await vi.waitFor(() => expect(asked()).toBe(true));
    await model.login({ username: "bob@example.com", password: "pw", serverOrigin: ORIGIN });
    answer("late");
    expect((await google).ok).toBe(false);
    expect(fake.calls).not.toContain("/api/oauth/token");
    expect(model.state).toMatchObject({ status: "signed-in", user: "bob@example.com" });
    expect(saved).toEqual([{ serverOrigin: ORIGIN, token: "bob-token" }]);
  });

  it("drops a code exchange that answers after another sign-in", async () => {
    const { bridge, saved, asked, answer } = bearerBridge();
    let exchanged!: () => void;
    const fake = routed({
      "/api/login": () => bob,
      "/api/hosts": () => ({ status: 200, body: [] }),
      "/api/oauth/token": () => new Promise((resolve) => (exchanged = () => resolve(alice))),
    });
    const model = makeModel({ impl: fake.impl, calls: [] }, { bridge });
    await settled(model);
    const google = model.providerSignIn({ provider: "google", serverOrigin: ORIGIN });
    await vi.waitFor(() => expect(asked()).toBe(true));
    answer("code");
    await vi.waitFor(() => expect(fake.calls).toContain("/api/oauth/token"));
    await model.login({ username: "bob@example.com", password: "pw", serverOrigin: ORIGIN });
    exchanged();
    expect((await google).ok).toBe(false);
    expect(model.state).toMatchObject({ status: "signed-in", user: "bob@example.com" });
    expect(saved).toEqual([{ serverOrigin: ORIGIN, token: "bob-token" }]);
  });

  it("keeps the next account's profile when an earlier account's email change lands late", async () => {
    let saveAlice!: () => void;
    const fake = routed({
      "/api/me": () => ({ status: 401, body: { error: "unauthenticated" } }),
      "/api/login": () => ({ status: 200, body: { user: { username: "bob" }, needsEmail: true, expiresAt: 1 } }),
      "/api/hosts": () => ({ status: 200, body: [] }),
      "/api/logout": () => ({ status: 204 }),
      "/api/me/email": () =>
        new Promise((resolve) =>
          (saveAlice = () => resolve({ status: 200, body: { user: { username: "alice@example.com", email: "alice@example.com" } } }))),
    });
    const model = makeModel({ impl: fake.impl, calls: [] });
    await settled(model);
    await model.login({ username: "alice", password: "pw" });
    const saving = model.setEmail({ email: "alice@example.com", code: "123456", password: "pw" });
    await vi.waitFor(() => expect(fake.calls).toContain("/api/me/email"));
    await model.logout();
    await model.login({ username: "bob", password: "pw" });
    saveAlice();
    await saving;
    expect(model.state).toMatchObject({ status: "signed-in", user: "bob", needsEmail: true });
    expect(model.state).not.toHaveProperty("email");
  });
});
