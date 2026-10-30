// jsdom: SecureClient's manual retry must read the latest stored candidates,
// latch the paired milestone, and keep the unsaved warning visible on failure.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateStoredHostConnection, updateStoredHostEndpoints, type StoredHost } from "@pinomad/client/stored-host.ts";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { SecureClient } from "./App.tsx";
import type { ResolvedAddress } from "./address.ts";
import { HostsContext, type HostStore, type HostsState } from "./entities/host/host-store.ts";
import { fakeRemote } from "./test/story-fixtures.tsx";

const transportSpy = vi.hoisted(() => vi.fn());

vi.mock("@pinomad/protocol/secure-channel.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pinomad/protocol/secure-channel.ts")>();
  return { ...actual, secureWebSocketTransport: transportSpy };
});

const endpoints = (...urls: [string, "relay" | "direct"][]): EndpointSet => ({
  schemaVersion: 1,
  endpoints: urls.map(([url, role]) => ({ transport: "webSocket", role, url })),
});

const A = endpoints(["wss://a.example/secure", "relay"]);
const B = endpoints(
  ["wss://b-relay.example/secure", "relay"],
  ["wss://b-direct.example/secure", "direct"],
);

const hostKey = toBase64Url(generateKeyPair().publicKey);
const privateKey = toBase64Url(generateKeyPair().privateKey);

const store: HostStore = {
  list: async () => [],
  save: async () => {},
  remove: async () => {},
  setName: async () => {},
  updateEndpoints: async () => {},
  updateConnection: async () => {},
};

interface Observed {
  hosts: StoredHost[];
  pairedCalls: number;
}

function Harness({
  address,
  connect,
  failSave,
  observed,
  initialHosts,
}: {
  address: Extract<ResolvedAddress, { kind: "pair" | "device" }>;
  connect: (options: RemoteDurableOptions) => Promise<RemoteDurable>;
  failSave?: boolean;
  observed: Observed;
  initialHosts?: readonly StoredHost[];
}) {
  const [hosts, setHosts] = useState<StoredHost[]>([...(initialHosts ?? [])]);
  const state: HostsState = {
    store,
    hosts,
    focus: null,
    focusHost: () => {},
    focusConversation: () => {},
    rememberConversation: () => {},
    focusDraft: () => {},
    forget: async (hostKey) => {
      const next = hosts.filter((each) => each.hostKey !== hostKey);
      observed.hosts = next;
      setHosts(next);
    },
    dropHost: async (hostKey) => {
      const next = hosts.filter((each) => each.hostKey !== hostKey);
      observed.hosts = next;
      setHosts(next);
    },
    paired: async (host) => {
      observed.pairedCalls += 1;
      if (failSave === true) throw new Error("keychain locked");
      const next = [...hosts.filter((each) => each.hostKey !== host.hostKey), host];
      observed.hosts = next;
      setHosts(next);
    },
    setName: async (key, name) => {
      const next = hosts.map((each) => (each.hostKey === key ? { ...each, name } : each));
      observed.hosts = next;
      setHosts(next);
    },
    endpoints: async (key, endpointSet) => {
      const next = hosts.map((each) =>
        each.hostKey === key ? updateStoredHostEndpoints(each, endpointSet) : each,
      );
      observed.hosts = next;
      setHosts(next);
    },
    setConnection: async (key, change) => {
      const next = hosts.map((each) =>
        each.hostKey === key ? updateStoredHostConnection(each, change) : each,
      );
      observed.hosts = next;
      setHosts(next);
    },
  };
  return (
    <HostsContext.Provider value={state}>
      <SecureClient address={address} connect={connect} />
    </HostsContext.Provider>
  );
}

/** A never-ready durable is enough for the second attempt; we only inspect options. */
const hanging = (): Promise<RemoteDurable> => new Promise<RemoteDurable>(() => {});

beforeEach(() => {
  transportSpy.mockReset();
  transportSpy.mockImplementation((options: { url: string }) => ({
    label: options.url,
    open: () => ({ send() {}, close() {} }),
  }));
});

describe("SecureClient retry identity and candidates", () => {
  it("uses the endpoint set learned before a failed ready on the next manual attempt", async () => {
    const observed: Observed = { hosts: [], pairedCalls: 0 };
    const calls: RemoteDurableOptions[] = [];
    const connect = vi.fn((options: RemoteDurableOptions) => {
      calls.push(options);
      if (calls.length === 1) {
        void options.onEndpointSet?.(B);
        return Promise.reject(new Error("first sync failed"));
      }
      return Promise.resolve({ ...fakeRemote(), close: () => {} });
    });
    const address: Extract<ResolvedAddress, { kind: "device" }> = {
      kind: "device",
      url: "wss://a.example/secure",
      hostKey,
      privateKey,
      endpointSet: A,
    };

    render(
      <Harness
        address={address}
        connect={connect}
        observed={observed}
        initialHosts={[{ url: address.url, hostKey, privateKey, endpointSet: A }]}
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(observed.hosts[0]?.endpointSet).toEqual(B));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1]!;
    expect("candidates" in second ? second.candidates.map((candidate) => candidate.url) : []).toEqual([
      "wss://b-relay.example/secure",
      "wss://b-direct.example/secure",
    ]);
    // The second attempt actually becomes ready, not just "options changed".
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Connecting" })).toBeNull());
    expect(screen.queryByText("Could not connect to the host")).toBeNull();
  });

  it("does not restart a healthy connection when a background endpoint update lands", async () => {
    const observed: Observed = { hosts: [], pairedCalls: 0 };
    const calls: RemoteDurableOptions[] = [];
    const connect = vi.fn((options: RemoteDurableOptions) => {
      calls.push(options);
      return Promise.resolve({ ...fakeRemote(), close: () => {} });
    });
    const address: Extract<ResolvedAddress, { kind: "device" }> = {
      kind: "device",
      url: "wss://a.example/secure",
      hostKey,
      privateKey,
      endpointSet: A,
    };
    const initialHosts: StoredHost[] = [{ url: address.url, hostKey, privateKey, endpointSet: A }];

    render(<Harness address={address} connect={connect} observed={observed} initialHosts={initialHosts} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Connecting" })).toBeNull());
    const first = calls[0]!;
    if ("onEndpointSet" in first) first.onEndpointSet?.(B);
    await waitFor(() => expect(observed.hosts[0]?.endpointSet).toEqual(B));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Connecting" })).toBeNull();
  });

  it("stops replaying the secret and keeps the same device after paired", async () => {
    const observed: Observed = { hosts: [], pairedCalls: 0 };
    const calls: RemoteDurableOptions[] = [];
    const connect = vi.fn((options: RemoteDurableOptions) => {
      calls.push(options);
      if (calls.length === 1) {
        options.onPaired?.();
        return Promise.reject(new Error("sync failed after message 2"));
      }
      return hanging();
    });
    const address: Extract<ResolvedAddress, { kind: "pair" }> = {
      kind: "pair",
      url: "wss://a.example/secure",
      hostKey,
      secret: "one-time-secret",
      endpointSet: A,
    };

    render(<Harness address={address} connect={connect} observed={observed} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect("pairing" in calls[0]! ? calls[0]!.pairing : undefined).toEqual({
      secret: "one-time-secret",
      name: expect.any(String),
    });
    await waitFor(() => expect(observed.pairedCalls).toBe(1));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toHaveLength(2));

    const first = calls[0]!;
    const second = calls[1]!;
    expect("pairing" in second ? second.pairing : undefined).toBeUndefined();
    // Opening the transport with each attempt's own pairing context proves the
    // device key survives and the secret is gone from the second attempt.
    const candidate = { url: "wss://a.example/secure", role: "relay" as const };
    if ("openTransport" in first) first.openTransport(candidate, first.pairing);
    if ("openTransport" in second) second.openTransport(candidate, second.pairing);
    const [firstOptions, secondOptions] = transportSpy.mock.calls.map(
      (call) => call[0] as { device: { privateKey: Uint8Array }; pairing?: unknown },
    );
    expect(firstOptions!.device.privateKey).toEqual(secondOptions!.device.privateKey);
    expect(firstOptions!.pairing).toEqual({ secret: "one-time-secret", name: expect.any(String) });
    expect(secondOptions!.pairing).toBeUndefined();
    expect(observed.pairedCalls).toBe(1);
  });

  it("shows the unsaved-pairing warning on the first failure page", async () => {
    const observed: Observed = { hosts: [], pairedCalls: 0 };
    const calls: RemoteDurableOptions[] = [];
    const connect = vi.fn((options: RemoteDurableOptions) => {
      calls.push(options);
      if (calls.length === 1) {
        options.onPaired?.();
        return Promise.reject(new Error("sync failed after message 2"));
      }
      return hanging();
    });
    const address: Extract<ResolvedAddress, { kind: "pair" }> = {
      kind: "pair",
      url: "wss://a.example/secure",
      hostKey,
      secret: "one-time-secret",
      endpointSet: A,
    };

    render(<Harness address={address} connect={connect} failSave observed={observed} />);
    await waitFor(() => expect(observed.pairedCalls).toBe(1));
    expect(await screen.findByText("This pairing wasn't saved")).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    // Even when the save failed, the next manual attempt is still paired:
    // it uses the device identity and must not replay the invite secret.
    await userEvent.click(retries[retries.length - 1]!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect("pairing" in calls[1]! ? calls[1]!.pairing : undefined).toBeUndefined();
    const candidate = { url: "wss://a.example/secure", role: "relay" as const };
    if ("openTransport" in calls[0]!) calls[0]!.openTransport(candidate, calls[0]!.pairing);
    if ("openTransport" in calls[1]!) calls[1]!.openTransport(candidate, calls[1]!.pairing);
    const [firstOptions, secondOptions] = transportSpy.mock.calls.map(
      (call) => call[0] as { device: { privateKey: Uint8Array } },
    );
    expect(firstOptions!.device.privateKey).toEqual(secondOptions!.device.privateKey);
  });
});
