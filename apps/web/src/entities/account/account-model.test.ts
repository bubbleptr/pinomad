// The account model against scripted fetches: mode detection, login in both
// credential styles, host-list matching against the stored hosts, and the
// "rejected host never auto-repairs" pin.
import { describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { AccountFetch, AccountFetchInit } from "@pinomad/client/account.ts";
import { createAccountModel, type AccountModel } from "./account-model.ts";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import type { StoredHost } from "../host/host-store.ts";

const ORIGIN = "https://relay.example.com";
const USER = { user: { username: "admin" }, expiresAt: 1 };

/** A fetch stand-in: records calls, answers from a script. */
const fakeFetch = (...script: { status: number; body?: unknown }[]) => {
  const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
  const impl: AccountFetch = (url, init) => {
    calls.push({ url, init });
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next === undefined) return Promise.reject(new Error("no scripted response"));
    return Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body) });
  };
  return { impl, calls };
};

const hosts = (initial: StoredHost[] = []) => {
  const stored: StoredHost[] = [...initial];
  const saved: StoredHost[] = [];
  let failSaves = false;
  return {
    stored,
    saved,
    setFailSaves: (value: boolean) => {
      failSaves = value;
    },
    list: () => Promise.resolve([...stored]),
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
    connect: () => Promise.resolve(),
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
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
    const { model } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [accountHost(entry.hostKey, "h-1")] },
    ), store });
    await vi.waitFor(() => expect(model.state.status).toBe("signed-in"));
    await vi.waitFor(() =>
      expect(store.stored[0]!.account).toEqual({ serverOrigin: ORIGIN, hostId: "h-1" }),
    );
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
    const offer = {
      url: "wss://relay.example.com/c/h1",
      hostKey: toBase64Url(generateKeyPair().publicKey),
      secret: toBase64Url(generateKeyPair().privateKey),
      expiresAt: Date.now() + 60_000,
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
    expect(result.value.account).toEqual({ serverOrigin: ORIGIN, hostId: "h1" });
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
    const pending = (model.state as Extract<typeof model.state, { status: "signed-in" }>).unsavedHost;
    expect(pending).toBeDefined();
    expect(store.stored).toHaveLength(0);

    store.setFailSaves(false);
    expect(await model.retryUnsavedHost()).toEqual({ ok: true, value: undefined });
    expect(store.stored).toEqual([pending]);
    expect((model.state as Extract<typeof model.state, { status: "signed-in" }>).unsavedHost).toBeUndefined();
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
    const { model } = makeModel({ fake: fakeFetch(
      { status: 401 },
      { status: 200, body: { user: { username: "admin" } } },
      { status: 200, body: [accountHost(newKey, "h1")] },
      { status: 200, body: offer },
      { status: 200, body: [accountHost(newKey, "h1")] },
    ), store });
    await vi.waitFor(() => {
      const state = model.state as Extract<typeof model.state, { status: "signed-in" }>;
      expect(state.hosts[0]?.status).toBe("key_changed");
    });

    const result = await model.pairHost("h1");
    expect(result.ok).toBe(true);
    // The old key's link is dead — only the fresh record remains.
    expect(store.stored.map((each) => each.hostKey)).toEqual([newKey]);
    expect(store.stored[0]!.account).toEqual({ serverOrigin: ORIGIN, hostId: "h1" });
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
        if (hostsCalls === 1) return Promise.resolve({ status: 200, json: () => Promise.resolve([]) });
        return gate.then(() => ({ status: 200, json: () => Promise.resolve([]) }));
      }
      // logout and anything else get an empty 204 — what matters is the call went out.
      if (url.endsWith("/api/logout")) return Promise.resolve({ status: 204, json: () => Promise.resolve(undefined) });
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
