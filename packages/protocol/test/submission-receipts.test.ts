import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import {
  INVALID_FRAME_CLOSE_CODE,
  PROTOCOL,
  UNAUTHORIZED_CLOSE_CODE,
  type ClientFrame,
  type ServerFrame,
  type StreamName,
} from "../src/frames.ts";
import { connectRemoteDurable, type RemoteDurable } from "../src/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";
import type { DurableView, LogicalSubmission } from "../src/view.ts";

const id = (n: number): ConversationId => n as ConversationId;
const HOST_DOCS = [
  { kind: "pi.inbox" },
  { kind: "pinomad.question", presentation: "pinomad.question" as const },
];

type Answer = { ok: true; value: unknown } | { ok: false; error: string };
type CallFrame = Extract<ClientFrame, { type: "call" }>;

const DEFAULT_SNAPSHOTS: Record<string, unknown> = {
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
    hostName: "Testbox",
    custom: [],
  },
  agents: { roles: [], problems: [] },
  providers: { providers: [], logins: [] },
};

function conversationView(entries: readonly unknown[], inbox: readonly unknown[] = []): ConversationView {
  return {
    conversation: { id: 1 },
    entries,
    docs: { "pi.live": {}, "pi.inbox": { items: inbox } },
  } as unknown as ConversationView;
}

function userEntry(entryId: number, text: string, timestamp = 1_000): unknown {
  return { id: entryId, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp }] };
}

function createHost(minor = PROTOCOL.minor) {
  const opened: FrameHandlers[] = [];
  const sent: ClientFrame[] = [];
  const held = new Map<number, CallFrame>();
  const snapshots = new Map<string, unknown>(Object.entries(DEFAULT_SNAPSHOTS));
  let handler: FrameHandlers | undefined;
  let submitAnswer: (call: CallFrame) => Answer | undefined = () => undefined;
  let submissionAnswer: (call: CallFrame) => Answer | undefined = () => undefined;
  let withdrawAnswer: (call: CallFrame) => Answer | undefined = () => ({ ok: true, value: { outcome: "withdrawn" } });
  const genericAnswers = new Map<string, (call: CallFrame) => Answer | undefined>();

  const snapshotFor = (stream: string): unknown => {
    if (snapshots.has(stream)) return snapshots.get(stream);
    if (stream.startsWith("doc:")) {
      return stream.includes("pi.inbox") ? { items: [] } : null;
    }
    if (stream.startsWith("conversation:")) return conversationView([]);
    return null;
  };

  const answer = (call: CallFrame, value: Answer): void => {
    const frame: ServerFrame =
      value.ok === true
        ? { type: "result", id: call.id, ok: true, value: value.value }
        : { type: "result", id: call.id, ok: false, error: value.error };
    queueMicrotask(() => handler?.message(JSON.stringify(frame)));
  };

  const answerFor = (call: CallFrame): Answer | undefined => {
    if (call.method === "submit") return submitAnswer(call);
    if (call.method === "submission") return submissionAnswer(call);
    if (call.method === "withdrawQueued") return withdrawAnswer(call);
    return genericAnswers.get(call.method)?.(call) ?? { ok: true, value: undefined };
  };

  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      handler = handlers;
      const hello = {
        type: "hello",
        protocol: { major: PROTOCOL.major, minor },
        session: { id: "fake", directory: "" },
        models: [],
        docs: HOST_DOCS,
        toolPresentations: {},
        defaults: {},
      };
      queueMicrotask(() => handlers.message(JSON.stringify(hello)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe") {
            queueMicrotask(() =>
              handler?.message(JSON.stringify({ type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) })),
            );
          } else if (frame.type === "call") {
            const configured = answerFor(frame);
            if (configured === undefined) held.set(frame.id, frame);
            else answer(frame, configured);
          }
        },
        close() {
          queueMicrotask(() => handlers.closed(1000));
        },
      };
    },
  };

  return {
    transport,
    opened,
    sent,
    held,
    setSubmitAnswer: (fn: (call: CallFrame) => Answer | undefined) => {
      submitAnswer = fn;
    },
    setSubmissionAnswer: (fn: (call: CallFrame) => Answer | undefined) => {
      submissionAnswer = fn;
    },
    setWithdrawAnswer: (fn: (call: CallFrame) => Answer | undefined) => {
      withdrawAnswer = fn;
    },
    setCallAnswer: (method: string, fn: (call: CallFrame) => Answer | undefined) => {
      genericAnswers.set(method, fn);
    },
    answer(call: CallFrame, value: Answer) {
      held.delete(call.id);
      answer(call, value);
    },
    answerMethod(method: string, value: Answer): CallFrame | undefined {
      const call = [...held.values()].find((candidate) => candidate.method === method);
      if (call !== undefined) {
        held.delete(call.id);
        answer(call, value);
      }
      return call;
    },
    calls(method?: string): CallFrame[] {
      return sent.filter((frame): frame is CallFrame => frame.type === "call" && (method === undefined || frame.method === method));
    },
    submits(): CallFrame[] {
      return this.calls("submit");
    },
    sendSnapshot(stream: string, value: unknown): void {
      snapshots.set(stream, value);
      handler?.message(JSON.stringify({ type: "snapshot", stream, value }));
    },
    sendOps(stream: string, ops: unknown): void {
      handler?.message(JSON.stringify({ type: "ops", stream, ops }));
    },
    disconnect(code = 1000): void {
      handler?.closed(code);
    },
    close(code = 1000): void {
      handler?.closed(code);
    },
  };
}

function waitFor(remote: RemoteDurable, predicate: (view: DurableView) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("view condition not met within 2s"));
    }, 2000);
    const unsubscribe = remote.view.subscribe(() => {
      if (predicate(remote.view.current())) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    if (predicate(remote.view.current())) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

async function connected(host = createHost(), minor?: number): Promise<RemoteDurable> {
  const remote = await connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 0, max: 0 } });
  if (minor !== undefined) {
    // The host's hello already fixed the minor; this branch exists to make
    // old-host tests read at the call site.
  }
  await remote.controller.switchConversation(id(1));
  return remote;
}

const submissions = (remote: RemoteDurable): readonly LogicalSubmission[] =>
  remote.view.current().submissions ?? [];
const onlySubmission = (remote: RemoteDurable): LogicalSubmission => {
  const items = submissions(remote);
  expect(items).toHaveLength(1);
  return items[0]!;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("logical submissions", () => {
  it("keeps the local bubble until the result names its entry, then settles on the snapshot", async () => {
    const host = createHost();
    const remote = await connected(host);
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const call = await waitForCall(host, "submit", 1);
      expect(call.args).toMatchObject({ conversationId: 1, requestId: "r1" });
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      expect(onlySubmission(remote).placement).toBe("conversation");

      host.answer(call, { ok: true, value: { submissionId: 7, entry: 42 } });
      await submit;
      await waitFor(remote, (view) => view.submissions?.[0]?.submissionId === 7);
      expect(onlySubmission(remote)).toMatchObject({ submissionId: 7, entry: 42, phase: "inFlight" });
      expect(host.submits()).toHaveLength(1);

      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("allows the short duplicate when the snapshot arrives before the result", async () => {
    const host = createHost();
    const remote = await connected(host);
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const call = await waitForCall(host, "submit", 1);
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await waitFor(remote, (view) => (view.conversation?.entries.length ?? 0) === 1);
      // Both the host bubble and the local row are visible until the result lands.
      expect(onlySubmission(remote).phase).toBe("inFlight");
      // The host bubble plus the still-local row: the allowed short duplicate.
      expect(remote.view.current().conversation?.entries).toHaveLength(1);
      expect(submissions(remote)).toHaveLength(1);

      host.answer(call, { ok: true, value: { submissionId: 7, entry: 42 } });
      await submit;
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(remote.view.current().conversation?.entries).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("does not mistake another device's entry or inbox row for this submission", async () => {
    const host = createHost();
    let query: Answer | undefined;
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    host.setSubmissionAnswer(() => query);
    const remote = await connected(host);
    try {
      await remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => view.submissions?.[0]?.submissionId === 7);
      host.sendSnapshot("conversation:1", conversationView([userEntry(99, "other device")]));
      host.sendSnapshot("doc:pi.inbox:1", { items: [{ id: 8, mode: "steer", content: "other" }] });
      await waitFor(remote, (view) => (view.conversation?.entries.length ?? 0) === 1);
      expect(onlySubmission(remote).phase).toBe("inFlight");

      // The inbox row with the host id is the fact; a queued result confirms it.
      host.sendSnapshot("doc:pi.inbox:1", { items: [{ id: 7, mode: "steer", content: "hello" }] });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
    } finally {
      remote.close();
    }
  });

  it("removes a queued row consumed before the client saw it: query says done", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    host.setSubmissionAnswer(() => ({ ok: true, value: { submissionId: 7, status: "done" } }));
    const remote = await connected(host);
    try {
      await remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.calls("submission")).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("removes a placed entry that a reset trimmed away", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    host.setSubmissionAnswer(() => ({ ok: true, value: { submissionId: 7, status: "done", entry: 42 } }));
    const remote = await connected(host);
    try {
      await remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
    } finally {
      remote.close();
    }
  });

  it("queries after a lost result, settles the found record, and never resends", async () => {
    const host = createHost();
    const remote = await connected(host);
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const call = host.held.values().next().value as CallFrame;
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      // The reconnect starts immediately; its query must find this record.
      host.setSubmissionAnswer(() => ({ ok: true, value: { submissionId: 7, status: "done", entry: 42 } }));
      host.disconnect();
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;
      await waitFor(remote, (view) => view.connection === "connected" && (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(1);
      expect(host.calls("submission")).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("resends only a null query, with the same requestId and fixed conversation", async () => {
    const host = createHost();
    const remote = await connected(host);
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const first = host.held.values().next().value as CallFrame;
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      host.setSubmissionAnswer(() => ({ ok: true, value: null }));
      host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7, entry: 42 } }));
      host.disconnect();
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;

      const resubmit = await waitForCall(host, "submit", 2);
      expect(resubmit.args).toMatchObject({ conversationId: 1, requestId: "r1" });
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(2);
    } finally {
      remote.close();
    }
  });

  it("queries again when a queued row disappears before the inbox snapshot", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    let queries = 0;
    host.setSubmissionAnswer(() => {
      queries += 1;
      return queries === 1
        ? { ok: true, value: { submissionId: 7, status: "queued" } }
        : { ok: true, value: { submissionId: 7, status: "done" } };
    });
    const remote = await connected(host);
    try {
      await remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => view.submissions?.[0]?.submissionId === 7);
      await waitForCall(host, "submission", 1);
      host.sendSnapshot("doc:pi.inbox:1", { items: [] });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.calls("submission")).toHaveLength(2);
    } finally {
      remote.close();
    }
  });
  it("turns a 30s silence into unknown, and a late admission settles without a resend", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const remote = await connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 0, max: 0 } });
    await remote.controller.switchConversation(id(1));
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const call = await waitForCall(host, "submit", 1);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      vi.advanceTimersByTime(30_000);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");

      host.answer(call, { ok: true, value: { submissionId: 7, entry: 42 } });
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await submit;
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(1);
    } finally {
      remote.close();
      vi.useRealTimers();
    }
  });

  it("times out a retried resend, frees the command chain, and settles its late result", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const remote = await connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 0, max: 0 } });
    await remote.controller.switchConversation(id(1));
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitForCall(host, "submit", 1);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      vi.advanceTimersByTime(30_000);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;
      expect(host.submits()).toHaveLength(1);

      // The retry query misses, then the host holds the retried submit.
      host.setSubmissionAnswer(() => ({ ok: true, value: null }));
      host.setSubmitAnswer(() => undefined);
      const retry = remote.controller.retrySubmission("r1");
      const resend = await waitForCall(host, "submit", 2);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");

      // The retry still owns the command chain until its own 30s deadline.
      const modeled = remote.controller.setModel({ provider: "p", modelId: "m" });
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
      expect(host.calls("setModel")).toHaveLength(0);

      vi.advanceTimersByTime(30_000);
      await retry;
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await modeled;
      expect(host.calls("setModel")).toHaveLength(1);
      expect(host.submits()).toHaveLength(2);

      // The retried submit's late result still reconciles the request.
      host.answer(resend, { ok: true, value: { submissionId: 7, entry: 42 } });
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
    } finally {
      remote.close();
      vi.useRealTimers();
    }
  });

  it("can retry again after a retried resend times out, and a late fact releases it", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const remote = await connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 0, max: 0 } });
    await remote.controller.switchConversation(id(1));
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitForCall(host, "submit", 1);
      vi.advanceTimersByTime(30_000);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;

      host.setSubmissionAnswer(() => ({ ok: true, value: null }));
      host.setSubmitAnswer(() => undefined);
      const firstRetry = remote.controller.retrySubmission("r1");
      const firstResend = await waitForCall(host, "submit", 2);
      vi.advanceTimersByTime(30_000);
      await firstRetry;
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");

      // Retry again after the first retry timed out.
      const secondRetry = remote.controller.retrySubmission("r1");
      const secondResend = await waitForCall(host, "submit", 3);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");

      // The first retry's late result is a fact for the same requestId, so it
      // releases the second retry without waiting for another result.
      host.answer(firstResend, { ok: true, value: { submissionId: 7, entry: 42 } });
      await secondRetry;
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(3);

      // The second resend's own late result is harmless after the settlement.
      host.answer(secondResend, { ok: true, value: { submissionId: 7, entry: 42 } });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
    } finally {
      remote.close();
      vi.useRealTimers();
    }
  });

  it("keeps a retry unknown when it disconnects again, then settles without a third send", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const remote = await connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 0, max: 0 } });
    await remote.controller.switchConversation(id(1));
    try {
      const first = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitForCall(host, "submit", 1);
      vi.advanceTimersByTime(30_000);
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");

      // The timeout retry asks first; a null answer resends the same key.
      host.setSubmitAnswer(() => undefined);
      let queries = 0;
      host.setSubmissionAnswer(() => {
        queries += 1;
        return queries === 1
          ? { ok: true, value: null }
          : { ok: true, value: { submissionId: 7, status: "done", entry: 42 } };
      });
      const retry = remote.controller.retrySubmission("r1");
      await waitForCall(host, "submit", 2);
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      host.disconnect();
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await retry;
      void first;

      await vi.advanceTimersByTimeAsync(0);
      await waitFor(remote, (view) => view.connection === "connected" && (view.submissions ?? []).length === 0);
      expect(host.submits()).toHaveLength(2);
      expect(host.calls("submission")).toHaveLength(2);
    } finally {
      remote.close();
      vi.useRealTimers();
    }
  }, 10_000);
  it("blocks a queued switch and setModel until recovery finishes, and keeps the target", async () => {
    const host = createHost();
    const remote = await connected(host);
    try {
      const submit = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "inFlight");
      host.disconnect();
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;

      // The reconnect is visible, but the recovery query holds the sync gate.
      host.setSubmissionAnswer(() => undefined);
      await waitFor(remote, (view) => view.connection === "connected");
      await waitForCall(host, "submission", 1);
      const switched = remote.controller.switchConversation(id(2));
      const modelled = remote.controller.setModel({ provider: "p", modelId: "m" });
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
      expect(host.calls("submission")).toHaveLength(1);
      expect(host.calls("setModel")).toHaveLength(0);
      expect(host.sent.some((frame) => frame.type === "call" && frame.method === "submit" && frame.args.conversationId === 2)).toBe(false);

      const query = host.calls("submission")[0]!;
      host.answer(query, { ok: true, value: null });
      host.setSubmitAnswer(() => undefined);
      await waitForCall(host, "submit", 2);
      const resent = host.calls("submit")[1]!;
      expect(resent.args).toMatchObject({ conversationId: 1, requestId: "r1" });
      expect(host.calls("setModel")).toHaveLength(0);

      host.answer(resent, { ok: true, value: { submissionId: 7, entry: 42 } });
      host.sendSnapshot("conversation:1", conversationView([userEntry(42, "hello")]));
      await switched;
      await modelled;
      expect(host.calls("setModel")).toHaveLength(1);
      expect(host.sent.some((frame) => frame.type === "subscribe" && String(frame.stream) === "conversation:2")).toBe(true);
    } finally {
      remote.close();
    }
  }, 10_000);

  it("treats a repeated requestId as one send", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7, entry: 42 } }));
    const remote = await connected(host);
    try {
      const first = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      const second = remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await Promise.all([first, second]);
      expect(host.submits()).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("opens Edit only for a failure or a query-confirmed unadmitted send", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: false, error: "refused" }));
    const remote = await connected(host);
    try {
      await remote.controller.submit("failed one", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "failed");
      expect(await remote.controller.takeBackSubmission("r1")).toMatchObject({ text: "failed one" });
      expect(submissions(remote)).toHaveLength(0);
    } finally {
      remote.close();
    }

    const queued = createHost();
    let query: Answer | undefined = { ok: true, value: { submissionId: 7, status: "queued" } };
    queued.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    queued.setSubmissionAnswer(() => query);
    const remote2 = await connected(queued);
    try {
      await remote2.controller.submit("queued one", "followUp", { requestId: "r2" });
      await waitFor(remote2, (view) => view.submissions?.[0]?.submissionId === 7);
      expect(await remote2.controller.takeBackSubmission("r2")).toMatchObject({ text: "queued one" });
      expect(queued.calls("withdrawQueued")).toHaveLength(1);
    } finally {
      remote2.close();
    }

    const placed = createHost();
    placed.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    placed.setSubmissionAnswer(() => ({ ok: true, value: { submissionId: 7, status: "placed", entry: 42 } }));
    const remote3 = await connected(placed);
    try {
      await remote3.controller.submit("placed one", "followUp", { requestId: "r3" });
      await waitFor(remote3, (view) => view.submissions?.[0]?.submissionId === 7);
      expect(await remote3.controller.takeBackSubmission("r3")).toBeUndefined();
      expect(placed.calls("withdrawQueued")).toHaveLength(0);
    } finally {
      remote3.close();
    }
  });


  it("resolves ref images before taking back a failed submission", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: false, error: "refused" }));
    host.setCallAnswer("image", () => ({ ok: true, value: { data: "aGk=", mimeType: "image/png" } }));
    const remote = await connected(host);
    try {
      await remote.controller.submit("look", "followUp", {
        requestId: "r1",
        images: [{ ref: "ref-1" }],
        imageViews: [{ ref: "ref-1", mimeType: "image/png" }],
      });
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "failed");
      const draft = await remote.controller.takeBackSubmission("r1");
      expect(draft?.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
      expect(submissions(remote)).toHaveLength(0);
    } finally {
      remote.close();
    }
  });

  it("keeps a failed submission when one of its ref images cannot be resolved", async () => {
    const host = createHost();
    host.setSubmitAnswer(() => ({ ok: false, error: "refused" }));
    host.setCallAnswer("image", () => ({ ok: false, error: "gone" }));
    const remote = await connected(host);
    try {
      await remote.controller.submit("look", "followUp", {
        requestId: "r1",
        images: [{ ref: "ref-1" }],
        imageViews: [{ ref: "ref-1", mimeType: "image/png" }],
      });
      await waitFor(remote, (view) => view.submissions?.[0]?.phase === "failed");
      await expect(remote.controller.takeBackSubmission("r1")).rejects.toThrow("Couldn't load");
      expect(onlySubmission(remote).phase).toBe("failed");
    } finally {
      remote.close();
    }
  });

  it("degrades on a pre-5.25 host: result removes the row, no query, no automatic resend", async () => {
    const host = createHost(24);
    host.setSubmitAnswer(() => ({ ok: true, value: { submissionId: 7 } }));
    const remote = await connected(host, 24);
    try {
      await remote.controller.submit("hello", "followUp", { requestId: "r1" });
      await waitFor(remote, (view) => (view.submissions ?? []).length === 0);
      expect(host.calls("submission")).toHaveLength(0);
    } finally {
      remote.close();
    }

    const host2 = createHost(24);
    const remote2 = await connected(host2, 24);
    try {
      const submit = remote2.controller.submit("hello", "followUp", { requestId: "r2" });
      await waitFor(remote2, (view) => view.submissions?.[0]?.phase === "inFlight");
      host2.disconnect();
      await waitFor(remote2, (view) => view.submissions?.[0]?.phase === "unknown");
      await submit;
      await waitFor(remote2, (view) => view.connection === "connected");
      expect(host2.submits()).toHaveLength(1);
      expect(host2.calls("submission")).toHaveLength(0);
      expect(onlySubmission(remote2).phase).toBe("unknown");
    } finally {
      remote2.close();
    }
  });
});

async function waitForCall(host: ReturnType<typeof createHost>, method: string, count: number): Promise<CallFrame> {
  for (let i = 0; i < 200; i++) {
    const calls = host.calls(method);
    if (calls.length >= count) return calls[count - 1]!;
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  }
  throw new Error(`no ${count} ${method} calls`);
}
