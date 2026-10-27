// Answer timing (issue #395): the host stamps the first answer token on each
// assistant message, and the wrapper keeps provider streams intact.
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { withAnswerTiming } from "../src/answer-timing.ts";
import { openHost } from "../src/host.ts";
import { connectTo, startChat, tempDir, useCleanups, waitForView } from "./support.ts";

type StampedMessage = AssistantMessage & { pinomad?: { answerStartedAt?: number } };

const REQUEST_AT = 1_000;

const message = (content: AssistantMessage["content"], timestamp = REQUEST_AT): AssistantMessage =>
  fauxAssistantMessage(content, { timestamp });

const stampedAt = (value: AssistantMessage): number | undefined => (value as StampedMessage).pinomad?.answerStartedAt;

const eventMessage = (event: AssistantMessageEvent): AssistantMessage =>
  event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;

/** A Models collection whose streamSimple is scripted; every other method is the real one. */
function scriptedModels(stream: (context: Context) => AssistantMessageEventStream): {
  models: Models;
  model: Model<string>;
} {
  const faux = fauxProvider();
  const base = createModels();
  base.setProvider(faux.provider);
  const model = faux.getModel();
  const models = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "streamSimple") return (_model: Model<string>, context: Context) => stream(context);
      return Reflect.get(target, property, receiver);
    },
  });
  return { models, model };
}

/** Open a host whose normal responses come from the given scripted stream factory. */
async function startScriptedHost(
  defer: (cleanup: () => Promise<void> | void) => void,
  stream: (context: Context) => AssistantMessageEventStream,
): Promise<Awaited<ReturnType<typeof openHost>>> {
  const dir = await tempDir();
  defer(dir.remove);
  const { models, model } = scriptedModels(stream);
  const modelSummaries = (): ModelSummary[] => [
    {
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      thinkingLevels: getSupportedThinkingLevels(model),
      images: model.input.includes("image"),
    },
  ];
  const host = await openHost({
    dataDir: dir.path,
    agentsHome: join(dir.path, "agents-home"),
    models,
    modelSummaries,
    settingsFallback: {
      defaultModel: () => ({ provider: model.provider, modelId: model.id }),
      defaultThinkingLevel: () => null,
      steeringMode: () => "one-at-a-time",
      followUpMode: () => "one-at-a-time",
    },
    port: 0,
    autoTitle: false,
  });
  defer(() => host.close());
  return host;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withAnswerTiming", () => {
  it("stamps the first non-empty text delta, not text_start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });

    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")]) });
    vi.setSystemTime(2_000);
    source.push({ type: "text_delta", contentIndex: 0, delta: "h", partial: message([fauxText("h")]) });
    vi.setSystemTime(3_000);
    source.push({ type: "text_end", contentIndex: 0, content: "hi", partial: message([fauxText("hi")]) });
    source.push({ type: "done", reason: "stop", message: message([fauxText("hi")]) });

    const seen: AssistantMessageEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(stampedAt(eventMessage(seen[1]!))).toBeUndefined();
    expect(stampedAt(eventMessage(seen[2]!))).toBe(2_000);
    expect(stampedAt(eventMessage(seen[3]!))).toBe(2_000);
    expect(stampedAt(eventMessage(seen[4]!))).toBe(2_000);
    expect(stampedAt(await events.result())).toBe(2_000);
  });

  it("does not stamp a run whose only text block stayed empty before failing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });

    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")]) });
    vi.setSystemTime(2_000);
    source.push({ type: "text_delta", contentIndex: 0, delta: "", partial: message([fauxText("")]) });
    source.push({ type: "text_end", contentIndex: 0, content: "", partial: message([fauxText("")]) });
    vi.setSystemTime(3_000);
    source.push({
      type: "error",
      reason: "error",
      error: message([fauxText("")], REQUEST_AT),
    });

    const seen: AssistantMessageEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(stampedAt(eventMessage(seen[2]!))).toBeUndefined();
    expect(stampedAt(eventMessage(seen[3]!))).toBeUndefined();
    expect(stampedAt(eventMessage(seen[4]!))).toBeUndefined();
    expect(stampedAt(await events.result())).toBeUndefined();
  });

  it("stamps the second text block when the first one is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });

    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")]) });
    vi.setSystemTime(2_000);
    source.push({ type: "text_delta", contentIndex: 0, delta: "", partial: message([fauxText("")]) });
    source.push({ type: "text_end", contentIndex: 0, content: "", partial: message([fauxText("")]) });
    vi.setSystemTime(3_000);
    source.push({ type: "text_start", contentIndex: 1, partial: message([fauxText(""), fauxText("")]) });
    vi.setSystemTime(4_000);
    source.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "x",
      partial: message([fauxText(""), fauxText("x")]),
    });
    source.push({ type: "done", reason: "stop", message: message([fauxText(""), fauxText("x")]) });

    const seen: AssistantMessageEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(stampedAt(eventMessage(seen[3]!))).toBeUndefined();
    expect(stampedAt(eventMessage(seen[5]!))).toBe(4_000);
    expect(stampedAt(await events.result())).toBe(4_000);
  });

  it("stamps at text_end when a provider only delivers the full text there", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });

    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")]) });
    vi.setSystemTime(2_000);
    source.push({ type: "text_end", contentIndex: 0, content: "full", partial: message([fauxText("full")]) });
    source.push({ type: "done", reason: "stop", message: message([fauxText("full")]) });

    const seen: AssistantMessageEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(stampedAt(eventMessage(seen[2]!))).toBe(2_000);
    expect(stampedAt(await events.result())).toBe(2_000);
  });

  it("does not stamp a pure tool-call response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });
    const call = fauxToolCall("read", { path: "a.txt" });

    source.push({ type: "start", partial: message([]) });
    vi.setSystemTime(2_000);
    source.push({ type: "toolcall_start", contentIndex: 0, partial: message([call]) });
    source.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message([call]) });
    source.push({ type: "done", reason: "toolUse", message: message([call]) });

    const seen: AssistantMessageEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(stampedAt(eventMessage(seen[2]!))).toBeUndefined();
    expect(stampedAt(await events.result())).toBeUndefined();
  });

  it("stamps the terminal message when only result() is read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_AT);
    const source = createAssistantMessageEventStream();
    const { models, model } = scriptedModels(() => source);
    const events = withAnswerTiming(models).streamSimple(model, { messages: [] });

    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")]) });
    vi.setSystemTime(2_000);
    source.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: message([fauxText("hi")]) });
    source.push({ type: "done", reason: "stop", message: message([fauxText("hi")]) });

    expect(stampedAt(await events.result())).toBe(2_000);
  });

  it("strips pinomad from historical assistant messages without mutating them", () => {
    const historical = { ...message([fauxText("old")]), pinomad: { answerStartedAt: 1_500 } } as StampedMessage;
    const user = { role: "user" as const, content: "hi", timestamp: 900 };
    const context: Context = { systemPrompt: "system", messages: [historical, user] };
    const captured: Context[] = [];
    const { models, model } = scriptedModels((sent) => {
      captured.push(sent);
      return createAssistantMessageEventStream();
    });

    withAnswerTiming(models).streamSimple(model, context);

    const sent = captured[0]!;
    expect(sent.systemPrompt).toBe("system");
    expect("pinomad" in (sent.messages[0] as object)).toBe(false);
    expect(sent.messages[0]).toEqual(message([fauxText("old")]));
    expect(sent.messages[1]).toBe(user);
    expect(stampedAt(historical)).toBe(1_500);
  });

  it("lets a synchronous provider error through unchanged", () => {
    const failure = new Error("missing auth");
    const { models, model } = scriptedModels(() => {
      throw failure;
    });

    expect(() => withAnswerTiming(models).streamSimple(model, { messages: [] })).toThrow(failure);
  });
});

describe("host answer timing", () => {
  const defer = useCleanups();

  it("persists the first answer delta time and cleans it from later requests", async () => {
    const contexts: Context[] = [];
    const streams: AssistantMessageEventStream[] = [];
    const requestTimes: number[] = [];
    const host = await startScriptedHost(defer, (context) => {
      contexts.push(context);
      requestTimes.push(Date.now());
      const source = createAssistantMessageEventStream();
      streams.push(source);
      return source;
    });
    const client = await connectTo(defer, host);
    await startChat(client, "hi");

    await expect.poll(() => streams.length, { timeout: 5_000 }).toBe(1);
    const requestAt = requestTimes[0]!;
    const first = streams[0]!;
    first.push({ type: "start", partial: message([], requestAt) });
    first.push({ type: "thinking_start", contentIndex: 0, partial: message([fauxThinking("")], requestAt) });
    first.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "plan",
      partial: message([fauxThinking("plan")], requestAt),
    });
    first.push({
      type: "thinking_end",
      contentIndex: 0,
      content: "plan",
      partial: message([fauxThinking("plan")], requestAt),
    });
    first.push({
      type: "text_start",
      contentIndex: 1,
      partial: message([fauxThinking("plan"), fauxText("")], requestAt),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const beforeDelta = Date.now();
    first.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "hello",
      partial: message([fauxThinking("plan"), fauxText("hello")], requestAt),
    });
    const afterDelta = Date.now();
    first.push({
      type: "text_end",
      contentIndex: 1,
      content: "hello",
      partial: message([fauxThinking("plan"), fauxText("hello")], requestAt),
    });
    first.push({
      type: "done",
      reason: "stop",
      message: message([fauxThinking("plan"), fauxText("hello")], requestAt),
    });

    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "hello",
    );
    const stored = client
      .view.current()
      .conversation!.entries.find((entry) => entry.kind === "pi.assistant")!
      .model?.[0] as StampedMessage;
    expect(stored.timestamp).toBe(requestAt);
    expect(stampedAt(stored)).toBeGreaterThanOrEqual(beforeDelta);
    expect(stampedAt(stored)).toBeLessThanOrEqual(afterDelta);
    expect(stampedAt(stored)).toBeGreaterThan(requestAt);

    await client.controller.submit("again", "followUp");
    await expect.poll(() => streams.length, { timeout: 5_000 }).toBe(2);
    const sent = contexts[1]!;
    const sentAssistant = sent.messages.find((entry) => entry.role === "assistant")!;
    expect("pinomad" in (sentAssistant as object)).toBe(false);
    // The stored entry still carries the stamp: the request copy is shallow.
    expect(stampedAt(stored)).toBeGreaterThanOrEqual(beforeDelta);

    const secondAt = requestTimes[1]!;
    const second = streams[1]!;
    second.push({ type: "start", partial: message([], secondAt) });
    second.push({ type: "text_start", contentIndex: 0, partial: message([fauxText("")], secondAt) });
    second.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message([fauxText("ok")], secondAt) });
    second.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message([fauxText("ok")], secondAt) });
    second.push({ type: "done", reason: "stop", message: message([fauxText("ok")], secondAt) });
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "ok",
    );
  });
});
