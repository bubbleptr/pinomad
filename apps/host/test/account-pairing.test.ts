// Server accounts step 4 end to end (ADR-0022 §4): a real accounts server, a
// real host joined to it, and real devices. The client asks the API for a
// vouched offer, builds `pair=<hostKey>.<secret>&url=…` from the response, and
// lands on the host through the server's device path — the host records the
// registration's source as "account".
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { openAccounts, type Accounts } from "@pinomad/server/src/accounts.ts";
import { startRelay, type Relay } from "@pinomad/server/src/relay.ts";
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

function api(
  relay: Relay,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode ?? 0, json: text === "" ? undefined : JSON.parse(text) });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

const login = async (relay: Relay): Promise<string> =>
  ((await api(relay, { method: "POST", path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } })).json as {
    token: string;
  }).token;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/** A second account with a live session, straight into the tables. */
function secondUser(accounts: Accounts): string {
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('second', 'x', 1)").run();
  const token = "second-user-session";
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 2, 1, ?)").run(
    sha256Hex(token),
    Date.now() + 60_000,
  );
  db.close();
  return token;
}

/** The full joined state: server-side hosts row plus a matching server.json. */
async function joinedHost(server: { accounts: Accounts; origin: string }): Promise<{
  host: OpenedHost;
  hostId: string;
  dataDir: string;
}> {
  const dir = await tempDir();
  defer(dir.remove);
  // Keys exist before the binding is written — join reports these exact keys.
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
  return { host, hostId, dataDir: dir.path };
}

function connectDevice(url: string, hostKey: string, device: KeyPair, pairing?: { secret: string; name: string }): Promise<RemoteDurable> {
  const client = connectRemoteDurable({
    transport: secureWebSocketTransport({
      url,
      hostKey: fromBase64Url(hostKey),
      device,
      ...(pairing === undefined ? {} : { pairing }),
    }),
    reconnectDelayMs: { min: 100, max: 200 },
  });
  return client.then((remote) => {
    defer(() => remote.close());
    return remote;
  });
}

interface PairingResult {
  url: string;
  hostKey: string;
  secret: string;
  expiresAt: number;
}

describe("server-vouched pairing end to end", () => {
  it("lists the host, hands out an offer, and the vouched device pairs through the server", async () => {
    const server = await startServer();
    const { host, hostId, dataDir } = await joinedHost(server);
    const tokenClient = await connectTo(defer, host);
    const session = await login(server.relay);

    const hosts = (await api(server.relay, { path: "/api/hosts", headers: bearer(session) })).json as {
      hostId: string;
      name: string;
      online: boolean;
      pairing: string;
      noisePublicKey: string;
    }[];
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ hostId, name: "test-host", online: true, pairing: "available" });
    expect(hosts[0]!.noisePublicKey).toBe(toBase64Url((await loadHostKey(dataDir)).publicKey));

    const ask = await api(server.relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(session) });
    expect(ask.status).toBe(200);
    const offer = ask.json as PairingResult;
    expect(offer.url).toBe(`${server.origin.replace("http", "ws")}/c/${hostId}`);
    expect(offer.hostKey).toBe(hosts[0]!.noisePublicKey);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());

    // The client side of the response: pair=<hostKey>.<secret>, url=<device path>.
    const device = generateKeyPair();
    const remote = await connectDevice(offer.url, offer.hostKey, device, { secret: offer.secret, name: "vouched phone" });
    expect(remote.view.current().connection).toBe("connected");

    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    const entry = tokenClient.view.current().devices[0]!;
    expect(entry.name).toBe("vouched phone");
    expect(entry.source).toBe("account");
    await waitForView(tokenClient.view, (view) =>
      view.notices.some((notice) => notice.message === 'New device "vouched phone" joined through your account'),
    );
  });

  it("answers disabled once the host switch is off", async () => {
    const server = await startServer();
    const { host, hostId } = await joinedHost(server);
    const tokenClient = await connectTo(defer, host);
    const session = await login(server.relay);

    await tokenClient.controller.updateSettings({ acceptAccountDevices: false });
    await waitForView(tokenClient.view, (view) => view.settings?.acceptAccountDevices === false);

    const ask = await api(server.relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(session) });
    expect(ask.status).toBe(409);
    expect(ask.json).toEqual({ error: "disabled" });
  });

  it("still mints an offer for a revoked device but the handshake refuses — the host decides", async () => {
    const server = await startServer();
    const { host, hostId } = await joinedHost(server);
    const tokenClient = await connectTo(defer, host);
    const session = await login(server.relay);
    const pairingPath = `/api/hosts/${hostId}/pairing`;

    const first = (await api(server.relay, { method: "POST", path: pairingPath, headers: bearer(session) })).json as PairingResult;
    const device = generateKeyPair();
    await connectDevice(first.url, first.hostKey, device, { secret: first.secret, name: "phone" });
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);

    await tokenClient.controller.revokeDevice(toBase64Url(device.publicKey));
    await waitForView(tokenClient.view, (view) => view.devices.length === 0);

    // The server still vouches — early refusal is advisory only — but the
    // revoked key's account offer dies inside admitDevice's commit.
    const second = await api(server.relay, { method: "POST", path: pairingPath, headers: bearer(session) });
    expect(second.status).toBe(200);
    const offer = second.json as PairingResult;
    await expect(connectDevice(offer.url, offer.hostKey, device, { secret: offer.secret, name: "phone" })).rejects.toThrow();
  });

  it("refuses asks on a control that outlived a re-join to another server", async () => {
    const server = await startServer();
    const { hostId, dataDir } = await joinedHost(server);
    const session = await login(server.relay);

    // `pinomad join <B>` rewrites server.json to B and waits for idle before
    // restarting: this control still points at A, and must not mint invites
    // under B's fresh binding (admission would honor them).
    await writeServerConfig(dataDir, { origin: "https://elsewhere.example.com" });
    const ask = await api(server.relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(session) });
    expect(ask.status).toBe(409);
    expect(ask.json).toEqual({ error: "rebinding" });
  });

  it("hides and refuses the host for another account", async () => {
    const server = await startServer();
    const { hostId } = await joinedHost(server);
    const other = secondUser(server.accounts);

    expect((await api(server.relay, { path: "/api/hosts", headers: bearer(other) })).json).toEqual([]);
    const ask = await api(server.relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(other) });
    expect(ask.status).toBe(404);
  });
});
