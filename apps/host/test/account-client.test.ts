// Server accounts step 5 — the client-side logic layer against a real
// accounts server (startRelay + openAccounts) and a real joined host: login
// in both credential styles, list the account's hosts, pair through the
// account, then reconnect on the stored record without asking for another
// invite. Also pinned: a host that 4401s a stored device never gets a fresh
// invite minted behind the user's back.
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import {
  connectRemoteDurable,
  UnauthorizedError,
  type RemoteDurable,
} from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { normalizeHostName } from "@pinomad/protocol/settings.ts";
import { openAccounts, type Accounts } from "@pinomad/server/src/accounts.ts";
import { startRelay, type Relay } from "@pinomad/server/src/relay.ts";
import {
  createAccountClient,
  isUnauthenticated,
  matchAccountHosts,
  pairViaAccount,
  probeAccounts,
  type AccountFetch,
  type AccountResult,
} from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { loadHostKey, loadRelayKey } from "../src/devices.ts";
import { writeServerConfig } from "../src/server-config.ts";
import type { RelayLinkState } from "../src/relay-link.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, freePort, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

const GOOD_PASSWORD = "correct horse battery";
const QUICK_RECONNECT = { min: 50, max: 200 };

async function startServer(): Promise<{ relay: Relay; accounts: Accounts; origin: string }> {
  const dir = await tempDir();
  defer(dir.remove);
  const accounts = await openAccounts({ dataDir: dir.path, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const relay = await startRelay({ port, publicOrigin: origin, accounts });
  defer(() => relay.close());
  return { relay, accounts, origin };
}

/** The full joined state: server-side hosts row plus a matching server.json. */
async function joinedHost(server: { accounts: Accounts; origin: string }): Promise<{
  host: OpenedHost;
  hostId: string;
}> {
  const dir = await tempDir();
  defer(dir.remove);
  const relayKey = await loadRelayKey(dir.path);
  const hostKey = await loadHostKey(dir.path);
  const hostId = relayHostId(relayKey.publicKey);
  const { token } = server.accounts.createJoinToken(1);
  const joined = server.accounts.joinHost({
    token,
    hostId,
    noisePublicKey: toBase64Url(hostKey.publicKey),
    name: "test-host",
  });
  if (joined.status !== "joined") throw new Error("join failed in setup");
  await writeServerConfig(dir.path, { origin: server.origin });
  const host = await startFauxHost(defer, {
    dataDir: dir.path,
    relay: { origin: server.origin, reconnectDelayMs: QUICK_RECONNECT },
  });
  const deadline = Date.now() + 10_000;
  let state: RelayLinkState;
  for (;;) {
    state = host.relay!.state();
    if (state.status === "registered") break;
    if (Date.now() > deadline) throw new Error(`host never registered (state: ${state.status})`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return { host, hostId };
}

const bearerClient = (origin: string, token?: string) =>
  createAccountClient({ origin, credentials: { mode: "bearer", ...(token === undefined ? {} : { token }) }, fetch });

const unwrap = <T>(result: AccountResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

function connectDevice(url: string, hostKey: string, privateKey: string): Promise<RemoteDurable> {
  const device: KeyPair = keyPairFromPrivate(fromBase64Url(privateKey));
  return connectRemoteDurable({
    transport: secureWebSocketTransport({ url, hostKey: fromBase64Url(hostKey), device }),
    reconnectDelayMs: { min: 100, max: 200 },
  }).then((remote) => {
    defer(() => remote.close());
    return remote;
  });
}

/**
 * A browser-jar stand-in for cookie mode: replays the session cookie and sets
 * the same-origin Origin header a real browser adds to mutating requests.
 * Returns the fetch plus the jar so tests can inspect what was set.
 */
function cookieFetch(origin: string): { impl: AccountFetch; jar: { session?: string } } {
  const jar: { session?: string } = {};
  const impl: AccountFetch = async (url, init) => {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        origin,
        ...(jar.session === undefined ? {} : { cookie: jar.session }),
      },
    });
    const set = response.headers.getSetCookie().find((c) => c.startsWith("__Host-pinomad-session="));
    if (set !== undefined) jar.session = set.split(";")[0];
    return response;
  };
  return { impl, jar };
}

describe("account client against a real server", () => {
  it("bearer: login → list → pair → stored record reconnects without a new invite", async () => {
    const server = await startServer();
    const { host, hostId } = await joinedHost(server);
    const observer = await connectTo(defer, host);

    // Probe and login.
    expect(await probeAccounts(server.origin, fetch)).toBe("enabled");
    const anonymous = bearerClient(server.origin);
    const login = await anonymous.login("admin", GOOD_PASSWORD);
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const token = login.value.token;
    expect(token).toBeDefined();

    const client = bearerClient(server.origin, token);
    expect(unwrap(await client.me())).toEqual({ user: { username: "admin" } });

    // The joined host is listed and pairable.
    const hosts = unwrap(await client.listHosts());
    expect(hosts).toHaveLength(1);
    // The join-time "test-host" was overwritten at register — the host
    // reports its effective name (issue #212), the machine name here.
    expect(hosts[0]).toMatchObject({ hostId, name: normalizeHostName(hostname()), online: true, pairing: "available" });

    // matchAccountHosts before pairing: unpaired.
    const store: StoredHost[] = [];
    expect(matchAccountHosts(server.origin, hosts, store, [], true)[0]).toMatchObject({ status: "unpaired", autoRegister: true });

    // Pair through the account: the offer becomes a StoredHost with the link.
    const paired = await pairViaAccount(client, hostId, "account-test device");
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const record = paired.value;
    expect(record.account).toEqual({ serverOrigin: server.origin, hostId });
    store.push(record);

    await waitForView(observer.view, (view) => view.devices.length === 1);
    expect(observer.view.current().devices[0]!.source).toBe("account");

    // The match flips to paired, and the stored record reconnects on its own
    // key — no invite needed.
    expect(matchAccountHosts(server.origin, hosts, store, [], true)[0]).toMatchObject({ status: "paired", linkable: false, autoRegister: false });
    const remote = await connectDevice(record.url, record.hostKey, record.privateKey);
    expect(remote.view.current().connection).toBe("connected");
  });

  it("cookie mode: the token never enters the response body, the jar carries the session", async () => {
    const server = await startServer();
    const { jar, impl } = cookieFetch(server.origin);
    const client = createAccountClient({ origin: server.origin, credentials: { mode: "cookie" }, fetch: impl });

    const login = await client.login("admin", GOOD_PASSWORD);
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.value.token).toBeUndefined();
    expect(jar.session).toBeDefined();

    // The replayed cookie authenticates follow-up requests.
    expect(unwrap(await client.me())).toEqual({ user: { username: "admin" } });

    // Logout kills the session server-side: the same cookie now fails closed.
    unwrap(await client.logout());
    const me = await client.me();
    expect(me.ok).toBe(false);
    if (!me.ok) expect(isUnauthenticated(me.error)).toBe(true);
  });

  it("a revoked stored device is refused — and no fresh invite is minted behind the scenes", async () => {
    const server = await startServer();
    const { host, hostId } = await joinedHost(server);
    const observer = await connectTo(defer, host);
    const login = await bearerClient(server.origin).login("admin", GOOD_PASSWORD);
    if (!login.ok) throw new Error("login failed");
    const client = bearerClient(server.origin, login.value.token);

    const paired = await pairViaAccount(client, hostId, "doomed device");
    if (!paired.ok) throw new Error("pairing failed");
    const record = paired.value;
    const deviceKey = toBase64Url(keyPairFromPrivate(fromBase64Url(record.privateKey)).publicKey);
    await waitForView(observer.view, (view) => view.devices.length === 1);

    // Revoke, then reconnect: 4401. The account layer's job ends at reporting
    // the rejection — re-pairing is an explicit user action (pairViaAccount),
    // so nothing may mint a new invite here.
    await observer.controller.revokeDevice(deviceKey);
    await waitForView(observer.view, (view) => view.devices.length === 0);
    await expect(connectDevice(record.url, record.hostKey, record.privateKey)).rejects.toBeInstanceOf(UnauthorizedError);

    // Wait long enough for any illicit repair to register a device, then
    // confirm none happened and the stored record is untouched.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(observer.view.current().devices).toHaveLength(0);
    const hosts = unwrap(await client.listHosts());
    expect(matchAccountHosts(server.origin, hosts, [record], [], true)[0]).toMatchObject({
      status: "paired",
      stored: record,
      autoRegister: false,
    });
  });
});
