// Push notifications: token registration over the secure channel and the
// outbound Expo sender. Fetch and timers are fakes — no request ever leaves
// the test process, and retries/waits run on a manual clock.
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { DevicesDoc } from "../src/devices.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { PushDoc, pushTokenProblem, type PushFetch, type PushTimers } from "../src/push.ts";
import { connectTo, freePort, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Deterministic scheduler for the sender's retries, title wait, and receipt check. */
class ManualTimers implements PushTimers {
  #seq = 0;
  #now = 0;
  #queue: { id: number; at: number; fn: () => void }[] = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#queue.push({ id, at: this.#now + ms, fn });
    this.#queue.sort((a, b) => a.at - b.at);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#queue = this.#queue.filter((entry) => entry.id !== handle);
  };

  get pending(): number {
    return this.#queue.length;
  }

  /** Fire every timer due within `ms`, including ones they schedule. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const next = this.#queue.find((entry) => entry.at <= until);
      if (next === undefined) break;
      this.#queue.splice(this.#queue.indexOf(next), 1);
      this.#now = next.at;
      next.fn();
    }
    this.#now = until;
  }
}

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type ExpoAnswer = { status?: number; body: unknown };

/**
 * The Expo API double: records every request and answers sends with an ok
 * ticket (or what `responder` says). `waitForCalls` is a barrier, not a sleep.
 */
function fakeExpo(responder?: (request: RecordedRequest) => ExpoAnswer | Promise<ExpoAnswer>): {
  calls: RecordedRequest[];
  fetch: PushFetch;
  waitForCalls(n: number): Promise<void>;
} {
  const calls: RecordedRequest[] = [];
  const waiters: { n: number; resolve(): void }[] = [];
  const fetch: PushFetch = async (url, init) => {
    const request: RecordedRequest = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(request);
    for (const waiter of [...waiters]) {
      if (calls.length >= waiter.n) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    const answer = (await responder?.(request)) ?? { body: { data: { status: "ok", id: `ticket-${calls.length}` } } };
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: () => Promise.resolve(answer.body) };
  };
  const waitForCalls = (n: number): Promise<void> =>
    new Promise((resolve) => {
      if (calls.length >= n) resolve();
      else waiters.push({ n, resolve });
    });
  return { calls, fetch, waitForCalls };
}

/** Resolve once `predicate` holds; polled — the test is gated on the condition, not on a duration. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A short settle window for assertions that must stay empty (no fetch, no write). */
const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pair a fresh device over the remote listener; resolves to its client and key. */
async function pairDevice(host: OpenedHost, name: string): Promise<{ client: RemoteDurable; device: KeyPair }> {
  const tokenClient = await connectTo(defer, host);
  const { url } = await tokenClient.controller.createPairing();
  const marker = "#pair=";
  const [key, secret] = url.slice(url.indexOf(marker) + marker.length).split(".");
  const device = generateKeyPair();
  const client = await connectRemoteDurable({
    transport: secureWebSocketTransport({
      url: host.remote!.url,
      hostKey: host.remote!.hostKey,
      device,
      pairing: { secret: secret!, name },
    }),
    reconnectDelayMs: { min: 100, max: 200 },
  });
  defer(() => client.close());
  return { client, device };
}

const registrations = (host: OpenedHost) =>
  host.harness.snapshot(PushDoc, context).then((doc) => doc?.registrations ?? []);

/**
 * A faux step that ends the run waiting on ask_user_question. Factory, not a
 * constant: the callId is baked into the step, and a conversation asking the
 * same question twice needs a distinct id per round.
 */
const questionStep = () =>
  fauxAssistantMessage(
    fauxToolCall("ask_user_question", {
      questions: [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
    }),
    { stopReason: "toolUse" },
  );
const QUESTION_STEP = questionStep();

/** The doc kind + id of the currently unresolved question request in the shown conversation. */
const pendingQuestion = async (client: RemoteDurable): Promise<{ kind: string; requestId: string }> => {
  type QuestionDoc = { requests: { id: string; resolution?: unknown }[] };
  const pending = (view: ReturnType<RemoteDurable["view"]["current"]>): { kind: string; requestId: string } | undefined => {
    const doc = view.docs.find((each) => each.presentation === "pinomad.question");
    const request = (doc?.value as QuestionDoc | null | undefined)?.requests.find((each) => each.resolution === undefined);
    return doc !== undefined && request !== undefined ? { kind: doc.kind, requestId: request.id } : undefined;
  };
  await waitForView(client.view, (view) => pending(view) !== undefined);
  return pending(client.view.current())!;
};

const answerQuestion = async (client: RemoteDurable, selected: string): Promise<void> => {
  const { kind, requestId } = await pendingQuestion(client);
  await client.controller.answer(kind, requestId, [{ selected: [selected] }]);
};

type FauxOptions = NonNullable<Parameters<typeof startFauxHost>[1]>;

async function pushHost(
  options: Omit<FauxOptions, "push" | "remote"> & { expo: ReturnType<typeof fakeExpo>; timers?: ManualTimers },
): Promise<{ host: OpenedHost; expo: ReturnType<typeof fakeExpo>; timers: ManualTimers }> {
  const { expo, timers = new ManualTimers(), ...rest } = options;
  const host = await startFauxHost(defer, {
    ...rest,
    remote: { port: await freePort() },
    push: { fetch: expo.fetch, timers },
  });
  return { host, expo, timers };
}

describe("push token registration", () => {
  it("registers, replaces, and clears a device's token; the devices stream never carries it", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const { client, device } = await pairDevice(host, "phone");
    const key = toBase64Url(device.publicKey);
    const tokenClient = await connectTo(defer, host);
    await waitForView(tokenClient.view, (view) => view.devices.some((entry) => entry.publicKey === key));

    await client.controller.setPushToken(TOKEN_A);
    expect(await registrations(host)).toEqual([{ publicKey: key, token: TOKEN_A, updatedAt: expect.any(Number) }]);
    // A token is a send capability: it must not ride the devices stream.
    const entry = tokenClient.view.current().devices.find((each) => each.publicKey === key);
    expect(Object.keys(entry ?? {}).sort()).toEqual(["name", "pairedAt", "publicKey"]);

    await client.controller.setPushToken(TOKEN_B);
    expect(await registrations(host)).toEqual([{ publicKey: key, token: TOKEN_B, updatedAt: expect.any(Number) }]);

    await client.controller.setPushToken(null);
    expect(await registrations(host)).toEqual([]);
  });

  it("rejects token clients, bad token shapes, and unpaired devices", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const tokenClient = await connectTo(defer, host);
    await expect(tokenClient.controller.setPushToken(TOKEN_A)).rejects.toThrow(/secure channel/);

    const { client, device } = await pairDevice(host, "phone");
    await expect(client.controller.setPushToken("not-a-token")).rejects.toThrow(/Expo push token/);
    await expect(client.controller.setPushToken("x".repeat(300))).rejects.toThrow(/too long/);
    expect(pushTokenProblem("ExpoPushToken[works-too]")).toBeUndefined();

    // A device dropped from the table while still connected registers nothing.
    const key = toBase64Url(device.publicKey);
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(DevicesDoc);
      doc.devices = doc.devices.filter((entry) => entry.publicKey !== key);
    }, context);
    await expect(client.controller.setPushToken(TOKEN_A)).rejects.toThrow(/not paired/);
    expect(await registrations(host)).toEqual([]);
  });

  it("closes the connection on malformed call args (4400)", async () => {
    const host = await startFauxHost(defer);
    const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => socket.terminate());
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "call", id: 1, method: "setPushToken", args: {} }));
    expect((await closed)[0]).toBe(4400);
  });

  it("deletes the device's token in the same commit as revocation", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const { client, device } = await pairDevice(host, "phone");
    const key = toBase64Url(device.publicKey);
    const tokenClient = await connectTo(defer, host);
    await client.controller.setPushToken(TOKEN_A);
    expect(await registrations(host)).toHaveLength(1);

    await tokenClient.controller.revokeDevice(key);
    await waitForView(tokenClient.view, (view) => view.devices.length === 0);
    expect(await registrations(host)).toEqual([]);
    await waitForView(client.view, (view) => view.connection !== "connected");
  });
});

describe("push sender", () => {
  it("pushes nothing for state that predates the host start or the registration", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path, extensions: [question], answers: [QUESTION_STEP] });
    const seed = await connectTo(defer, first);
    const id = await startChat(seed, "deploy the thing");
    await waitForView(seed.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    seed.close();
    await first.close();

    // Restart with the sender attached: the standing needs-answer seeds the baseline silently.
    const expo = fakeExpo();
    const timers = new ManualTimers();
    const { host } = await pushHost({ expo, timers, dataDir: dir.path, extensions: [question], answers: ["done"] });
    const { client } = await pairDevice(host, "phone");
    const watcher = await connectTo(defer, host);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await watcher.controller.switchConversation(id); // docs load for the shown conversation only

    await client.controller.setPushToken(TOKEN_A);
    await settle();
    expect(expo.calls).toHaveLength(0);

    // A genuine transition does notify: answer → the run resumes and finishes.
    await answerQuestion(watcher, "Yes");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.length > 0 && view.organized.chats[0]!.summary.status === undefined,
    );
    // The Finished item's title-wait timer must be queued before advancing.
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15_000);
    await expo.waitForCalls(1);
    expect(expo.calls[0]!.url).toBe(SEND_URL);
    expect(expo.calls[0]!.body).toMatchObject({ to: TOKEN_A, body: "Finished" });
  });

  it("pushes waiting and failure events immediately with the fixed title, never the first message", async () => {
    const expo = fakeExpo();
    const timers = new ManualTimers();
    const { host } = await pushHost({
      expo,
      timers,
      extensions: [question],
      answers: [QUESTION_STEP, fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "provider blew up" })],
    });
    const { client } = await pairDevice(host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    const firstMessage = "deploy the thing now please";
    const id = await startChat(watcher, firstMessage);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");

    // No title yet and "Waiting" does not wait for one.
    await expo.waitForCalls(1);
    const waiting = expo.calls[0]!.body as { title?: string; body?: string; data?: Record<string, unknown> };
    expect(waiting).toMatchObject({
      to: TOKEN_A,
      body: "Waiting for your answer",
      title: "PiNomad conversation",
      sound: "default",
      ttl: 3600,
      data: { hostKey: toBase64Url(host.remote!.hostKey), conversationId: id },
      threadId: `${toBase64Url(host.remote!.hostKey)}:${id}`,
      collapseId: `${toBase64Url(host.remote!.hostKey)}:${id}`,
    });
    expect(waiting.title).not.toContain("deploy");

    // A failing run pushes "Failed" the same way — immediately, no title wait.
    await answerQuestion(watcher, "Yes");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "failed");
    await expo.waitForCalls(2);
    expect(expo.calls[1]!.body).toMatchObject({ to: TOKEN_A, body: "Failed", title: "PiNomad conversation" });
  });

  it("waits for the auto-title on Finished, falls back after the title wait elapses", async () => {
    const expo = fakeExpo();
    const timers = new ManualTimers();
    const { host } = await pushHost({
      expo,
      timers,
      autoTitle: true,
      answers: [
        "all done",
        "Fix the crash loop", // the auto-title model call
        "silent run",
        fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "title model down" }),
      ],
    });
    const { client } = await pairDevice(host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "the app keeps crashing");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === undefined);

    // The notification holds for the pinomad.title write, then carries it.
    await waitUntil(() => timers.pending > 0);
    expect(expo.calls).toHaveLength(0);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.title === "Fix the crash loop");
    await expo.waitForCalls(1);
    expect(expo.calls[0]!.body).toMatchObject({ title: "Fix the crash loop", body: "Finished" });

    // A run whose title never lands sends the fixed title once the wait elapses.
    const id2 = await startChat(watcher, "and again, silently");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.some((node) => node.summary.id === id2 && node.summary.status === undefined),
    );
    // Two timers pending: the first send's receipt check and this one's title wait.
    await waitUntil(() => timers.pending >= 2);
    expect(expo.calls).toHaveLength(1);
    timers.advance(15_000);
    await expo.waitForCalls(2);
    expect(expo.calls[1]!.body).toMatchObject({
      title: "PiNomad conversation",
      body: "Finished",
      data: { conversationId: id2 },
    });
  });

  it("sends one request per distinct token and isolates a failing token from the rest", async () => {
    const expo = fakeExpo((request) =>
      request.body["to"] === TOKEN_A
        ? { status: 500, body: { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "expo down" }] } }
        : { body: { data: { status: "ok", id: "ticket-ok" } } },
    );
    const timers = new ManualTimers();
    const { host } = await pushHost({ expo, timers, answers: ["done"] });
    const a = await pairDevice(host, "phone-a");
    const b = await pairDevice(host, "phone-b");
    const c = await pairDevice(host, "phone-c");
    await a.client.controller.setPushToken(TOKEN_A);
    await b.client.controller.setPushToken(TOKEN_B);
    // A reinstall can register the same Expo token twice — it sends once.
    await c.client.controller.setPushToken(TOKEN_B);
    expect(await registrations(host)).toHaveLength(3);

    const watcher = await connectTo(defer, host);
    const id = await startChat(watcher, "run it");
    await waitForView(
      watcher.view,
      (view) =>
        view.organized.chats.some((node) => node.summary.id === id && node.summary.status === undefined),
    );
    // Both tokens' Finished items queue a title-wait timer.
    await waitUntil(() => timers.pending >= 2).catch(async () => {
      console.log("DBG dedupe: pending", timers.pending, "regs", JSON.stringify(await registrations(host)), "calls", expo.calls.length);
      throw new Error("no title timers");
    });
    timers.advance(15_000);
    await expo.waitForCalls(2);
    const recipients = () => expo.calls.map((call) => (call.body as { to: string }).to);
    expect(recipients().sort()).toEqual([TOKEN_A, TOKEN_B]);

    // TOKEN_A retries on a backoff while TOKEN_B is already done. Each advance
    // waits for the retry timer — it is queued asynchronously after the 500.
    // (The other pending timer is TOKEN_B's receipt check.)
    await waitUntil(() => timers.pending >= 2);
    timers.advance(5_000);
    await expo.waitForCalls(3);
    await waitUntil(() => timers.pending >= 2);
    timers.advance(10_000);
    await expo.waitForCalls(4);
    await waitUntil(() => timers.pending >= 2);
    timers.advance(20_000);
    await expo.waitForCalls(5);
    expect(recipients().filter((to) => to === TOKEN_A)).toHaveLength(4);
    expect(recipients().filter((to) => to === TOKEN_B)).toHaveLength(1);
  });

  it("drops a retry when the conversation's state has moved on", async () => {
    const expo = fakeExpo((request) =>
      request.body["body"] === "Waiting for your answer"
        ? { status: 503, body: { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "down" }] } }
        : { body: { data: { status: "ok", id: "ticket-done" } } },
    );
    const timers = new ManualTimers();
    const { host } = await pushHost({ expo, timers, extensions: [question], answers: [QUESTION_STEP, "done"] });
    const { client } = await pairDevice(host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await expo.waitForCalls(1);
    expect(expo.calls[0]!.body).toMatchObject({ body: "Waiting for your answer" });
    await waitUntil(() => timers.pending === 1); // the retry timer is queued

    // The user answers from another client before the retry fires.
    await answerQuestion(watcher, "Yes");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.length > 0 && view.organized.chats[0]!.summary.status === undefined,
    );
    // The stale retry timer and the fresh Finished title wait are both queued.
    await waitUntil(() => timers.pending >= 2);
    timers.advance(60_000);
    // The stale Waiting retry never went out; the fresh Finished did.
    await waitUntil(() => expo.calls.length >= 2);
    expect(expo.calls.map((call) => (call.body as { body: string }).body)).toEqual(["Waiting for your answer", "Finished"]);
  });

  it("stops retrying a token whose device was revoked", async () => {
    const expo = fakeExpo(() => ({ status: 503, body: { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "down" }] } }));
    const timers = new ManualTimers();
    const { host } = await pushHost({ expo, timers, extensions: [question], answers: [QUESTION_STEP] });
    const { client, device } = await pairDevice(host, "phone");
    const key = toBase64Url(device.publicKey);
    const tokenClient = await connectTo(defer, host);
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await expo.waitForCalls(1);
    await waitUntil(() => timers.pending === 1);

    await tokenClient.controller.revokeDevice(key);
    await waitUntil(async () => (await registrations(host)).length === 0);
    timers.advance(60_000);
    await settle(100);
    expect(expo.calls).toHaveLength(1);
  });

  it("forgets a token on DeviceNotRegistered — ticket at once, receipt only if unchanged", async () => {
    const TOKEN_C = "ExponentPushToken[cccccccccccccccccccccc]";
    const expo = fakeExpo((request) => {
      if (request.url === RECEIPTS_URL) {
        const ids = request.body["ids"] as string[];
        return { body: { data: { [ids[0]!]: { status: "error", details: { error: "DeviceNotRegistered" } } } } };
      }
      if (request.body["to"] === TOKEN_A) {
        return { body: { data: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } } };
      }
      return { body: { data: { status: "ok", id: `ticket-${request.body["to"]}` } } };
    });
    const timers = new ManualTimers();
    const { host } = await pushHost({ expo, timers, extensions: [question], answers: [questionStep(), questionStep(), questionStep()] });
    const { client } = await pairDevice(host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "first question");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer", 5000).catch(async () => {
      console.log("DBG dnr: chats", JSON.stringify(watcher.view.current().organized.chats.map((n) => [n.summary.id, n.summary.status])), "calls", JSON.stringify(expo.calls.map((c) => c.body)), "regs", JSON.stringify(await registrations(host)));
      throw new Error("never needs-answer");
    });
    await waitUntil(async () => (await registrations(host)).length === 0);

    // Re-registering with a new token must survive the OLD token's receipt:
    // the delete is conditional on the registry still holding that token.
    await client.controller.setPushToken(TOKEN_B);
    await answerQuestion(watcher, "Yes");
    await waitUntil(() => expo.calls.some((call) => call.body["to"] === TOKEN_B));

    await client.controller.setPushToken(TOKEN_C);
    // The send's receipt check is queued on a timer registered after the ticket.
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15 * 60 * 1000);
    await waitUntil(() => expo.calls.some((call) => call.url === RECEIPTS_URL));
    await waitUntil(async () => (await registrations(host)).length === 1);
    expect((await registrations(host)).map((entry) => entry.token)).toEqual([TOKEN_C]);

    // When the registry still holds the receipt's token, it is deleted.
    await answerQuestion(watcher, "No");
    await waitUntil(() => expo.calls.some((call) => call.body["to"] === TOKEN_C));
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15 * 60 * 1000);
    await waitUntil(async () => (await registrations(host)).length === 0);
  });
});
