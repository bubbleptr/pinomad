// Push notifications: APNs token registration over the secure channel and the
// outbound sender, which asks the server over the control connection
// (ADR-0025). The transport and timers are fakes — nothing ever leaves the
// test process, and retries/waits run on a manual clock.
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { PushNotification, PushVerdict } from "@pinomad/protocol/relay.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DevicesDoc } from "../src/devices.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import type { HostValue } from "../src/host-value.ts";
import { IndexDoc } from "../src/organization.ts";
import { attachPushSender, PushDoc, pushTokenProblem, type PushTransport } from "../src/push.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { writeServerConfig } from "../src/server-config.ts";
import {
  connectTo,
  ManualTimers,
  pairDevice,
  startChat,
  startFauxHost,
  tempDir,
  useCleanups,
  waitForView,
} from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const TOKEN_A = { apns: "aa".repeat(32), environment: "production" as const };
const TOKEN_B = { apns: "bb".repeat(32), environment: "production" as const };
const TOKEN_DEV = { apns: "dd".repeat(32), environment: "development" as const };

interface RecordedSend {
  readonly token: string;
  readonly environment: string;
  readonly notification: PushNotification;
}

/**
 * The control-connection double: records every push request and answers
 * `accepted` (or what `responder` says). `waitForCalls` is a barrier, not a
 * sleep.
 */
function fakeTransport(responder?: (request: RecordedSend) => PushVerdict | Promise<PushVerdict>): {
  calls: RecordedSend[];
  transport: PushTransport;
  waitForCalls(n: number): Promise<void>;
} {
  const calls: RecordedSend[] = [];
  const waiters: { n: number; resolve(): void }[] = [];
  const transport: PushTransport = {
    send: async (request) => {
      calls.push(request);
      for (const waiter of [...waiters]) {
        if (calls.length >= waiter.n) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      return (await responder?.(request)) ?? { result: "accepted", reason: "ok" };
    },
  };
  const waitForCalls = (n: number): Promise<void> =>
    new Promise((resolve) => {
      if (calls.length >= n) resolve();
      else waiters.push({ n, resolve });
    });
  return { calls, transport, waitForCalls };
}

/** Resolve once `predicate` holds; polled — the test is gated on the condition, not on a duration. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A short settle window for assertions that must stay empty (no send, no write). */
const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * A host whose push registrations are allowed: `server.json` marks it joined
 * (setPushToken refuses otherwise). The remote listener pairs test devices.
 */
async function joinedDir(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  await writeServerConfig(dir.path, { origin: "https://relay.example.com" });
  return dir.path;
}

async function pushHost(
  options: Omit<FauxOptions, "push" | "remote" | "dataDir"> & {
    apns: ReturnType<typeof fakeTransport>;
    timers?: ManualTimers;
    dataDir?: string;
  },
): Promise<{ host: OpenedHost; apns: ReturnType<typeof fakeTransport>; timers: ManualTimers; dataDir: string }> {
  const { apns, timers = new ManualTimers(), dataDir, ...rest } = options;
  const dir = dataDir ?? (await joinedDir());
  const host = await startFauxHost(defer, {
    ...rest,
    dataDir: dir,
    remote: { port: 0 },
    push: { transport: apns.transport, timers },
  });
  return { host, apns, timers, dataDir: dir };
}

describe("push token registration", () => {
  it("registers, replaces, and clears a device's APNs token; the devices stream never carries it", async () => {
    const host = await startFauxHost(defer, { dataDir: await joinedDir(), remote: { port: 0 } });
    const { client, device } = await pairDevice(defer, host, "phone");
    const key = toBase64Url(device.publicKey);
    const tokenClient = await connectTo(defer, host);
    await waitForView(tokenClient.view, (view) => view.devices.some((entry) => entry.publicKey === key));

    await client.controller.setPushToken(TOKEN_A);
    expect(await registrations(host)).toEqual([
      { publicKey: key, token: TOKEN_A.apns, environment: "production", updatedAt: expect.any(Number) },
    ]);
    // A token is a send capability: it must not ride the devices stream.
    const entry = tokenClient.view.current().devices.find((each) => each.publicKey === key);
    expect(Object.keys(entry ?? {}).sort()).toEqual(["name", "pairedAt", "publicKey", "source"]);

    await client.controller.setPushToken(TOKEN_DEV);
    expect(await registrations(host)).toEqual([
      { publicKey: key, token: TOKEN_DEV.apns, environment: "development", updatedAt: expect.any(Number) },
    ]);

    await client.controller.setPushToken(null);
    expect(await registrations(host)).toEqual([]);
  });

  it("refuses a legacy Expo token without a 4400, and explains the environment", async () => {
    const host = await startFauxHost(defer, { dataDir: await joinedDir(), remote: { port: 0 } });
    const { client } = await pairDevice(defer, host, "phone");
    await expect(client.controller.setPushToken("ExponentPushToken[abc]")).rejects.toThrow(/no longer go through Expo/);
    await expect(client.controller.setPushToken("anything-string")).rejects.toThrow(/no longer go through Expo/);
    // The refusal was a call error, not a disconnect: the client still works.
    expect(client.view.current().connection).toBe("connected");
    expect(await registrations(host)).toEqual([]);
  });

  it("rejects token clients, bad token shapes, and unpaired devices", async () => {
    const host = await startFauxHost(defer, { dataDir: await joinedDir(), remote: { port: 0 } });
    const tokenClient = await connectTo(defer, host);
    await expect(tokenClient.controller.setPushToken(TOKEN_A)).rejects.toThrow(/secure channel/);

    const { client, device } = await pairDevice(defer, host, "phone");
    await expect(client.controller.setPushToken({ apns: "not-hex", environment: "production" })).rejects.toThrow(
      /APNs device token/,
    );
    await expect(
      client.controller.setPushToken({ apns: "ab".repeat(200), environment: "production" }),
    ).rejects.toThrow(/too long/);
    expect(pushTokenProblem({ apns: "CC".repeat(32), environment: "development" })).toBeUndefined();

    // A device dropped from the table while still connected registers nothing.
    const key = toBase64Url(device.publicKey);
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(DevicesDoc);
      doc.devices = doc.devices.filter((entry) => entry.publicKey !== key);
    }, context);
    await expect(client.controller.setPushToken(TOKEN_A)).rejects.toThrow(/not paired/);
    expect(await registrations(host)).toEqual([]);
  });

  it("refuses APNs registration while the host is not joined to an account", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
    const { client } = await pairDevice(defer, host, "phone");
    await expect(client.controller.setPushToken(TOKEN_A)).rejects.toThrow(/joined to an account/);
    // Deregistration needs no account — it's local cleanup.
    await client.controller.setPushToken(null);
    expect(await registrations(host)).toEqual([]);
  });

  it("closes the connection on malformed call args (4400)", async () => {
    const host = await startFauxHost(defer);
    const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => socket.terminate());
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "call", id: 1, method: "setPushToken", args: { token: { apns: 5 } } }));
    expect((await closed)[0]).toBe(4400);
  });

  it("deletes the device's token in the same commit as revocation", async () => {
    const host = await startFauxHost(defer, { dataDir: await joinedDir(), remote: { port: 0 } });
    const { client, device } = await pairDevice(defer, host, "phone");
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

    // Restart joined with the sender attached: the standing needs-answer seeds
    // the baseline silently.
    await writeServerConfig(dir.path, { origin: "https://relay.example.com" });
    const apns = fakeTransport();
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, dataDir: dir.path, extensions: [question], answers: ["done"] });
    const { client } = await pairDevice(defer, host, "phone");
    const watcher = await connectTo(defer, host);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await watcher.controller.switchConversation(id); // docs load for the shown conversation only

    await client.controller.setPushToken(TOKEN_A);
    await settle();
    expect(apns.calls).toHaveLength(0);

    // A genuine transition does notify: answer → the run resumes and finishes.
    await answerQuestion(watcher, "Yes");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.length > 0 && view.organized.chats[0]!.summary.status === undefined,
    );
    // The Finished item's title-wait timer must be queued before advancing.
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15_000);
    await apns.waitForCalls(1);
    expect(apns.calls[0]!.notification.body).toBe("Finished");
  });

  it("pushes waiting and failure events immediately with the fixed title, never the first message", async () => {
    const apns = fakeTransport();
    const timers = new ManualTimers();
    const { host } = await pushHost({
      apns,
      timers,
      extensions: [question],
      answers: [QUESTION_STEP, fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "provider blew up" })],
    });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    const firstMessage = "deploy the thing now please";
    const id = await startChat(watcher, firstMessage);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");

    // No title yet and "Waiting" does not wait for one.
    await apns.waitForCalls(1);
    const waiting = apns.calls[0]!;
    const hostKey = toBase64Url(host.remote!.hostKey);
    expect(waiting).toMatchObject({
      token: TOKEN_A.apns,
      environment: "production",
      notification: {
        title: "PiNomad conversation",
        body: "Waiting for your answer",
        hostKey,
        conversationId: id,
      },
    });
    expect(waiting.notification.title).not.toContain("deploy");
    // The collapse id is the fixed-length digest — `hostKey:id` can exceed
    // APNs' 64-byte apns-collapse-id limit (ADR-0025 §2).
    expect(waiting.notification.collapseId).toMatch(/^[0-9a-f]{32}$/);

    // A failing run pushes "Failed" the same way — immediately, no title wait.
    await answerQuestion(watcher, "Yes");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "failed");
    await apns.waitForCalls(2);
    expect(apns.calls[1]!.notification).toMatchObject({ body: "Failed", title: "PiNomad conversation" });
  });

  it("waits for the auto-title on Finished, falls back after the title wait elapses", async () => {
    const apns = fakeTransport();
    const timers = new ManualTimers();
    const { host } = await pushHost({
      apns,
      timers,
      autoTitle: true,
      answers: [
        "all done",
        "Fix the crash loop", // the auto-title model call
        "silent run",
        fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "title model down" }),
      ],
    });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "the app keeps crashing");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === undefined);

    // The notification holds for the pinomad.title write, then carries it.
    await waitUntil(() => timers.pending > 0);
    expect(apns.calls).toHaveLength(0);
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.title === "Fix the crash loop");
    await apns.waitForCalls(1);
    expect(apns.calls[0]!.notification).toMatchObject({ title: "Fix the crash loop", body: "Finished" });

    // A run whose title never lands sends the fixed title once the wait elapses.
    const id2 = await startChat(watcher, "and again, silently");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.some((node) => node.summary.id === id2 && node.summary.status === undefined),
    );
    await waitUntil(() => timers.pending >= 1);
    expect(apns.calls).toHaveLength(1);
    timers.advance(15_000);
    await apns.waitForCalls(2);
    expect(apns.calls[1]!.notification).toMatchObject({
      title: "PiNomad conversation",
      body: "Finished",
      conversationId: id2,
    });
  });

  it("sends one request per distinct token and isolates a failing token from the rest", async () => {
    const apns = fakeTransport((request) =>
      request.token === TOKEN_A.apns
        ? { result: "retry", reason: "down" }
        : { result: "accepted", reason: "ok" },
    );
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, answers: ["done"] });
    const a = await pairDevice(defer, host, "phone-a");
    const b = await pairDevice(defer, host, "phone-b");
    const c = await pairDevice(defer, host, "phone-c");
    await a.client.controller.setPushToken(TOKEN_A);
    await b.client.controller.setPushToken(TOKEN_B);
    // A reinstall can register the same token twice — it sends once.
    await c.client.controller.setPushToken(TOKEN_B);
    expect(await registrations(host)).toHaveLength(3);

    const watcher = await connectTo(defer, host);
    const id = await startChat(watcher, "run it");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.some((node) => node.summary.id === id && node.summary.status === undefined),
    );
    // Both tokens' Finished items queue a title-wait timer.
    await waitUntil(() => timers.pending >= 2);
    timers.advance(15_000);
    await apns.waitForCalls(2);
    const recipients = () => apns.calls.map((call) => call.token);
    expect(recipients().sort()).toEqual([TOKEN_A.apns, TOKEN_B.apns]);

    // TOKEN_A retries on a backoff while TOKEN_B is already done. Each advance
    // waits for the retry timer — it is queued asynchronously after the verdict.
    await waitUntil(() => timers.pending >= 1);
    timers.advance(5_000);
    await apns.waitForCalls(3);
    await waitUntil(() => timers.pending >= 1);
    timers.advance(10_000);
    await apns.waitForCalls(4);
    await waitUntil(() => timers.pending >= 1);
    timers.advance(20_000);
    await apns.waitForCalls(5);
    expect(recipients().filter((to) => to === TOKEN_A.apns)).toHaveLength(4);
    expect(recipients().filter((to) => to === TOKEN_B.apns)).toHaveLength(1);
  });

  it("honors a server-directed retry delay and drops what stays undeliverable", async () => {
    const apns = fakeTransport(() => ({ result: "retry", reason: "busy", retryAfterMs: 15 * 60 * 1000 }));
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, extensions: [question], answers: [QUESTION_STEP] });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(1);
    await waitUntil(() => timers.pending === 1);

    // The 15-minute verdict delay wins over the local 5 s backoff.
    timers.advance(60_000);
    await settle(100);
    expect(apns.calls).toHaveLength(1);
    timers.advance(15 * 60 * 1000);
    await apns.waitForCalls(2);

    // Four attempts total, then it gives up.
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15 * 60 * 1000);
    await apns.waitForCalls(3);
    await waitUntil(() => timers.pending >= 1);
    timers.advance(15 * 60 * 1000);
    await apns.waitForCalls(4);
    timers.advance(15 * 60 * 1000);
    await settle(100);
    expect(apns.calls).toHaveLength(4);
  });

  it("drops an unavailable send without retrying", async () => {
    const apns = fakeTransport(() => ({ result: "unavailable", reason: "environment not declared" }));
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, extensions: [question], answers: [QUESTION_STEP] });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(1);
    await waitUntil(() => timers.pending === 0);
    timers.advance(60_000);
    await settle(100);
    expect(apns.calls).toHaveLength(1);
    // A rejection is a dead end for the notification, not for the registration.
    expect(await registrations(host)).toHaveLength(1);
  });

  it("dedupes per (environment, token) — the same token under another environment is another registration", async () => {
    const apns = fakeTransport();
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, answers: ["done"] });
    const dev = await pairDevice(defer, host, "dev");
    const prod = await pairDevice(defer, host, "prod");
    const dup = await pairDevice(defer, host, "dup");
    // The same hex under two environments are distinct APNs registrations —
    // a reinstall under the same pair still sends once.
    await dev.client.controller.setPushToken({ apns: TOKEN_B.apns, environment: "development" });
    await prod.client.controller.setPushToken(TOKEN_B);
    await dup.client.controller.setPushToken(TOKEN_B);
    const watcher = await connectTo(defer, host);
    const id = await startChat(watcher, "run it");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.some((node) => node.summary.id === id && node.summary.status === undefined),
    );
    await waitUntil(() => timers.pending >= 2);
    timers.advance(15_000);
    await apns.waitForCalls(2);
    await settle(100);
    // development + production each get one request; the duplicate production
    // registration did not fan out a third.
    expect(apns.calls.map((call) => call.environment).sort()).toEqual(["development", "production"]);
    expect(apns.calls).toHaveLength(2);
  });

  it("deletes a stale registration on unregistered, but never a fresh one or on rejected", async () => {
    const apns = fakeTransport((request) => {
      if (request.token === TOKEN_A.apns) {
        return { result: "unregistered", reason: "Unregistered", unregisteredAt: Date.now() + 60_000 };
      }
      if (request.token === TOKEN_B.apns) {
        return { result: "unregistered", reason: "Unregistered", unregisteredAt: Date.now() - 60_000 };
      }
      return { result: "rejected", reason: "BadDeviceToken" };
    });
    const timers = new ManualTimers();
    const { host } = await pushHost({
      apns,
      timers,
      extensions: [question],
      answers: [questionStep(), questionStep(), questionStep()],
    });
    const a = await pairDevice(defer, host, "phone-a");
    const b = await pairDevice(defer, host, "phone-b");
    const c = await pairDevice(defer, host, "phone-c");
    await a.client.controller.setPushToken(TOKEN_A);
    await b.client.controller.setPushToken(TOKEN_B);
    await c.client.controller.setPushToken(TOKEN_DEV);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "first question");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");

    // TOKEN_A's invalidation time postdates its registration → deleted.
    await waitUntil(async () => !(await registrations(host)).some((entry) => entry.token === TOKEN_A.apns));
    // TOKEN_B's predates its (re)registration → kept; rejected → kept too.
    const kept = (await registrations(host)).map((entry) => entry.token).sort();
    expect(kept).toEqual([TOKEN_B.apns, TOKEN_DEV.apns].sort());
  });

  it("drops a retry when the conversation's state has moved on", async () => {
    const apns = fakeTransport((request) =>
      request.notification.body === "Waiting for your answer"
        ? { result: "retry", reason: "down" }
        : { result: "accepted", reason: "ok" },
    );
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, extensions: [question], answers: [QUESTION_STEP, "done"] });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(1);
    expect(apns.calls[0]!.notification.body).toBe("Waiting for your answer");
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
    await waitUntil(() => apns.calls.length >= 2);
    expect(apns.calls.map((call) => call.notification.body)).toEqual(["Waiting for your answer", "Finished"]);
  });

  it("supersedes a notification still waiting for a title when the conversation moves on", async () => {
    const apns = fakeTransport();
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, answers: ["first done", "second done"] });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    const id = await startChat(watcher, "first run");
    await waitForView(
      watcher.view,
      (view) => view.organized.chats.some((node) => node.summary.id === id && node.summary.status === undefined),
    );
    await waitUntil(() => timers.pending === 1); // Finished #1 waits on the title

    // A second run finishes before Finished #1's title wait elapses.
    await watcher.controller.submit("again", "followUp", { target: id });
    await waitForView(
      watcher.view,
      (view) =>
        view.conversation !== undefined
        && transcript(view.conversation).at(-1)?.text === "second done"
        && view.organized.chats[0]?.summary.status === undefined,
    );
    await waitUntil(() => timers.pending >= 2);
    timers.advance(15_000);
    await apns.waitForCalls(1);
    await settle(100);
    // Only the latest transition's notification is delivered.
    expect(apns.calls).toHaveLength(1);
    expect(apns.calls[0]!.notification.body).toBe("Finished");
  });

  it("stops retrying a token whose device was revoked", async () => {
    const apns = fakeTransport(() => ({ result: "retry", reason: "down" }));
    const timers = new ManualTimers();
    const { host } = await pushHost({ apns, timers, extensions: [question], answers: [QUESTION_STEP] });
    const { client, device } = await pairDevice(defer, host, "phone");
    const key = toBase64Url(device.publicKey);
    const tokenClient = await connectTo(defer, host);
    await client.controller.setPushToken(TOKEN_A);
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(1);
    await waitUntil(() => timers.pending === 1);

    await tokenClient.controller.revokeDevice(key);
    await waitUntil(async () => (await registrations(host)).length === 0);
    timers.advance(60_000);
    await settle(100);
    expect(apns.calls).toHaveLength(1);
  });
});

/** A mutable HostValue for driving the sender's summaries input directly. */
function mutableValue<T>(initial: T): HostValue<T> & { set(value: T): void } {
  const listeners = new Set<(value: T) => void>();
  const source = {
    value: initial,
    set(next: T): void {
      source.value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return source;
}

describe("push sender outbox", () => {
  it("keeps the bound tight: an item evicted while queued leaves the ready queue too", async () => {
    const host = await startFauxHost(defer);
    // Index entries + registrations committed directly — this test drives the
    // sender, not the secure channel, so it doesn't need paired devices.
    const cid = (n: number) => n as ConversationId;
    await host.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDoc);
      index.conversations.push({ id: cid(1), home: { kind: "chat" }, createdAt: 1 });
      index.conversations.push({ id: cid(2), home: { kind: "chat" }, createdAt: 2 });
      const push = await tx.doc(PushDoc);
      push.registrations = ["aa", "bb", "cc", "dd"].map((hex, i) => ({
        publicKey: `key-${i}`,
        token: hex.repeat(32),
        environment: "production",
        updatedAt: 1,
      }));
    }, context);
    const summaries = mutableValue<readonly ConversationSummary[]>([]);
    const sent: string[] = [];
    const transport: PushTransport = {
      send: (request) => {
        sent.push(request.token);
        return new Promise(() => {}); // holds: the in-flight slot never frees
      },
    };
    const sender = await attachPushSender({
      harness: host.harness,
      conversations: summaries,
      hostKey: "host",
      transport,
      limits: { maxPending: 4, maxInflight: 1 },
    });
    defer(sender.close);
    await settle(); // let the index watch deliver before statuses move

    // needs-answer on conversation 1: four items — one in-flight, three queued.
    summaries.set([
      { id: cid(1), kind: "conversation", status: "running" },
      { id: cid(2), kind: "conversation", status: "running" },
    ]);
    summaries.set([
      { id: cid(1), kind: "conversation", status: "needs-answer" },
      { id: cid(2), kind: "conversation", status: "running" },
    ]);
    await waitUntil(() => sender.stats().pending === 4);
    expect(sender.stats().queued).toBe(3);

    // needs-answer on conversation 2: four more items evict the whole first
    // batch — three of them were sitting in the ready queue. Dropped items
    // must leave it; otherwise the queue outgrows maxPending and the bound is
    // gone.
    summaries.set([
      { id: cid(1), kind: "conversation", status: "needs-answer" },
      { id: cid(2), kind: "conversation", status: "needs-answer" },
    ]);
    await waitUntil(() => sender.stats().queued === 4);
    expect(sender.stats().pending).toBe(4);
    expect(sent).toHaveLength(1); // only the held send ever left
  });
});
