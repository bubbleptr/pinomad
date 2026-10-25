import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointSet } from "../src/endpoints.ts";
import { PROTOCOL, UNAUTHORIZED_CLOSE_CODE, type ClientFrame, type ServerFrame } from "../src/frames.ts";
import {
  ConnectionFailedError,
  ProtocolMismatchError,
  UnauthorizedError,
  connectRemoteDurable,
  type CandidateFailure,
  type PairingContext,
  type RemoteDurable,
  type RemoteDurableOptions,
} from "../src/remote-durable.ts";
import type { RemoteCandidate } from "../src/remote-candidates.ts";
import type { FrameConnection, FrameHandlers } from "../src/transport.ts";

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  tasks: { tasks: {} },
  mcp: null,
  models: [],
  auth: { logins: [] },
  settings: {
    defaultModel: null,
    defaultThinkingLevel: null,
    steeringMode: "all",
    followUpMode: "all",
    custom: [],
  },
  agents: { roles: [], problems: [] },
};

const snapshotFor = (stream: string): unknown => {
  if (stream in SNAPSHOTS) return SNAPSHOTS[stream];
  if (stream.startsWith("conversation:")) return { conversation: { id: 1 }, entries: [] };
  return null;
};

const hello = (endpointSet?: EndpointSet): ServerFrame => ({
  type: "hello",
  protocol: PROTOCOL,
  session: { id: "fake", directory: "" },
  models: [],
  docs: [],
  toolPresentations: {},
  defaults: {},
  ...(endpointSet === undefined ? {} : { endpointSet }),
});

type Step =
  | "open"
  | "auth"
  | "hello"
  | "sync"
  | { hello: EndpointSet | undefined }
  | { close: number; reason?: string }
  | { garbage: string }
  | { after: number; step: Step };

interface Script {
  readonly steps: readonly Step[];
}

interface OpenRecord {
  readonly candidate: RemoteCandidate;
  readonly pairing: PairingContext | undefined;
  readonly handlers: FrameHandlers;
  readonly frames: ClientFrame[];
  closeCalls: number;
}

/**
 * A candidate network with one script per (url, attempt). Steps run as
 * microtasks so the client has installed its handlers; `after` makes a step
 * deterministically late. `sync` answers every later subscribe with a snapshot.
 */
function network(
  plan: readonly RemoteCandidate[],
  script: (candidate: RemoteCandidate, attempt: number) => Script,
) {
  const opens: OpenRecord[] = [];
  const attempts = new Map<string, number>();
  const transports = (candidate: RemoteCandidate, pairing: PairingContext | undefined) => ({
    label: candidate.url,
    open(handlers: FrameHandlers): FrameConnection {
      const attempt = attempts.get(candidate.url) ?? 0;
      attempts.set(candidate.url, attempt + 1);
      const record: OpenRecord = { candidate, pairing, handlers, frames: [], closeCalls: 0 };
      opens.push(record);
      let sync = false;
      let closed = false;
      const connection: FrameConnection = {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          record.frames.push(frame);
          if (sync && frame.type === "subscribe") {
            const snapshot: ServerFrame = { type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) };
            queueMicrotask(() => handlers.message(JSON.stringify(snapshot)));
          }
        },
        close() {
          record.closeCalls += 1;
          if (closed) return;
          closed = true;
          queueMicrotask(() => handlers.closed(1000));
        },
      };
      const run = (step: Step): void => {
        if (typeof step === "object" && "after" in step) {
          setTimeout(() => run(step.step), step.after);
          return;
        }
        queueMicrotask(() => {
          if (closed) return;
          if (step === "open") handlers.opened?.();
          else if (step === "auth") handlers.authenticated?.();
          else if (step === "hello") {
            sync = true;
            handlers.message(JSON.stringify(hello()));
          } else if (step === "sync") sync = true;
          else if ("hello" in step) handlers.message(JSON.stringify(hello(step.hello)));
          else if ("garbage" in step) handlers.message(step.garbage);
          else {
            closed = true;
            handlers.closed(step.close, step.reason);
          }
        });
      };
      for (const step of script(candidate, attempt).steps) run(step);
      return connection;
    },
  });
  return { opens, plan, transport: transports };
}

const loopback = (url = "ws://127.0.0.1:7420/secure"): RemoteCandidate => ({ url, role: "loopback" });
const relay = (url = "wss://relay.example/secure"): RemoteCandidate => ({ url, role: "relay" });
const direct = (url = "wss://direct.example/secure"): RemoteCandidate => ({ url, role: "direct" });

const pair = (): PairingContext => ({ secret: "one-time-secret", name: "test device" });

function options(
  harness: ReturnType<typeof network>,
  timeouts: RemoteDurableOptions["candidateTimeouts"] = {},
  overrides: Partial<NonNullable<Extract<RemoteDurableOptions, { candidates: unknown }>>> = {},
): RemoteDurableOptions {
  return {
    candidates: harness.plan,
    openTransport: harness.transport,
    candidateTimeouts: { socketOpenMs: 100, noiseMs: 100, helloMs: 100, syncMs: 100, ...timeouts },
    roundTimeoutMs: 10_000,
    ...overrides,
  };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const ready = async (pending: Promise<RemoteDurable>): Promise<RemoteDurable> => {
  let done: RemoteDurable | undefined;
  pending.then((remote) => (done = remote), () => undefined);
  for (let i = 0; i < 20 && done === undefined; i++) await flush();
  if (done === undefined) throw new Error("remote did not become ready");
  return done;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("candidate coordinator", () => {
  it("walks candidates in order and retries the same pairing until message 2, then the device identity", async () => {
    const plan = [loopback(), relay(), direct()];
    const seen: (PairingContext | undefined)[] = [];
    const harness = network(plan, (candidate) =>
      candidate.role === "loopback"
        ? { steps: ["open", { close: 1006 }] }
        : candidate.role === "relay"
          ? { steps: ["open", "auth", { close: 1006 }] }
          : { steps: ["open", "auth", "hello", "sync"] },
    );
    const openTransport = harness.transport;
    let paired = 0;
    const remote = await ready(
      connectRemoteDurable({
        ...options(harness, {}, { openTransport: (candidate, pairing) => {
          seen.push(pairing);
          return openTransport(candidate, pairing);
        } }),
        pairing: pair(),
        onPaired: () => {
          paired += 1;
        },
      }),
    );
    try {
      expect(harness.opens.map((open) => open.candidate.role)).toEqual(["loopback", "relay", "direct"]);
      expect(seen).toEqual([pair(), pair(), undefined]);
      expect(paired).toBe(1);
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("reports a failed post-paired save separately and still reaches ready", async () => {
    const seen: (PairingContext | undefined)[] = [];
    let version = 0;
    const harness = network([relay("wss://one/"), direct()], () => ({
      steps: version++ === 0 ? ["open", "auth", { close: 1006 }] : ["open", "auth", "hello", "sync"],
    }));
    const inner = harness.transport;
    const persisted: unknown[] = [];
    const remote = await ready(
      connectRemoteDurable({
        ...options(harness, {}, {
          openTransport: (candidate, pairing) => {
            seen.push(pairing);
            return inner(candidate, pairing);
          },
        }),
        pairing: pair(),
        onPaired: () => Promise.reject(new Error("keychain locked")),
        onPairedError: (error) => persisted.push(error.message),
      }),
    );
    try {
      expect(persisted).toEqual(["keychain locked"]);
      // The failed save does not re-open the invite: the next path uses the
      // device identity, and ready can still complete.
      expect(seen).toEqual([pair(), undefined]);
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("bounds socket open, Noise, hello and first sync, and moves on after each", async () => {
    const plan = [relay("wss://one/"), relay("wss://two/"), relay("wss://three/"), relay("wss://four/"), direct()];
    const failures: CandidateFailure[] = [];
    const harness = network(plan, (candidate) => {
      if (candidate.url === "wss://one/") return { steps: [] };
      if (candidate.url === "wss://two/") return { steps: ["open"] };
      if (candidate.url === "wss://three/") return { steps: ["open", "auth"] };
      if (candidate.url === "wss://four/") return { steps: ["open", "auth", { hello: undefined }] };
      return { steps: ["open", "auth", "hello", "sync"] };
    });
    const pending = connectRemoteDurable(options(harness, {}, { onCandidateFailure: (failure) => failures.push(failure) }));
    await vi.advanceTimersByTimeAsync(400);
    const remote = await ready(pending);
    try {
      expect(failures.map((failure) => failure.stage)).toEqual(["open", "noise", "hello", "sync"]);
      expect(harness.opens).toHaveLength(5);
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("ignores late frames, closes and timers from a retired candidate", async () => {
    const plan = [relay("wss://slow/"), direct()];
    const failures: CandidateFailure[] = [];
    const harness = network(plan, (candidate) =>
      candidate.url === "wss://slow/"
        ? { steps: ["open", { after: 250, step: "hello" }, { after: 260, step: "sync" }, { after: 270, step: { close: 1006 } }] }
        : { steps: ["open", "auth", "hello", "sync"] },
    );
    const pending = connectRemoteDurable(options(harness, {}, { onCandidateFailure: (failure) => failures.push(failure) }));
    await vi.advanceTimersByTimeAsync(200);
    const remote = await ready(pending);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ stage: "noise", candidate: { url: "wss://slow/" } });
      expect(remote.view.current().connection).toBe("connected");
      expect(harness.opens).toHaveLength(2);
    } finally {
      remote.close();
    }
  });

  it("tries a healthy direct after relays close 4401, 4400, 1008 or send garbage", async () => {
    const plan = [relay("wss://unauthorized/"), relay("wss://malformed/"), relay("wss://noise/"), relay("wss://garbage/"), direct()];
    const failures: CandidateFailure[] = [];
    const harness = network(plan, (candidate) => {
      switch (candidate.url) {
        case "wss://unauthorized/":
          return { steps: ["open", "auth", { close: UNAUTHORIZED_CLOSE_CODE }] };
        case "wss://malformed/":
          return { steps: ["open", "auth", { close: 4400, reason: "Invalid client frame" }] };
        case "wss://noise/":
          return { steps: ["open", { close: 1008, reason: "bad handshake" }] };
        case "wss://garbage/":
          return { steps: ["open", { garbage: "not json" }] };
        default:
          return { steps: ["open", "auth", "hello", "sync"] };
      }
    });
    const remote = await ready(
      connectRemoteDurable(options(harness, {}, { onCandidateFailure: (failure) => failures.push(failure) })),
    );
    try {
      expect(failures).toHaveLength(4);
      expect(harness.opens.map((open) => open.candidate.url)).toEqual([
        "wss://unauthorized/",
        "wss://malformed/",
        "wss://noise/",
        "wss://garbage/",
        "wss://direct.example/secure",
      ]);
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("aggregates every path's failure, and only then calls a round unauthorized", async () => {
    const plan = [relay("wss://relay/"), direct()];
    const mixed = network(plan, (candidate) =>
      candidate.role === "relay"
        ? { steps: ["open", "auth", { close: UNAUTHORIZED_CLOSE_CODE }] }
        : { steps: ["open", { close: 1006 }] },
    );
    const error = await connectRemoteDurable(options(mixed)).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ConnectionFailedError);
    expect((error as ConnectionFailedError).failures.map((failure) => failure.candidate.role)).toEqual([
      "relay",
      "direct",
    ]);
    expect((error as ConnectionFailedError).failures[0]?.unauthorized).toBe(true);

    const all = network(plan, () => ({ steps: ["open", "auth", { close: UNAUTHORIZED_CLOSE_CODE }] }));
    const unauthorized = await connectRemoteDurable(options(all)).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(all.opens).toHaveLength(2);
  });

  it("stops the whole round on an authenticated protocol major mismatch", async () => {
    const plan = [relay("wss://one/"), direct()];
    const harness = network(plan, (candidate) =>
      candidate.role === "relay"
        ? { steps: ["open", "auth", "hello"] }
        : { steps: ["open", "auth", "hello", "sync"] },
    );
    // Replace the relay's hello with a mismatching one.
    const transport = (candidate: RemoteCandidate, pairing: PairingContext | undefined) => {
      const inner = harness.transport(candidate, pairing);
      if (candidate.role !== "relay") return inner;
      return {
        label: inner.label,
        open(handlers: FrameHandlers): FrameConnection {
          return inner.open({
            ...handlers,
            message: (data) => {
              const frame = JSON.parse(data) as ServerFrame;
              const next =
                frame.type === "hello"
                  ? { ...frame, protocol: { major: PROTOCOL.major + 1, minor: 0 } }
                  : frame;
              handlers.message(JSON.stringify(next));
            },
          });
        },
      };
    };
    const error = await connectRemoteDurable(options(harness, {}, { openTransport: transport })).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(harness.opens).toHaveLength(1);
  });

  it("adopts a hello endpoint set for the next round, and an explicit empty set closes when only remote", async () => {
    const adopted = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://new-relay/" },
        { transport: "webSocket" as const, role: "direct" as const, url: "wss://new-direct/" },
      ],
    };
    const empty = { schemaVersion: 1 as const, endpoints: [] };
    let announce: EndpointSet | undefined = adopted;
    const sets: EndpointSet[] = [];
    const harness = network([relay("wss://old/")], () => ({
      steps: ["open", "auth", "sync", { hello: announce }],
    }));
    const remote = await ready(
      connectRemoteDurable({
        ...options(harness, {}, { onEndpointSet: (set) => { sets.push(set); } }),
        legacyUrl: "wss://old/",
      }),
    );
    try {
      expect(sets).toEqual([adopted]);
      // The live connection stays on the old relay; the next round starts with the announced set.
      harness.opens.at(-1)!.handlers.closed(1006);
      await flush();
      expect(harness.opens.map((open) => open.candidate.url)).toEqual(["wss://old/", "wss://new-relay/"]);
    } finally {
      remote.close();
    }

    const closed = network([relay("wss://new-relay/")], () => ({
      steps: ["open", "auth", "sync", { hello: empty }],
    }));
    const second = await ready(connectRemoteDurable({ ...options(closed), legacyUrl: "wss://old/" }));
    try {
      expect(closed.opens).toHaveLength(1);
      closed.opens[0]!.handlers.closed(1006);
      await flush();
      expect(closed.opens).toHaveLength(1);
      expect(second.view.current().connection).toBe("closed");
      expect(second.view.current().notices.at(-1)?.message).toContain("Remote access is unavailable");
    } finally {
      second.close();
    }
  });

  it("skips an unsupported candidate and reports it as skipped, not as a host failure", async () => {
    const plan = [
      { ...relay("ws://relay.example/"), unsupported: "This HTTPS page blocks the insecure ws:// connection" },
      direct(),
    ];
    const failures: CandidateFailure[] = [];
    const harness = network(plan, () => ({ steps: ["open", "auth", "hello", "sync"] }));
    const remote = await ready(
      connectRemoteDurable(options(harness, {}, { onCandidateFailure: (failure) => failures.push(failure) })),
    );
    try {
      expect(harness.opens.map((open) => open.candidate.role)).toEqual(["direct"]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ stage: "unsupported", unauthorized: false });
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("keeps the current candidates when a hello set is malformed or unsupported", async () => {
    for (const bad of [
      { schemaVersion: 1, endpoints: "junk" },
      { schemaVersion: 2, endpoints: [] },
    ]) {
      let version = 0;
      const harness = network([relay("wss://old/")], () => ({
        steps: version++ === 0 ? ["open", "auth", "sync", { hello: bad as unknown as EndpointSet }] : ["open", "auth", "hello", "sync"],
      }));
      const sets: EndpointSet[] = [];
      const remote = await ready(
        connectRemoteDurable({
          ...options(harness, {}, { onEndpointSet: (set) => { sets.push(set); } }),
          legacyUrl: "wss://old/",
        }),
      );
      try {
        expect(sets).toEqual([]);
        harness.opens[0]!.handlers.closed(1006);
        await flush();
        expect(harness.opens.map((open) => open.candidate.url)).toEqual(["wss://old/", "wss://old/"]);
      } finally {
        remote.close();
      }
    }
  });

  it("keeps a client-local loopback through an explicit empty remote set", async () => {
    const empty = { schemaVersion: 1 as const, endpoints: [] };
    const harness = network([loopback()], () => ({ steps: ["open", "auth", "sync", { hello: empty }] }));
    const remote = await ready(connectRemoteDurable({ ...options(harness), legacyUrl: "ws://127.0.0.1:7420/secure" }));
    try {
      harness.opens[0]!.handlers.closed(1006);
      await flush();
      expect(harness.opens.map((open) => open.candidate.role)).toEqual(["loopback", "loopback"]);
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }
  });

  it("restarts a round after a ready connection drops, backs off only after the whole round, and wakes on network change", async () => {
    let fail = false;
    let version = 0;
    const plan = [relay("wss://relay/"), direct()];
    const harness = network(plan, (candidate) => {
      const current = version++;
      if (!fail) return { steps: ["open", "auth", "hello", "sync"] };
      return { steps: ["open", { close: 1006 }] };
    });
    let wake!: () => void;
    const remote = await ready(
      connectRemoteDurable({
        ...options(harness, {}, { reconnectDelayMs: { min: 1_000, max: 1_000 } }),
        network: { subscribe: (listener) => { wake = listener; return () => undefined; } },
      }),
    );
    try {
      fail = true;
      version = 0;
      const before = harness.opens.length;
      harness.opens.at(-1)!.handlers.closed(1006);
      await flush();
      // Both candidates are walked immediately; the backoff starts only now.
      expect(harness.opens).toHaveLength(before + 2);
      expect(remote.view.current().connection).toBe("reconnecting");
      const afterRound = harness.opens.length;
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.opens).toHaveLength(afterRound);
      wake();
      await flush();
      expect(harness.opens.length).toBeGreaterThan(afterRound);
    } finally {
      remote.close();
    }
  });
});
