import { once } from "node:events";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { ApprovalState, TodoState } from "@pinomad/protocol/presentation.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { approval } from "../src/extensions/approval.ts";
import { todo } from "../src/extensions/todo.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, freePort, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

let nextCall = 1;

/** A raw client that can observe call results, which `controller.decide` deliberately hides. */
async function socketTo(host: OpenedHost) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

function call<M extends keyof CallMethods>(
  client: { socket: WebSocket; frames: ServerFrame[] },
  method: M,
  args: CallMethods[M]["args"],
): Promise<Extract<ServerFrame, { type: "result" }>> {
  const id = nextCall++;
  client.socket.send(JSON.stringify({ type: "call", id, method, args }));
  return (async () => {
    for (;;) {
      const found = client.frames.find((frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result" && frame.id === id);
      if (found !== undefined) return found;
      await once(client.socket, "message");
    }
  })();
}

const decide = (
  client: { socket: WebSocket; frames: ServerFrame[] },
  conversationId: ConversationId,
  requestId: string,
  approved: boolean,
  kind = "approval.requests",
) => call(client, "decide", { conversationId, kind, requestId, approved });

const docValue = <T>(view: DurableView, kind: string): T | null | undefined =>
  view.docs.find((doc) => doc.kind === kind)?.value as T | null | undefined;

const requestsOf = (view: DurableView): ApprovalState["requests"] => docValue<ApprovalState>(view, "approval.requests")?.requests ?? [];

describe("presentation types", () => {
  it("presents a todo_write call as a pinomad.todo document", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, approval],
      answers: [
        fauxAssistantMessage(
          fauxToolCall("todo_write", {
            items: [
              { text: "Investigate the report", status: "in_progress" },
              { text: "Ship the fix", status: "pending" },
            ],
          }),
          { stopReason: "toolUse" },
        ),
        "planned",
      ],
    });
    const client = await connectTo(defer, host);

    await startChat(client, "plan it");
    await waitForView(client.view, (view) => (docValue<TodoState>(view, "todo.list")?.items.length ?? 0) === 2);
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "planned");

    const doc = client.view.current().docs.find((each) => each.kind === "todo.list");
    expect(doc).toMatchObject({ kind: "todo.list", presentation: "pinomad.todo" });
    expect(docValue<TodoState>(client.view.current(), "todo.list")?.items).toEqual([
      { text: "Investigate the report", status: "in_progress" },
      { text: "Ship the fix", status: "pending" },
    ]);
  });

  it("lets the first of two concurrent deciders win; both views converge and the turn continues", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, approval],
      answers: [
        fauxAssistantMessage(fauxToolCall("request_approval", { title: "Deploy v2.3?" }), { stopReason: "toolUse" }),
        "continuing after the decision",
      ],
    });
    const a = await connectTo(defer, host);
    const b = await connectTo(defer, host);

    const conversationId = await startChat(a, "deploy");
    await b.controller.switchConversation(conversationId);
    await waitForView(a.view, (view) => requestsOf(view).some((request) => request.decision === undefined));
    await waitForView(b.view, (view) => requestsOf(view).some((request) => request.decision === undefined));
    const requestId = requestsOf(a.view.current()).find((request) => request.decision === undefined)!.id;
    expect(requestId).not.toBe("");

    const sa = await socketTo(host);
    const sb = await socketTo(host);
    const [first, second] = await Promise.all([
      decide(sa, conversationId, requestId, true),
      decide(sb, conversationId, requestId, false),
    ]);
    expect(first.ok && second.ok).toBe(true);
    const outcomes = [first, second].map((frame) => (frame as { value: { outcome: string; first: boolean } }).value);
    expect(outcomes.filter((outcome) => outcome.first)).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe(outcomes[1]!.outcome);

    const standing = outcomes[0]!.outcome;
    for (const client of [a, b]) {
      await waitForView(client.view, (view) => requestsOf(view).find((request) => request.id === requestId)?.decision?.outcome === standing);
    }
    await waitForView(a.view, (view) => transcript(view.conversation!).at(-1)?.text === "continuing after the decision");
    // The tool result tells the model what was decided.
    const resultEntry = a.view.current().conversation!.entries.find((entry) => entry.kind === "pi.tool-result");
    expect(JSON.stringify(resultEntry?.model)).toContain(`Approval ${standing}.`);
  });

  it("cancels a pending request when the turn is aborted", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, approval],
      answers: [
        fauxAssistantMessage(fauxToolCall("request_approval", { title: "Deploy v2.3?" }), { stopReason: "toolUse" }),
        "should not be reached",
      ],
    });
    const client = await connectTo(defer, host);

    const conversationId = await startChat(client, "deploy");
    await waitForView(client.view, (view) => requestsOf(view).some((request) => request.decision === undefined));
    const requestId = requestsOf(client.view.current()).find((request) => request.decision === undefined)!.id;

    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    expect(requestsOf(client.view.current()).find((request) => request.id === requestId)?.decision?.outcome).toBe("cancelled");
    const later = await decide(await socketTo(host), conversationId, requestId, true);
    expect(later).toMatchObject({ ok: true, value: { outcome: "cancelled", first: false } });
  });

  it("keeps the pending request across a host restart; a later decide completes the tool and the turn", async () => {
    const port = await freePort();
    const first = await startFauxHost(defer, {
      extensions: [todo, approval],
      port,
      answers: [fauxAssistantMessage(fauxToolCall("request_approval", { title: "Deploy v2.3?" }), { stopReason: "toolUse" })],
    });
    const client = await connectTo(defer, first);
    const conversationId = await startChat(client, "deploy");
    await waitForView(client.view, (view) => requestsOf(view).some((request) => request.decision === undefined));
    const dataDir = client.view.current().session.directory;
    await first.close();
    await waitForView(client.view, (view) => view.connection === "reconnecting");

    // The next model request gets this answer; the stored tool call reruns without one.
    const second = await startFauxHost(defer, {
      extensions: [todo, approval],
      port,
      dataDir,
      answers: ["done"],
    });
    expect(second.token).toBe(first.token);
    await waitForView(client.view, (view) => view.connection === "connected");
    await waitForView(client.view, (view) => {
      const requests = requestsOf(view);
      return requests.length === 1 && requests[0]!.decision === undefined;
    });
    const requestId = requestsOf(client.view.current())[0]!.id;

    const decided = await decide(await socketTo(second), conversationId, requestId, true);
    expect(decided).toMatchObject({ ok: true, value: { outcome: "approved", first: true } });
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");
  });

  it("still cancels a pending request when the turn is aborted after a host restart", async () => {
    const port = await freePort();
    const first = await startFauxHost(defer, {
      extensions: [todo, approval],
      port,
      answers: [fauxAssistantMessage(fauxToolCall("request_approval", { title: "Deploy v2.3?" }), { stopReason: "toolUse" })],
    });
    const client = await connectTo(defer, first);
    await startChat(client, "deploy");
    await waitForView(client.view, (view) => requestsOf(view).some((request) => request.decision === undefined));
    const dataDir = client.view.current().session.directory;
    await first.close();
    await waitForView(client.view, (view) => view.connection === "reconnecting");

    await startFauxHost(defer, { extensions: [todo, approval], port, dataDir, answers: ["done"] });
    await waitForView(client.view, (view) => view.connection === "connected");
    await waitForView(client.view, (view) => {
      const requests = requestsOf(view);
      return requests.length === 1 && requests[0]!.decision === undefined;
    });
    const requestId = requestsOf(client.view.current())[0]!.id;

    // The replayed wait task aborts the same way; the cancel write still lands.
    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    expect(requestsOf(client.view.current()).find((request) => request.id === requestId)?.decision?.outcome).toBe("cancelled");
  });

  it("rejects decide calls for unknown kinds, non-approval docs, and unknown requests", async () => {
    const host = await startFauxHost(defer, { extensions: [todo, approval] });
    const owner = await connectTo(defer, host);
    const conversationId = await startChat(owner, "deploy");
    const client = await socketTo(host);

    expect(await decide(client, conversationId, "x", true, "no.such.kind")).toMatchObject({ ok: false });
    expect(await decide(client, conversationId, "x", true, "todo.list")).toMatchObject({ ok: false });
    expect(await decide(client, conversationId, "missing-request", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing-request"),
    });

    // Failures are per-call; the connection stays usable.
    expect(await call(client, "abort", { conversationId })).toMatchObject({ ok: true, value: null });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});
