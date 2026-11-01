// The account model against scripted fetches: mode detection, login in both
// credential styles, host-list matching against the stored hosts, and the
// "rejected host never auto-repairs" pin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { AccountDeviceClaim, AccountFetch, AccountFetchInit } from "@pinomad/client/account.ts";
import {
  createAccountModel,
  type AccountLocks,
  type AccountModel,
  type AccountVisibility,
} from "./account-model.ts";
import { createDeclinedStore, type DeclinedStore } from "./declined.ts";
import { createDeviceIdSource } from "./device-id.ts";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import type { StoredHost } from "../host/host-store.ts";

const ORIGIN = "https://relay.example.com";
const USER = { user: { username: "admin" }, expiresAt: 1 };

beforeEach(() => localStorage.clear());

/** A fetch stand-in: records calls, answers from a script. */
const fakeFetch = (...script: { status: number; body?: unknown }[]) => {
  const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
  const impl: AccountFetch = (url, init) => {
    calls.push({ url, init });
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next === undefined) return Promise.reject(new Error("no scripted response"));
    return Promise.resolve({
      status: next.status,
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    });
  };
  return { impl, calls };
};

const hosts = (initial: StoredHost[] = [], options?: { failList?: boolean }) => {
  const stored: StoredHost[] = [...initial];
  const saved: StoredHost[] = [];
  let failSaves = false;
  let failList = options?.failList === true;
  return {
    stored,
    saved,
    setFailSaves: (value: boolean) => {
      failSaves = value;
    },
    setFailList: (value: boolean) => {
      failList = value;
    },
    list: () => (failList ? Promise.reject(new Error("store unavailable")) : Promise.resolve([...stored])),
    save: (host: StoredHost) => {
      if (failSaves) return Promise.reject(new Error("store unavailable"));
      saved.push(host);
      const index = stored.findIndex((each) => each.hostKey === host.hostKey);
      if (index === -1) stored.push(host);
      else stored[index] = host;
      return Promise.resolve();
    },
    remove: (hostKey: string) => {
      const index = stored.findIndex((each) => each.hostKey === hostKey);
      if (index !== -1) stored.splice(index, 1);
      return Promise.resolve();
    },
  };
};

const storedHost = (overrides?: Partial<StoredHost>): StoredHost => ({
  url: "wss://relay.example.com/c/x",
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
  ...overrides,
});

const accountHost = (noisePublicKey: string, hostId = "host-id") => ({
  hostId,
  name: "omarchy",
  noisePublicKey,
  online: true,
  lastSeenAt: 1,
  pairing: "available" as const,
});

interface Setup {
  model: AccountModel;
  calls: { url: string; init: AccountFetchInit | undefined }[];
  store: ReturnType<typeof hosts>;
  paired: StoredHost[];
}

function makeModel(options: {
  fake: ReturnType<typeof fakeFetch>;
  store?: ReturnType<typeof hosts>;
  bridge?: DesktopBridge;
  declined?: DeclinedStore;
  locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
  connect?: () => Promise<void>;
  autoRegister?: boolean;
  removeHost?: (hostKey: string) => Promise<void>;
  visibility?: AccountVisibility;
  device?: () => AccountDeviceClaim;
}): Setup {
  const store = options.store ?? hosts();
  const paired: StoredHost[] = [];
  const model = createAccountModel({
    origin: ORIGIN,
    fetch: options.fake.impl,
    hosts: store,
    paired: (host) => {
      paired.push(host);
      return store.save(host);
    },
    name: () => "test device",
    connect: options.connect ?? (() => Promise.resolve()),
    // Auto-registration has its own suite; keep the older cases focused.
    autoRegister: options.autoRegister === true,
    ...(options.declined === undefined ? {} : { declined: options.declined }),
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.removeHost === undefined ? {} : { removeHost: options.removeHost }),
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
    ...(options.device === undefined ? {} : { device: options.device }),
  });
  return { model, calls: options.fake.calls, store, paired };
}

/** Polls until the model leaves `checking`. */
const settled = async (model: AccountModel): Promise<void> => {
  await vi.waitFor(() => expect(model.state.status).not.toBe("checking"));
};

describe("account model", () => {
  it("is unavailable when the page origin runs no accounts", async () => {
    const { model } = makeModel({ fake: fakeFetch({ status: 404, body: { error: "accounts_disabled" } }) });
    await settled(model);
    expect(model.state).toEqual({ status: "unavailable" });
  });

  it("cookie mode: signs in on a live session, lists matched hosts", async () => {
    const entry = storedHost();
    const store = hosts([entry]);
    const setup = makeModel({ fake: fakeFetch(
      { status: 401, body: { error: "unauthenticated" } }, // probe
      { status: 200, body: { user: { username: "admin" } } }, // me
      { status: 200, body: [accountHost(entry.hostKey)] }, // listHosts
    ), store });
    const { model, calls } = setup;
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    const state = model.state as Extract<typeof model.state, { status: "signed-in" }>;
    expect(state.mode).toBe("cookie");
    expect(state.user).toBe("admin");
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]).toMatchObject({ status: "paired", linkable: true });
    // Cookie requests carry credentials and no Authorization header — calls[0]
    // is the probe, which asks for /api/me directly and needs neither.
    expect(calls.slice(1).every((call) => call.init?.credentials === "same-origin")).toBe(true);
    expect(calls.every((call) => call.init?.headers?.authorization === undefined)).toBe(true);
  });

  it("adopts a pre-account pairing by persisting the link", async () => {
    const entry = storedHost();
    const store = hosts([entry]);
    const setup = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [accountHost(entry.hostKey, "h-1")] },
    ), store });
    await vi.waitFor(() => expect(setup.model.state.status).toBe("signed-in"));
    await vi.waitFor(() =>
      expect(store.stored[0]!.account).toEqual({ serverOrigin: ORIGIN, hostId: "h-1" }),
    );
    // The app's in-memory list learns the link too, so a later forget declines it.
    expect(setup.paired).toEqual([{ ...entry, account: { serverOrigin: ORIGIN, hostId: "h-1" } }]);
  });

  it("cookie mode: signed-out when the probe says enabled but there is no session", async () => {
    const { model } = makeModel({ fake: fakeFetch({ status: 401 }, { status: 401, body: { error: "unauthenticated" } }) });
    await settled(model);
    expect(model.state).toEqual({ status: "signed-out", mode: "cookie", serverOrigin: ORIGIN });
  });

  it("cookie login needs no token and signs straight in", async () => {
    const { model, calls } = makeModel({ fake: fakeFetch(
      { status: 401 }, // probe
      { status: 401, body: { error: "unauthenticated" } }, // me
      { status: 200, body: USER }, // login — no token in cookie mode
      { status: 200, body: [] }, // listHosts
    ) });
    await settled(model);
    const result = await model.login({ username: "admin", password: "pw" });
    expect(result.ok).toBe(true);
    expect(model.state).toMatchObject({ status: "signed-in", user: "admin", hosts: [] });
    expect(calls[2]!.init?.headers?.authorization).toBeUndefined();
  });

  it("claims the same account device at every login and sign-up, across reloads (#452)", async () => {
    const items = new Map<string, string>();
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
    const page = () => {
      const deviceId = createDeviceIdSource(() => storage);
      return () => ({ id: deviceId(), name: "Mac Chrome" });
    };
    const signedOut = [{ status: 401 }, { status: 401, body: { error: "unauthenticated" } }];
    const first = makeModel({
      fake: fakeFetch(
        ...signedOut,
        { status: 200, body: USER }, // login
        { status: 200, body: [] },
        { status: 204 }, // logout
        { status: 200, body: { user: { username: "bob" }, expiresAt: 1 } }, // register
        { status: 200, body: [] },
      ),
      device: page(),
    });
    await settled(first.model);
    expect((await first.model.login({ username: "admin", password: "pw" })).ok).toBe(true);
    await first.model.logout();
    expect((await first.model.register({ invite: "code", username: "bob", password: "pw" })).ok).toBe(true);
    const claims = [first.calls[2]!, first.calls[5]!].map((call) => (JSON.parse(call.init!.body!) as { device: unknown }).device);
    const id = items.values().next().value as string;
    expect(claims).toEqual([
      { id, name: "Mac Chrome" },
      { id, name: "Mac Chrome" },
    ]);

    // A reload reads the same id back instead of minting another device.
    const second = makeModel({
      fake: fakeFetch(...signedOut, { status: 200, body: USER }, { status: 200, body: [] }),
      device: page(),
    });
    await settled(second.model);
    await second.model.login({ username: "admin", password: "pw" });
    expect(JSON.parse(second.calls[2]!.init!.body!)).toEqual({ username: "admin", password: "pw", device: { id, name: "Mac Chrome" } });
  });

  it("lists the account's devices and kicks one; a kick's refusal keeps the session (#452)", async () => {
    const devices = [
      { id: 2, name: "Mac Chrome", createdAt: 1, lastSeenAt: 2, current: true, hosts: [] },
      { id: 3, createdAt: 1, lastSeenAt: 1, current: false, hosts: [{ hostId: "h1", name: "omarchy", state: "registered" }] },
    ];
    const { model, calls } = makeModel({
      fake: fakeFetch(
        { status: 401 },
        { status: 200, body: { user: { username: "bob" } } },
        { status: 200, body: [] },
        { status: 200, body: devices },
        { status: 403, body: { error: "wrong_password" } },
        { status: 204 },
        { status: 401, body: { error: "unauthenticated" } },
      ),
    });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    expect(await model.listDevices()).toEqual({ ok: true, value: devices });
    expect(await model.kickDevice({ id: 3, password: "nope" })).toEqual({ ok: false, error: { code: "wrong_password", status: 403 } });
    expect(model.state.status).toBe("signed-in");
    expect((await model.kickDevice({ id: 3, password: "pw" })).ok).toBe(true);
    expect(calls[5]!.url).toBe(`${ORIGIN}/api/devices/3/kick`);
    expect(JSON.parse(calls[5]!.init!.body!)).toEqual({ password: "pw" });
    // The session itself was kicked from elsewhere meanwhile.
    expect((await model.listDevices()).ok).toBe(false);
    expect(model.state.status).toBe("signed-out");
  });

  it("bearer mode (desktop): restores a stored session, validates the origin on login", async () => {
    const saved: { serverOrigin: string; token: string }[] = [];
    const account = {
      get: () => Promise.resolve({ serverOrigin: ORIGIN, token: "stored-token" }),
      save: (a: { serverOrigin: string; token: string }) => {
        saved.push(a);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };
    const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
    const { model, calls } = makeModel({ fake: fakeFetch(
      { status: 200, body: { user: { username: "admin" } } }, // me with stored token
      { status: 200, body: [] }, // listHosts
    ), bridge });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    expect(calls[0]!.init?.headers?.authorization).toBe("Bearer stored-token");
    expect(calls[0]!.init?.credentials).toBeUndefined();

    // login refuses a plaintext origin before asking the server.
    const bad = await model.login({ username: "a", password: "p", serverOrigin: "http://lan.example.com" });
    expect(bad).toEqual({ ok: false, error: { code: "insecure_origin" } });
    expect(calls).toHaveLength(2);
  });

  it("bearer login saves the token through the bridge", async () => {
    const saved: { serverOrigin: string; token: string }[] = [];
    const account = {
      get: () => Promise.resolve(undefined),
      save: (a: { serverOrigin: string; token: string }) => {
        saved.push(a);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };
    const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
    const { model } = makeModel({ fake: fakeFetch(
      { status: 200, body: { ...USER, token: "fresh-token" } },
      { status: 200, body: [] },
    ), bridge });
    await settled(model);
    const result = await model.login({ username: "admin", password: "pw", serverOrigin: `${ORIGIN}/` });
    expect(result.ok).toBe(true);
    expect(saved).toEqual([{ serverOrigin: ORIGIN, token: "fresh-token" }]);
    expect(model.state).toMatchObject({ status: "signed-in", mode: "bearer", serverOrigin: ORIGIN });
  });

  it("bearer sign-up with an invite saves the token and signs in like login (#449)", async () => {
    const saved: { serverOrigin: string; token: string }[] = [];
    const account = {
      get: () => Promise.resolve(undefined),
      save: (a: { serverOrigin: string; token: string }) => {
        saved.push(a);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };
    const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
    const { model, calls } = makeModel({ fake: fakeFetch(
      { status: 200, body: { user: { username: "bob" }, expiresAt: 1, token: "fresh-token" } },
      { status: 200, body: [] },
    ), bridge });
    await settled(model);
    const result = await model.register({ invite: "code", username: "bob", password: "pw", serverOrigin: ORIGIN });
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/register`);
    expect(saved).toEqual([{ serverOrigin: ORIGIN, token: "fresh-token" }]);
    expect(model.state).toMatchObject({ status: "signed-in", user: "bob", admin: false });
  });

  it("knows the admin from login and from a restored session", async () => {
    const restored = makeModel({ fake: fakeFetch(
      { status: 401 }, // probe
      { status: 200, body: { user: { username: "admin" }, admin: true } }, // me
      { status: 200, body: [] },
    ) });
    await vi.waitFor(() => expect(restored.model.state).toMatchObject({ status: "signed-in", admin: true }));

    const fresh = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 401, body: { error: "unauthenticated" } },
      { status: 200, body: { ...USER, admin: true } },
      { status: 200, body: [] },
    ) });
    await settled(fresh.model);
    await fresh.model.login({ username: "admin", password: "pw" });
    expect(fresh.model.state).toMatchObject({ status: "signed-in", admin: true });
  });

  it("a dead session drops back to signed-out and clears the stored token", async () => {
    let cleared = 0;
    const account = {
      get: () => Promise.resolve({ serverOrigin: ORIGIN, token: "dead-token" }),
      save: () => Promise.resolve(),
      clear: () => {
        cleared += 1;
        return Promise.resolve();
      },
    };
    const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
    const { model } = makeModel({ fake: fakeFetch({ status: 401, body: { error: "unauthenticated" } }), bridge });
    await settled(model);
    expect(model.state).toMatchObject({ status: "signed-out", mode: "bearer", serverOrigin: ORIGIN });
    expect(cleared).toBe(1);
  });

  it("pairHost pairs through the injected handshake and persists the link", async () => {
    const store = hosts();
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/h1" },
        { transport: "webSocket" as const, role: "direct" as const, url: "wss://direct.example:8443/secure" },
      ],
    };
    const offer = {
      url: "wss://relay.example.com/c/h1",
      hostKey: toBase64Url(generateKeyPair().publicKey),
      secret: toBase64Url(generateKeyPair().privateKey),
      expiresAt: Date.now() + 60_000,
      endpointSet,
    };
    const setup = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [accountHost("other-key", "h1")] },
      { status: 200, body: offer }, // POST /api/hosts/h1/pairing
      { status: 200, body: [] }, // refresh after pairing
    ), store });
    await vi.waitFor(() => expect(setup.model.state.status).toBe("signed-in"));
    const result = await setup.model.pairHost("h1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `vouched`: the key came from the account's own offer (#494).
    expect(result.value.account).toEqual({ serverOrigin: ORIGIN, hostId: "h1", vouched: true });
    // Account Pair forwards the same candidates into the persisted record.
    expect(result.value.endpointSet).toEqual(endpointSet);
    // The account row's name seeds the stored entry (5.12).
    expect(result.value.name).toBe("omarchy");
    expect(setup.calls[3]!.init?.method).toBe("POST");
    expect(setup.calls[3]!.url).toBe(`${ORIGIN}/api/hosts/h1/pairing`);
    expect(setup.paired).toEqual([result.value]);
    expect(store.stored).toContainEqual(result.value);
  });

  it("hostRejected only marks the host — it never asks for an invite", async () => {
    const entry = storedHost();
    const store = hosts([entry]);
    const { model, calls } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [accountHost(entry.hostKey)] },
    ), store });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    const before = calls.length;

    model.hostRejected(entry.hostKey);
    model.hostRejected(entry.hostKey);

    expect(calls).toHaveLength(before); // no /pairing ask, no fetch at all
    const state = model.state as Extract<typeof model.state, { status: "signed-in" }>;
    expect(state.rejectedHostKeys).toEqual([entry.hostKey]);
    // And the host still reports its stored pairing — rejection is display state.
    expect(state.hosts[0]).toMatchObject({ status: "paired" });
  });

  it("clears a 4401 rejection after a successful account re-pair", async () => {
    const entry = storedHost({ account: { serverOrigin: ORIGIN, hostId: "h1" } });
    const store = hosts([entry]);
    const offer = {
      url: "wss://relay.example.com/c/h1",
      hostKey: entry.hostKey,
      secret: toBase64Url(generateKeyPair().privateKey),
      expiresAt: Date.now() + 60_000,
    };
    const { model } = makeModel({
      fake: fakeFetch(
        { status: 401 },
        { status: 200, body: { user: { username: "admin" } } },
        { status: 200, body: [accountHost(entry.hostKey, "h1")] },
        { status: 200, body: offer },
        { status: 200, body: [accountHost(entry.hostKey, "h1")] },
      ),
      store,
    });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    model.hostRejected(entry.hostKey);
    expect((model.state as Extract<typeof model.state, { status: "signed-in" }>).rejectedHostKeys).toEqual([
      entry.hostKey,
    ]);

    const result = await model.pairHost("h1");
    expect(result.ok).toBe(true);
    expect((model.state as Extract<typeof model.state, { status: "signed-in" }>).rejectedHostKeys).toEqual([]);
  });

  it("keeps the paired record when the store save fails, for retry", async () => {
    const store = hosts();
    store.setFailSaves(true);
    const offer = {
      url: "wss://relay.example.com/c/h1",
      hostKey: toBase64Url(generateKeyPair().publicKey),
      secret: toBase64Url(generateKeyPair().privateKey),
      expiresAt: Date.now() + 60_000,
    };
    const { model } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [] },
      { status: 200, body: offer },
    ), store });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));

    // The device is already registered on the host — the failed save must not
    // swallow the identity; it waits in state for a retry.
    const result = await model.pairHost("h1");
    expect(result).toEqual({ ok: false, error: { code: "pairing_not_saved" } });
    const pending = (model.state as Extract<typeof model.state, { status: "signed-in" }>).unsavedHosts[0];
    expect(pending).toBeDefined();
    expect(store.stored).toHaveLength(0);

    store.setFailSaves(false);
    expect(await model.retryUnsavedHost()).toEqual({ ok: true, value: undefined });
    expect(store.stored).toEqual([pending]);
    expect((model.state as Extract<typeof model.state, { status: "signed-in" }>).unsavedHosts).toEqual([]);
  });

  it("drops the stale linked record when a key-changed host is re-paired", async () => {
    const old = storedHost({ account: { serverOrigin: ORIGIN, hostId: "h1" } });
    const newKey = toBase64Url(generateKeyPair().publicKey);
    const store = hosts([old]);
    const offer = {
      url: "wss://relay.example.com/c/h1",
      hostKey: newKey,
      secret: toBase64Url(generateKeyPair().privateKey),
      expiresAt: Date.now() + 60_000,
    };
    const removed: string[] = [];
    const { model } = makeModel({
      fake: fakeFetch(
        { status: 401 },
        { status: 200, body: { user: { username: "admin" } } },
        { status: 200, body: [accountHost(newKey, "h1")] },
        { status: 200, body: offer },
        { status: 200, body: [accountHost(newKey, "h1")] },
      ),
      store,
      removeHost: async (hostKey) => {
        removed.push(hostKey);
        await store.remove(hostKey);
      },
    });
    await vi.waitFor(() => {
      const state = model.state as Extract<typeof model.state, { status: "signed-in" }>;
      expect(state.hosts[0]?.status).toBe("key_changed");
    });

    const result = await model.pairHost("h1");
    expect(result.ok).toBe(true);
    // The old key's link is dead — only the fresh record remains, and the app
    // runtime table is told through the non-declining removal path.
    expect(removed).toEqual([old.hostKey]);
    expect(store.stored.map((each) => each.hostKey)).toEqual([newKey]);
    expect(store.stored[0]!.account).toEqual({ serverOrigin: ORIGIN, hostId: "h1", vouched: true });
  });

  it("a late refresh never resurrects a signed-out session", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let hostsCalls = 0;
    const scripted = fakeFetch(
      { status: 401 }, // probe
      { status: 200, body: { user: { username: "admin" } } }, // me
    );
    const fetch: AccountFetch = (url, init) => {
      if (url.endsWith("/api/hosts")) {
        // The first listHosts (init's refresh) answers; the in-flight one hangs.
        hostsCalls += 1;
        const okEmpty = { status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve("[]") };
        if (hostsCalls === 1) return Promise.resolve(okEmpty);
        return gate.then(() => okEmpty);
      }
      // logout and anything else get an empty 204 — what matters is the call went out.
      if (url.endsWith("/api/logout"))
        return Promise.resolve({ status: 204, json: () => Promise.resolve(undefined), text: () => Promise.resolve("") });
      return scripted.impl(url, init);
    };
    const { model } = makeModel({ fake: { impl: fetch, calls: [] } });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));

    const pending = model.refreshHosts();
    await model.logout();
    expect(model.state.status).toBe("signed-out");
    release!();
    await pending;
    expect(model.state.status).toBe("signed-out");
  });

  it("changes the password and stays signed in; a wrong current password doesn't sign out (#450)", async () => {
    const { model, calls } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [] },
      { status: 403, body: { error: "wrong_password" } },
      { status: 204 },
    ) });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    const wrong = await model.changePassword({ currentPassword: "nope", newPassword: "a long new password" });
    expect(wrong).toEqual({ ok: false, error: { code: "wrong_password", status: 403 } });
    expect(model.state.status).toBe("signed-in");
    const changed = await model.changePassword({ currentPassword: "pw", newPassword: "a long new password" });
    expect(changed.ok).toBe(true);
    expect(model.state.status).toBe("signed-in");
    expect(calls[4]!.url).toBe(`${ORIGIN}/api/password`);
    expect(JSON.parse(calls[4]!.init!.body as string)).toEqual({ currentPassword: "pw", newPassword: "a long new password" });
  });

  it("deletes the account and lands signed-out; a refusal or a network failure keeps the session (#451)", async () => {
    const { model, calls, store } = makeModel({
      fake: fakeFetch(
        { status: 401 },
        { status: 200, body: { user: { username: "bob" } } },
        { status: 200, body: [] },
        { status: 403, body: { error: "wrong_password" } },
        { status: 0 },
        { status: 204 },
      ),
      store: hosts([storedHost({ account: { serverOrigin: ORIGIN, hostId: "h1" } })]),
    });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    expect(await model.deleteAccount({ password: "nope" })).toEqual({ ok: false, error: { code: "wrong_password", status: 403 } });
    expect(model.state.status).toBe("signed-in");
    expect(await model.deleteAccount({ password: "pw" })).toEqual({ ok: false, error: { code: "network" } });
    expect(model.state.status).toBe("signed-in");
    expect((await model.deleteAccount({ password: "pw" })).ok).toBe(true);
    expect(calls[5]!.url).toBe(`${ORIGIN}/api/me/delete`);
    expect(JSON.parse(calls[5]!.init!.body as string)).toEqual({ password: "pw" });
    expect(model.state).toEqual({ status: "signed-out", mode: "cookie", serverOrigin: ORIGIN });
    // The device's registration on each host is the host's to revoke: the pairing stays.
    expect(store.stored).toHaveLength(1);
  });

  it("bearer account deletion clears the stored token (#451)", async () => {
    let cleared = 0;
    const account = {
      get: () => Promise.resolve({ serverOrigin: ORIGIN, token: "tok" }),
      save: () => Promise.resolve(),
      clear: () => {
        cleared += 1;
        return Promise.resolve();
      },
    };
    const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
    const { model } = makeModel({ fake: fakeFetch(
      { status: 200, body: { user: { username: "bob" } } },
      { status: 200, body: [] },
      { status: 204 },
    ), bridge });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    expect((await model.deleteAccount({ password: "pw" })).ok).toBe(true);
    expect(model.state).toMatchObject({ status: "signed-out", mode: "bearer", serverOrigin: ORIGIN });
    expect(cleared).toBe(1);
  });

  describe("an answer that lands after sign-out and a new sign-in belongs to the old session", () => {
    // Bearer mode: the stored token is what a stale result could wipe.
    const setup = (path: string) => {
      let token: string | undefined = "a-token";
      const account = {
        get: () => Promise.resolve(token === undefined ? undefined : { serverOrigin: ORIGIN, token }),
        save: (saved: { token: string }) => {
          token = saved.token;
          return Promise.resolve();
        },
        clear: () => {
          token = undefined;
          return Promise.resolve();
        },
      };
      const bridge = { hosts: { list: () => Promise.resolve([]), save: () => Promise.resolve(), remove: () => Promise.resolve() }, account } as unknown as DesktopBridge;
      let answer!: (response: { status: number; body?: unknown }) => void;
      const deferred = new Promise<{ status: number; body?: unknown }>((resolve) => {
        answer = resolve;
      });
      const respond = (r: { status: number; body?: unknown }) => ({
        status: r.status,
        json: () => Promise.resolve(r.body),
        text: () => Promise.resolve(JSON.stringify(r.body)),
      });
      const impl: AccountFetch = async (url) => {
        const route = url.slice(ORIGIN.length);
        if (route === path) return respond(await deferred);
        if (route === "/api/me") return respond({ status: 200, body: { user: { username: "alice" } } });
        if (route === "/api/hosts") return respond({ status: 200, body: [] });
        if (route === "/api/logout") return respond({ status: 204 });
        if (route === "/api/login") return respond({ status: 200, body: { user: { username: "bob" }, expiresAt: 1, token: "b-token" } });
        throw new Error(`unexpected ${route}`);
      };
      const { model } = makeModel({ fake: { impl, calls: [] }, bridge });
      return { model, answer, token: () => token };
    };

    const switchToBob = async (model: AccountModel): Promise<void> => {
      await model.logout();
      expect((await model.login({ username: "bob", password: "pw", serverOrigin: ORIGIN })).ok).toBe(true);
      expect(model.state).toMatchObject({ status: "signed-in", user: "bob" });
    };

    it("a delete's success doesn't sign the new account out or clear its token (#451)", async () => {
      const { model, answer, token } = setup("/api/me/delete");
      await vi.waitFor(() => expect(model.state).toMatchObject({ status: "signed-in", user: "alice" }));
      const deleting = model.deleteAccount({ password: "pw" });
      await switchToBob(model);
      answer({ status: 204 });
      expect((await deleting).ok).toBe(true);
      expect(model.state).toMatchObject({ status: "signed-in", user: "bob" });
      expect(token()).toBe("b-token");
    });

    it("a kick's 401 doesn't sign the new account out (#452)", async () => {
      const { model, answer, token } = setup("/api/devices/3/kick");
      await vi.waitFor(() => expect(model.state).toMatchObject({ status: "signed-in", user: "alice" }));
      const kicking = model.kickDevice({ id: 3, password: "pw" });
      await switchToBob(model);
      answer({ status: 401, body: { error: "unauthenticated" } });
      expect((await kicking).ok).toBe(false);
      expect(model.state).toMatchObject({ status: "signed-in", user: "bob" });
      expect(token()).toBe("b-token");
    });

    it("a password change's 401 doesn't sign the new account out (#450)", async () => {
      const { model, answer, token } = setup("/api/password");
      await vi.waitFor(() => expect(model.state).toMatchObject({ status: "signed-in", user: "alice" }));
      const changing = model.changePassword({ currentPassword: "pw", newPassword: "a long new password" });
      await switchToBob(model);
      answer({ status: 401, body: { error: "unauthenticated" } });
      expect((await changing).ok).toBe(false);
      expect(model.state).toMatchObject({ status: "signed-in", user: "bob" });
      expect(token()).toBe("b-token");
    });
  });

  it("revokeAll signs out everywhere including this session", async () => {
    const { model } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [] },
      { status: 204 },
    ) });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    const result = await model.revokeAll();
    expect(result.ok).toBe(true);
    expect(model.state.status).toBe("signed-out");
    await expect(model.refreshHosts()).resolves.toEqual({ ok: false, error: { code: "unauthenticated" } });
  });
});

describe("automatic registration", () => {
  const keyA = toBase64Url(generateKeyPair().publicKey);
  const row = (key = keyA, hostId = "h1") => accountHost(key, hostId);
  const offer = (key = keyA) => ({
    url: "wss://relay.example.com/c/h1",
    hostKey: key,
    secret: toBase64Url(generateKeyPair().privateKey),
    expiresAt: Date.now() + 60_000,
  });
  const response = (status: number, body: unknown) => ({
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
  /** A cookie-mode account server whose host list reflects the live store. */
  const routeFetch = (hostRows: () => unknown[], pairingOffer = offer()) => {
    const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
    let meCalls = 0;
    const impl: AccountFetch = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/me")) {
        meCalls += 1;
        return Promise.resolve(meCalls === 1 ? response(401, undefined) : response(200, USER));
      }
      if (url.endsWith("/api/hosts") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(response(200, hostRows()));
      }
      if (url.endsWith("/api/hosts/h1/pairing")) return Promise.resolve(response(200, pairingOffer));
      if (url.endsWith("/api/logout")) return Promise.resolve(response(204, undefined));
      return Promise.resolve(response(404, { error: "not_found" }));
    };
    return { impl, calls };
  };
  const pairingCalls = (calls: { url: string }[]): number =>
    calls.filter((call) => call.url.endsWith("/pairing")).length;

  it("retries the host list on returning to the foreground after an initial failure", async () => {
    const listeners = new Set<() => void>();
    const visibility: AccountVisibility = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const base = routeFetch(() => [row()]);
    let firstHosts = true;
    const impl: AccountFetch = (url, init) => {
      if (firstHosts && url.endsWith("/api/hosts") && (init?.method ?? "GET") === "GET") {
        firstHosts = false;
        return Promise.resolve(response(500, { error: "network" }));
      }
      return base.impl(url, init);
    };
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    const setup = makeModel({
      fake: { impl, calls: base.calls },
      store,
      declined,
      visibility,
      autoRegister: true,
    });
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status).toBe("signed-in");
      if (state.status === "signed-in") expect(state.hostsError).toBeDefined();
    });
    expect(listeners.size).toBe(1);

    for (const listener of listeners) listener();
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("paired");
    });
    expect(setup.paired).toHaveLength(1);
  });

  it("registers an eligible unpaired host through the account", async () => {
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, declined, autoRegister: true });
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status).toBe("signed-in");
      if (state.status === "signed-in") expect(state.hosts[0]?.status).toBe("paired");
    });
    expect(setup.paired).toHaveLength(1);
    expect(store.stored[0]!.account).toEqual({ serverOrigin: ORIGIN, hostId: "h1", vouched: true });
    expect(pairingCalls(fake.calls)).toBe(1);
  });

  it("pairs a host that joined offline on a refresh after it comes online (#492)", async () => {
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    let online = false;
    const base = routeFetch(() => [{ ...row(), online, pairing: online ? "available" : "offline" }]);
    const impl: AccountFetch = (url, init) => {
      if (!online && url.endsWith("/api/hosts/h1/pairing")) {
        base.calls.push({ url, init });
        return Promise.resolve(response(409, { error: "host_offline" }));
      }
      return base.impl(url, init);
    };
    const setup = makeModel({ fake: { impl, calls: base.calls }, store, declined, autoRegister: true });
    await vi.waitFor(() => expect(pairingCalls(base.calls)).toBe(1));
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("unpaired");
    });
    expect(declined.list()).toEqual([]);

    online = true;
    await setup.model.refreshHosts();
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("paired");
    });
    expect(setup.paired).toHaveLength(1);
  });

  it("adds a host that refuses account vouching to the declined set", async () => {
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    const connect = vi.fn(() =>
      Promise.reject(Object.assign(new Error("pairing refused"), { code: 4401 })),
    );
    const fake = routeFetch(() => [row()]);
    makeModel({ fake, store, declined, connect, autoRegister: true });
    await vi.waitFor(() =>
      expect(declined.list()).toContainEqual({ serverOrigin: ORIGIN, hostId: "h1" }),
    );
    expect(store.stored).toEqual([]);
  });

  it("does not auto-register a declined identity", async () => {
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    declined.add({ serverOrigin: ORIGIN, hostId: "h1" });
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, declined, autoRegister: true });
    await vi.waitFor(() => expect(setup.model.state.status).toBe("signed-in"));
    await Promise.resolve();
    expect(pairingCalls(fake.calls)).toBe(0);
    expect(store.stored).toEqual([]);
  });

  it("does not register when the local pairing list could not be read", async () => {
    const store = hosts([], { failList: true });
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, autoRegister: true });
    await vi.waitFor(() => expect(setup.model.state.status).toBe("signed-in"));
    await Promise.resolve();
    expect(pairingCalls(fake.calls)).toBe(0);
  });

  it("keeps one flight per host across overlapping refreshes", async () => {
    const store = hosts();
    let releaseConnect!: () => void;
    const connect = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseConnect = resolve;
      }),
    );
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    const locks = { request } as unknown as AccountLocks;
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, connect, locks, autoRegister: true });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await setup.model.refreshHosts();
    await setup.model.refreshHosts();
    expect(request).toHaveBeenCalledTimes(1);
    expect(pairingCalls(fake.calls)).toBe(1);

    releaseConnect();
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("paired");
    });
    expect(setup.paired).toHaveLength(1);
  });

  it("rechecks the local list under the Web Lock before registering", async () => {
    const store = hosts();
    const declined = createDeclinedStore(localStorage);
    const linked: StoredHost = {
      ...storedHost({ hostKey: keyA }),
      account: { serverOrigin: ORIGIN, hostId: "h1" },
    };
    const names: string[] = [];
    const locks = {
      request: async <T,>(name: string, callback: () => Promise<T>): Promise<T> => {
        names.push(name);
        // Another tab won the race while this one waited for the lock.
        store.stored.push(linked);
        return callback();
      },
    };
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, declined, locks, autoRegister: true });
    await vi.waitFor(() => expect(names).toHaveLength(1));
    await Promise.resolve();
    expect(names[0]).toBe(`pinomad.autoRegister:${ORIGIN}:h1`);
    expect(pairingCalls(fake.calls)).toBe(0);
    // The winning tab's record still has to reach this page's runtime table
    // and its account matches; otherwise the panel keeps offering Pair.
    expect(setup.paired).toEqual([linked]);
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("paired");
    });
  });

  it("keeps a failed save in a per-host recovery slot and never generates a second key", async () => {
    const store = hosts();
    store.setFailSaves(true);
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, autoRegister: true });
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.unsavedHosts.length : 0).toBe(1);
    });
    expect(pairingCalls(fake.calls)).toBe(1);

    store.setFailSaves(false);
    expect(await setup.model.retryUnsavedHost("h1")).toEqual({ ok: true, value: undefined });
    expect(store.stored.map((entry) => entry.hostKey)).toEqual([keyA]);
    expect(pairingCalls(fake.calls)).toBe(1);
    expect((setup.model.state as Extract<typeof setup.model.state, { status: "signed-in" }>).unsavedHosts).toEqual([]);
  });

  it("does not resurrect a forgotten host from a failed-save slot", async () => {
    const store = hosts();
    store.setFailSaves(true);
    const declined = createDeclinedStore(localStorage);
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, declined, autoRegister: true });
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.unsavedHosts.length : 0).toBe(1);
    });

    declined.add({ serverOrigin: ORIGIN, hostId: "h1" });
    store.setFailSaves(false);
    await setup.model.refreshHosts();
    await vi.waitFor(() => {
      const state = setup.model.state;
      expect(state.status === "signed-in" ? state.unsavedHosts : undefined).toEqual([]);
    });
    expect(store.stored).toEqual([]);
  });

  it("drops an in-flight registration after sign-out", async () => {
    const store = hosts();
    let releaseConnect!: () => void;
    const connect = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseConnect = resolve;
      }),
    );
    const fake = routeFetch(() => [row()]);
    const setup = makeModel({ fake, store, connect, autoRegister: true });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(await setup.model.logout()).toEqual({ ok: true, value: undefined });
    releaseConnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.stored).toEqual([]);
    expect(setup.model.state.status).toBe("signed-out");
  });

  // A confirmed host joins only after its next poll, the join and a service
  // restart, and nothing else refreshes a page that already has a host: the
  // model keeps asking until the host is paired here, whatever the UI does.
  describe("watching for a host confirmed here (#496)", () => {
    const hostListCalls = (calls: { url: string; init: AccountFetchInit | undefined }[]): number =>
      calls.filter((call) => call.url.endsWith("/api/hosts") && (call.init?.method ?? "GET") === "GET").length;
    const pairedHere = (model: AccountModel): boolean =>
      model.state.status === "signed-in" && model.state.hosts.some((match) => match.host.hostId === "h1" && match.status === "paired");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Signed in with no hosts yet; `rows` and `online` script the host's arrival. */
    async function signedInWatching() {
      const script = { rows: [] as unknown[], online: false };
      const base = routeFetch(() => script.rows);
      const impl: AccountFetch = (url, init) => {
        if (!script.online && url.endsWith("/api/hosts/h1/pairing")) {
          base.calls.push({ url, init });
          return Promise.resolve(response(409, { error: "host_offline" }));
        }
        return base.impl(url, init);
      };
      const setup = makeModel({ fake: { impl, calls: base.calls }, store: hosts(), autoRegister: true });
      await vi.waitFor(() => expect(setup.model.state.status).toBe("signed-in"));
      return { ...setup, script, calls: base.calls, start: hostListCalls(base.calls) };
    }

    it("refreshes every 5 s until the host joins, comes online and pairs, then stops", async () => {
      const { model, script, calls, start } = await signedInWatching();
      model.watchForHost("h1");
      await vi.advanceTimersByTimeAsync(0);
      expect(hostListCalls(calls)).toBe(start + 1);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(hostListCalls(calls)).toBe(start + 6);

      // Joins at 30 s, offline until its service restarts.
      script.rows = [{ ...row(), online: false, pairing: "offline" }];
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        const state = model.state;
        expect(state.status === "signed-in" ? state.hosts[0]?.status : undefined).toBe("unpaired");
      });

      script.rows = [row()];
      script.online = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(pairedHere(model)).toBe(true));

      const settledCalls = hostListCalls(calls);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(hostListCalls(calls)).toBe(settledCalls);
    });

    it("gives up after 2 minutes on a host that never shows up", async () => {
      const { model, calls, start } = await signedInWatching();
      model.watchForHost("h1");
      await vi.advanceTimersByTimeAsync(120_000);
      // One right away, then one every 5 s for 2 minutes.
      expect(hostListCalls(calls)).toBe(start + 25);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostListCalls(calls)).toBe(start + 25);
    });

    it("stops on sign-out", async () => {
      const { model, calls } = await signedInWatching();
      model.watchForHost("h1");
      await vi.advanceTimersByTimeAsync(10_000);
      await model.logout();
      const signedOutCalls = hostListCalls(calls);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostListCalls(calls)).toBe(signedOutCalls);
    });

    it("restarts the window when the same host is confirmed again, without a second timer", async () => {
      const { model, calls, start } = await signedInWatching();
      model.watchForHost("h1");
      await vi.advanceTimersByTimeAsync(60_000);
      model.watchForHost("h1");
      await vi.advanceTimersByTimeAsync(0);
      const restarted = hostListCalls(calls);
      expect(restarted).toBe(start + 13 + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(hostListCalls(calls)).toBe(restarted + 2);
    });
  });
});

describe("signing out of a shared computer (#494)", () => {
  type Answer = Awaited<ReturnType<AccountFetch>>;
  const answer = (status: number, body?: unknown): Answer => ({
    status,
    json: () => (body === undefined ? Promise.reject(new Error("empty")) : Promise.resolve(body)),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  });
  /** Paired through the account's own offer. */
  const vouched = (serverOrigin: string, hostId = "h1") =>
    storedHost({ account: { serverOrigin, hostId, vouched: true } });
  /** A QR pairing that later adopted the account link (same Noise key). */
  const adopted = (serverOrigin: string, hostId = "h2") => storedHost({ account: { serverOrigin, hostId } });
  const pairingOffer = {
    url: "wss://relay.example.com/c/h1",
    hostKey: toBase64Url(generateKeyPair().publicKey),
    secret: toBase64Url(generateKeyPair().privateKey),
    expiresAt: Date.now() + 60_000,
  };

  /**
   * Signed in (cookie mode) with `stored` paired. `logout` answers
   * /api/logout; `removed` records every host the model drops, and
   * `removeHost` can stand in for the app's own removal.
   */
  const signedInWith = async (
    stored: StoredHost[],
    options?: {
      logout?: () => Promise<Answer>;
      connect?: () => Promise<void>;
      removeHost?: (store: ReturnType<typeof hosts>, hostKey: string) => Promise<void>;
    },
  ) => {
    const logout = options?.logout ?? (() => Promise.resolve(answer(204)));
    const store = hosts(stored);
    const removed: string[] = [];
    const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
    let probed = 0;
    const impl: AccountFetch = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/me")) return Promise.resolve((probed += 1) <= 2 ? answer(401) : answer(200, USER));
      if (url.endsWith("/api/login")) return Promise.resolve(answer(200, USER));
      if (url.endsWith("/api/hosts")) return Promise.resolve(answer(200, []));
      if (url.endsWith("/api/hosts/h1/pairing")) return Promise.resolve(answer(200, pairingOffer));
      if (url.endsWith("/api/logout")) return logout();
      return Promise.resolve(answer(404, { error: "not_found" }));
    };
    const setup = makeModel({
      fake: { impl, calls },
      store,
      ...(options?.connect === undefined ? {} : { connect: options.connect }),
      removeHost: (hostKey) => {
        removed.push(hostKey);
        return options?.removeHost?.(store, hostKey) ?? store.remove(hostKey);
      },
    });
    await settled(setup.model);
    expect((await setup.model.login({ username: "admin", password: "pw" })).ok).toBe(true);
    const logoutBodies = () => calls.filter((call) => call.url.endsWith("/api/logout")).map((call) => call.init?.body);
    return { ...setup, removed, logoutBodies };
  };

  it("forgets the hosts this server vouched for and asks it to revoke the device; QR pairings stay", async () => {
    const mine = vouched(`${ORIGIN}/`);
    const qr = storedHost();
    // The link alone doesn't make a key the account's: refresh adopts it
    // onto any QR pairing that shares the Noise key.
    const qrLinked = adopted(ORIGIN);
    const elsewhere = vouched("https://other.example.com");
    const setup = await signedInWith([mine, qr, qrLinked, elsewhere]);

    expect(await setup.model.logout({ revoke: true })).toEqual({ ok: true, value: undefined });
    expect(setup.removed).toEqual([mine.hostKey]);
    expect(setup.store.stored).toEqual([qr, qrLinked, elsewhere]);
    expect(setup.logoutBodies()).toEqual(['{"revoke":true}']);
    expect(setup.model.state.status).toBe("signed-out");
  });

  it("keeps every pairing on a plain sign-out", async () => {
    const mine = vouched(ORIGIN);
    const setup = await signedInWith([mine]);
    expect(await setup.model.logout()).toEqual({ ok: true, value: undefined });
    expect(setup.removed).toEqual([]);
    expect(setup.store.stored).toEqual([mine]);
    expect(setup.logoutBodies()).toEqual([undefined]);
  });

  it("forgets the hosts even when the server can't be reached, and reports the failure", async () => {
    const setup = await signedInWith([vouched(ORIGIN)], { logout: () => Promise.reject(new Error("offline")) });
    expect(await setup.model.logout({ revoke: true })).toEqual({ ok: false, error: { code: "network" } });
    expect(setup.store.stored).toEqual([]);
    expect(setup.model.state.status).toBe("signed-out");
  });

  it("reports hosts it couldn't forget, even when the server confirmed", async () => {
    const setup = await signedInWith([vouched(ORIGIN)]);
    setup.store.setFailList(true);
    expect(await setup.model.logout({ revoke: true })).toEqual({ ok: false, error: { code: "hosts_not_forgotten" } });
    expect(setup.logoutBodies()).toEqual(['{"revoke":true}']);
    expect(setup.model.state.status).toBe("signed-out");
  });

  it("reads the store back, since the app's removal swallows its own failures", async () => {
    // App.dropHost logs a failed store.remove and resolves anyway.
    const setup = await signedInWith([vouched(ORIGIN)], { removeHost: () => Promise.resolve() });
    expect(await setup.model.logout({ revoke: true })).toEqual({ ok: false, error: { code: "hosts_not_forgotten" } });
    expect(setup.store.stored).toHaveLength(1);
  });

  it("holds the sign-in form until a cookie sign-out settles, so its answer can't clear a new session's cookie", async () => {
    let release!: (value: Answer) => void;
    const setup = await signedInWith([], { logout: () => new Promise((resolve) => (release = resolve)) });
    const pending = setup.model.logout({ revoke: true });
    await vi.waitFor(() => expect(setup.logoutBodies()).toHaveLength(1));
    expect(setup.model.state.status).toBe("checking");

    const logins = () => setup.calls.filter((call) => call.url.endsWith("/api/login")).length;
    const before = logins();
    const login = setup.model.login({ username: "admin", password: "pw" });
    await Promise.resolve();
    expect(logins()).toBe(before);

    release(answer(204));
    expect((await pending).ok).toBe(true);
    expect((await login).ok).toBe(true);
    expect(logins()).toBe(before + 1);
    expect(setup.model.state.status).toBe("signed-in");
  });

  it("discards a manual pairing that finishes after the sign-out", async () => {
    let finishHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => (finishHandshake = resolve));
    let handshakeStarted!: () => void;
    const started = new Promise<void>((resolve) => (handshakeStarted = resolve));
    const setup = await signedInWith([], {
      connect: () => {
        handshakeStarted();
        return handshake;
      },
    });
    const pairing = setup.model.pairHost("h1");
    await started;
    expect(await setup.model.logout({ revoke: true })).toEqual({ ok: true, value: undefined });

    finishHandshake();
    expect(await pairing).toEqual({ ok: false, error: { code: "stale" } });
    expect(setup.store.stored).toEqual([]);
    expect(setup.paired).toEqual([]);
  });
});
