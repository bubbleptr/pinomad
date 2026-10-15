import { describe, expect, test } from "vitest";
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from "@pinomad/protocol/images.ts";
import { createAttachmentStore, type ImageSource } from "./attachment-store.ts";

const source = (name: string): ImageSource => ({ uri: `file://${name}.jpg` });
const image = (name: string): MessageImage => ({ data: Buffer.from(name).toString("base64"), mimeType: "image/jpeg" });

/** A controllable prepare: resolve/reject the returned promises by hand. */
function fakePrepare() {
  const calls: { source: ImageSource; resolve(image: MessageImage): void; reject(error: Error): void }[] = [];
  const prepare = (src: ImageSource): Promise<MessageImage> =>
    new Promise((resolve, reject) => {
      calls.push({ source: src, resolve, reject });
    });
  return { calls, prepare };
}

function makeStore(prepare: (s: ImageSource) => Promise<MessageImage>, accepts = () => true) {
  return createAttachmentStore({ accepts, prepare });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("attachment store", () => {
  test("staged images appear once preparation resolves", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a")]);
    expect(store.state.images).toEqual([]);
    expect(store.state.pending).toBe(true);
    calls[0]!.resolve(image("a"));
    await flush();
    expect(store.state.images).toEqual([image("a")]);
    expect(store.state.pending).toBe(false);
  });

  test("reserves slots synchronously: a second add before resolution sees less room", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a"), source("b"), source("c")]);
    // Three in flight; only one slot left — four more get cut to one.
    store.add([source("d"), source("e"), source("f"), source("g")]);
    expect(calls).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(store.state.error).toMatch(/at most 4/i);
    for (const call of calls) call.resolve(image("x"));
    await flush();
    expect(store.state.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });

  test("a failed preparation frees its slots and reports the error", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a"), source("b"), source("c"), source("d")]);
    calls[0]!.reject(new Error("Couldn't read the image"));
    await flush();
    // The batch dropped, the error shows, and the quota is free again.
    expect(store.state.error).toBe("Couldn't read the image");
    expect(store.state.images).toEqual([]);
    expect(store.state.pending).toBe(false);
    store.add([source("e")]);
    expect(calls).toHaveLength(5);
  });

  test("remove frees a slot", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a"), source("b"), source("c"), source("d")]);
    for (const call of calls) call.resolve(image("x"));
    await flush();
    store.remove(0);
    expect(store.state.images).toHaveLength(3);
    store.add([source("e")]);
    expect(calls).toHaveLength(5);
    expect(store.state.error).toBeNull();
  });

  test("clear drops in-flight results so they can't resurrect", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a")]);
    store.clear();
    calls[0]!.resolve(image("a"));
    await flush();
    expect(store.state.images).toEqual([]);
    expect(store.state.pending).toBe(false);
  });

  test("add reports when the model doesn't accept images", () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare, () => false);
    store.add([source("a")]);
    expect(calls).toHaveLength(0);
    expect(store.state.error).toMatch(/doesn't accept images/i);
  });

  test("a clean add clears a previous error", async () => {
    const { calls, prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.add([source("a"), source("b"), source("c"), source("d"), source("e")]);
    expect(store.state.error).toMatch(/at most 4/i);
    for (const call of calls) call.resolve(image("x"));
    await flush();
    store.remove(0);
    store.add([source("e")]);
    expect(store.state.error).toBeNull();
  });

  test("report sets an error without touching the images", () => {
    const { prepare } = fakePrepare();
    const store = makeStore(prepare);
    store.report("Clipboard has no image");
    expect(store.state.error).toBe("Clipboard has no image");
  });
});
