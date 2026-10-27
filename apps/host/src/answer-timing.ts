// The host records when the first answer text arrived (issue #395). The
// provider's AssistantMessage.timestamp is when the request started, so a
// one-message run otherwise measures zero thinking time. We keep the stamp in
// PiNomad's own namespace and strip it before requests go back to a provider.
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

type PinomadMessage = AssistantMessage & { pinomad?: { answerStartedAt?: number } };

/** Copy the message so the stored entry is not mutated while a stalled commit holds it. */
function withAnswerStart<T extends AssistantMessage>(message: T, answerStartedAt: number): T {
  const pinomad = (message as PinomadMessage).pinomad;
  return { ...message, pinomad: { ...pinomad, answerStartedAt } };
}

/**
 * Shallow-copy assistant history without pinomad: providers rebuild messages
 * from a whitelist today, but this is the explicit boundary that keeps our
 * metadata from ever reaching a model if one starts spreading the whole message.
 */
function stripPinomad(context: Context): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant" || !("pinomad" in message)) return message;
    const { pinomad: _pinomad, ...rest } = message as PinomadMessage;
    changed = true;
    return rest;
  });
  return changed ? { ...context, messages } : context;
}

/**
 * The first non-empty text delta is the first answer token; text_start only
 * opens an empty block (OpenAI Responses emits it when the output item is
 * created). A provider that skips deltas still counts when text_end carries
 * the full text. Patching the stream's own push/end leaves iteration, result(),
 * ordering, cancellation and errors exactly as the provider produced them.
 */
function trackAnswerStart(stream: AssistantMessageEventStream): AssistantMessageEventStream {
  let answerStartedAt: number | undefined;
  const annotate = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (event.type === "text_delta" && event.delta !== "") {
      answerStartedAt ??= Date.now();
    } else if (event.type === "text_end" && event.content !== "" && answerStartedAt === undefined) {
      answerStartedAt = Date.now();
    }
    if (answerStartedAt === undefined) return event;
    if (event.type === "done") return { ...event, message: withAnswerStart(event.message, answerStartedAt) };
    if (event.type === "error") return { ...event, error: withAnswerStart(event.error, answerStartedAt) };
    return { ...event, partial: withAnswerStart(event.partial, answerStartedAt) };
  };

  const push = stream.push.bind(stream);
  stream.push = (event) => push(annotate(event));
  const end = stream.end.bind(stream);
  stream.end = (result) =>
    end(result === undefined || answerStartedAt === undefined ? result : withAnswerStart(result, answerStartedAt));
  return stream;
}

/** Wrap the Models handed to the Harness; every other operation is forwarded untouched. */
export function withAnswerTiming(models: Models): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    trackAnswerStart(models.streamSimple(model, stripPinomad(context), options));
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
