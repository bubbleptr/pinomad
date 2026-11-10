// ADR-0046 rests on pi-durable behaviors (§2, §4). These tests pin them so an
// upgrade that changes one fails here instead of in the subagent tools.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type JsonObject, LiveDoc } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { question } from "../src/extensions/question.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const delegates = (args: JsonObject) => fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });

describe("pi-durable behaviors ADR-0046 relies on", () => {
  it("runs a foreground child again after its call ended; the parent stays idle but its Stop still reaches the child", async () => {
    const host = await startFauxHost(defer, {
      extensions: (provided: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
        question,
        createSubagent({ models: provided.models, modelSummaries: provided.modelSummaries, exclude: [question.extension] }),
      ],
      answers: [delegates({ task: "first", checkout: "shared" }), "child first", "parent final", LONG_ANSWER],
      tokensPerSecond: 20,
    });
    const client = await connectTo(defer, host);
    const parentId = await startChat(client, "delegate");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "parent final");
    const childId = client.view.current().organized.chats.flatMap((node) => node.children)[0]!.summary.id;

    const child = (await host.harness.conversation(childId, context))!;
    const submission = await child.submit({ type: "input", content: "second" }, context);
    await expect.poll(async () => (await host.harness.snapshot(LiveDoc, childId, context))?.run !== undefined).toBe(true);
    expect((await host.harness.snapshot(LiveDoc, parentId, context))?.run).toBeUndefined();
    // The child still sits in the parent's ordinary scope (its owner task is
    // terminal, not a background boundary): the parent's abort stops it.
    await (await host.harness.conversation(parentId, context))!.abort(context);
    expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
  });

  it("appends a write with model content to an idle conversation without starting a run", async () => {
    const host = await startFauxHost(defer, { answers: ["first", "second"] });
    const client = await connectTo(defer, host);
    const id = await startChat(client, "hello");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "first");
    const conversation = (await host.harness.conversation(id, context))!;

    const write = await conversation.submit(
      {
        type: "write",
        entry: { kind: "pi.user", model: [{ role: "user", content: "the user talked to reviewer", timestamp: Date.now() }] },
      },
      context,
    );
    // Give a run the chance to start; it must not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await host.harness.snapshot(LiveDoc, id, context))?.run).toBeUndefined();
    expect((await write.status(context)).status).toBe("done");

    // The next run's context carries it, before the new input.
    await (await conversation.submit({ type: "input", content: "next" }, context)).wait(context);
    const texts = transcript((await conversation.watch(context)).value).map((each) => each.text);
    expect(texts.slice(-3)).toEqual(["the user talked to reviewer", "next", "second"]);
  });
});
