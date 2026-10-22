// Image refs on the wire (issue #167, ADR-0027). Storage keeps image bytes
// inline in the conversation's entries; a stream subscribed with
// `images: "ref"` sees `{ type: "image", mimeType, ref }` instead, and the
// `image` call answers the bytes. This way a reconnect or a repeated
// snapshot resends refs, never the images behind them.
//
// Only image blocks at the three content positions the conversation view stores
// user input in are rewritten. Walking arbitrary JSON by shape would also hit
// tool `details` and arguments, where an image-shaped object is data, not an
// image the client may replace with a ref.
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable, type Op, type Path } from "@earendil-works/chord/delta";
import type { ImageMimeType, MessageImage } from "@pinomad/protocol/images.ts";

type JsonObject = { readonly [key: string]: JsonValue };
type ImageBlock = JsonObject & { readonly type: "image"; readonly data: string; readonly mimeType: string };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isImageBlock = (value: JsonObject): value is ImageBlock =>
  value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

// A ref names bytes *and* their type: the same bytes as PNG and JPEG are
// different images to a model, so they must not share a cache entry.
// Views are immutable and share unchanged subtrees, so a block hashed once
// is the same object in every later snapshot and op.
const hashed = new WeakMap<object, string>();

function refOf(block: ImageBlock): string {
  let ref = hashed.get(block);
  if (ref === undefined) {
    ref = createHash("sha256").update(block.mimeType).update("\n").update(block.data).digest("hex");
    hashed.set(block, ref);
  }
  return ref;
}

/** Where a path (or a payload inserted there) sits in the conversation view. */
type Slot =
  | "none"
  | "entries"
  | "entry"
  | "messages"
  | "message"
  | "content"
  | "block"
  | "docs"
  | "inbox"
  | "items"
  | "item"
  | "live"
  | "generation";

function slotAt(path: Path): Slot {
  if (path[0] === "entries") {
    if (path.length === 1) return "entries";
    if (path.length === 2 && typeof path[1] === "number") return "entry";
    if (path.length === 3 && typeof path[1] === "number" && path[2] === "model") return "messages";
    if (path.length === 4 && typeof path[1] === "number" && path[2] === "model" && typeof path[3] === "number") return "message";
    if (
      path.length === 5
      && typeof path[1] === "number"
      && path[2] === "model"
      && typeof path[3] === "number"
      && path[4] === "content"
    ) return "content";
    if (
      path.length === 6
      && typeof path[1] === "number"
      && path[2] === "model"
      && typeof path[3] === "number"
      && path[4] === "content"
      && typeof path[5] === "number"
    ) return "block";
    return "none";
  }
  if (path[0] !== "docs") return "none";
  if (path.length === 1) return "docs";
  if (path[1] === "pi.inbox") {
    if (path.length === 2) return "inbox";
    if (path.length === 3 && path[2] === "items") return "items";
    if (path.length === 4 && path[2] === "items" && typeof path[3] === "number") return "item";
    if (path.length === 5 && path[2] === "items" && typeof path[3] === "number" && path[4] === "content") return "content";
    if (
      path.length === 6
      && path[2] === "items"
      && typeof path[3] === "number"
      && path[4] === "content"
      && typeof path[5] === "number"
    ) return "block";
    return "none";
  }
  if (path[1] === "pi.live") {
    if (path.length === 2) return "live";
    if (path.length === 3 && path[2] === "generation") return "generation";
    if (path.length === 4 && path[2] === "generation" && path[3] === "message") return "message";
    if (path.length === 5 && path[2] === "generation" && path[3] === "message" && path[4] === "content") return "content";
    if (
      path.length === 6
      && path[2] === "generation"
      && path[3] === "message"
      && path[4] === "content"
      && typeof path[5] === "number"
    ) return "block";
    return "none";
  }
  return "none";
}

function withRef(block: ImageBlock): JsonObject {
  const ref = refOf(block);
  const { data: _data, ...rest } = block;
  return { ...rest, ref };
}

/**
 * Hash at most this many image bytes before yielding to the event loop. A
 * cold snapshot of a long conversation can hold tens of megabytes of images;
 * one synchronous pass would stall every other connection's frames.
 */
const HASH_YIELD_BYTES = 8 * 1024 * 1024;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

async function hashBlocks(blocks: readonly ImageBlock[]): Promise<void> {
  let bytes = 0;
  for (const block of blocks) {
    if (hashed.has(block)) continue;
    if (bytes >= HASH_YIELD_BYTES) {
      bytes = 0;
      await yieldToEventLoop();
    }
    refOf(block);
    bytes += block.data.length;
  }
}

function rewriteEntries(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  let out: JsonValue[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const next = rewriteEntry(value[i]!);
    if (next !== value[i]) (out ??= value.slice())[i] = next;
  }
  return out ?? value;
}

function rewriteEntry(value: JsonValue): JsonValue {
  if (!isObject(value) || value.model === undefined) return value;
  const model = rewriteMessages(value.model);
  return model === value.model ? value : { ...value, model };
}

function rewriteMessages(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  let out: JsonValue[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const next = rewriteMessage(value[i]!);
    if (next !== value[i]) (out ??= value.slice())[i] = next;
  }
  return out ?? value;
}

function rewriteMessage(value: JsonValue): JsonValue {
  if (!isObject(value) || value.content === undefined) return value;
  const content = rewriteContent(value.content);
  return content === value.content ? value : { ...value, content };
}

/** A content array; each element is a place where an image block may live. */
function rewriteContent(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  let out: JsonValue[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const block = value[i]!;
    const next = isObject(block) && isImageBlock(block) ? withRef(block) : block;
    if (next !== block) (out ??= value.slice())[i] = next;
  }
  return out ?? value;
}

function rewriteItems(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  let out: JsonValue[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const next = rewriteItem(value[i]!);
    if (next !== value[i]) (out ??= value.slice())[i] = next;
  }
  return out ?? value;
}

function rewriteItem(value: JsonValue): JsonValue {
  if (!isObject(value) || value.content === undefined) return value;
  const content = rewriteContent(value.content);
  return content === value.content ? value : { ...value, content };
}

function rewriteInbox(value: JsonValue): JsonValue {
  if (!isObject(value) || value.items === undefined) return value;
  const items = rewriteItems(value.items);
  return items === value.items ? value : { ...value, items };
}

function rewriteGeneration(value: JsonValue): JsonValue {
  if (!isObject(value) || value.message === undefined) return value;
  const message = rewriteMessage(value.message);
  return message === value.message ? value : { ...value, message };
}

function rewriteLive(value: JsonValue): JsonValue {
  if (!isObject(value) || value.generation === undefined) return value;
  const generation = rewriteGeneration(value.generation);
  return generation === value.generation ? value : { ...value, generation };
}

function rewriteDocs(value: JsonValue): JsonValue {
  if (!isObject(value)) return value;
  let out: Record<string, JsonValue> | undefined;
  for (const key of ["pi.inbox", "pi.live"]) {
    const doc = value[key];
    if (doc === undefined) continue;
    const next = key === "pi.inbox" ? rewriteInbox(doc) : rewriteLive(doc);
    if (next !== doc) (out ??= { ...value })[key] = next;
  }
  return out ?? value;
}

/** The whole conversation view, rewritten at the three content positions only. */
function rewriteView(value: JsonValue): JsonValue {
  if (!isObject(value)) return value;
  let out: Record<string, JsonValue> | undefined;
  if (value.entries !== undefined) {
    const entries = rewriteEntries(value.entries);
    if (entries !== value.entries) (out ??= { ...value }).entries = entries;
  }
  if (value.docs !== undefined) {
    const docs = rewriteDocs(value.docs);
    if (docs !== value.docs) (out ??= { ...value }).docs = docs;
  }
  return out ?? value;
}

function rewriteSlot(slot: Slot, value: JsonValue): JsonValue {
  switch (slot) {
    case "entries": return rewriteEntries(value);
    case "entry": return rewriteEntry(value);
    case "messages": return rewriteMessages(value);
    case "message": return rewriteMessage(value);
    case "content": return rewriteContent(value);
    case "block": return isObject(value) && isImageBlock(value) ? withRef(value) : value;
    case "docs": return rewriteDocs(value);
    case "inbox": return rewriteInbox(value);
    case "items": return rewriteItems(value);
    case "item": return rewriteItem(value);
    case "live": return rewriteLive(value);
    case "generation": return rewriteGeneration(value);
    default: return value;
  }
}

function rewriteOp(op: Op): Op {
  switch (op[0]) {
    case "r": {
      const value = rewriteView(op[1]);
      return value === op[1] ? op : ["r", value];
    }
    case "s": {
      const slot = slotAt(op[1]);
      if (slot === "none") return op;
      const value = rewriteSlot(slot, op[2]);
      return value === op[2] ? op : ["s", op[1], value];
    }
    case "p": {
      const path = op[1];
      const start = op[2];
      let items: JsonValue[] | undefined;
      for (let i = 0; i < op[4].length; i++) {
        const item = op[4][i]!;
        const slot = slotAt([...path, start + i]);
        const next = slot === "none" ? item : rewriteSlot(slot, item);
        if (next !== item) (items ??= op[4].slice())[i] = next;
      }
      return items === undefined ? op : ["p", op[1], op[2], op[3], items];
    }
    default:
      return op;
  }
}

function resolve(root: JsonValue, path: Path, length: number): JsonValue | undefined {
  let node: JsonValue | undefined = root;
  for (let i = 0; i < length; i++) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, JsonValue>)[path[i]!];
  }
  return node;
}

/**
 * Whether `op` edits something inside an image block of `root`, where the
 * client holds a ref instead of the bytes. Its own path at the image block
 * (set/delete/splice of the whole element) is fine; a deeper path is not.
 */
function reachesIntoImage(op: Op, root: JsonValue): boolean {
  if (op[0] === "r" || op[0] === "m") return false;
  const path = op[1];
  const depth = op[0] === "p" ? path.length : path.length - 1;
  for (let length = 1; length <= depth; length++) {
    if (slotAt(path.slice(0, length)) !== "block") continue;
    const node = resolve(root, path, length);
    if (isObject(node) && isImageBlock(node)) return true;
  }
  return false;
}

/** Every content array at one of the three rewrite positions. */
function* contentArrays(view: JsonValue): Generator<readonly JsonValue[]> {
  if (!isObject(view)) return;
  if (Array.isArray(view.entries)) {
    for (const entry of view.entries) {
      if (!isObject(entry) || !Array.isArray(entry.model)) continue;
      for (const message of entry.model) {
        if (isObject(message) && Array.isArray(message.content)) yield message.content;
      }
    }
  }
  if (!isObject(view.docs)) return;
  const inbox = view.docs["pi.inbox"];
  if (isObject(inbox) && Array.isArray(inbox.items)) {
    for (const item of inbox.items) {
      if (isObject(item) && Array.isArray(item.content)) yield item.content;
    }
  }
  const live = view.docs["pi.live"];
  if (
    isObject(live)
    && isObject(live.generation)
    && isObject(live.generation.message)
    && Array.isArray(live.generation.message.content)
  ) {
    yield live.generation.message.content;
  }
}

function imageBlocks(view: JsonValue): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const content of contentArrays(view)) {
    for (const block of content) {
      if (isObject(block) && isImageBlock(block)) blocks.push(block);
    }
  }
  return blocks;
}

function findImage(view: JsonValue, ref: string): MessageImage | undefined {
  for (const block of imageBlocks(view)) {
    if (refOf(block) === ref) {
      // The host admitted these through imageProblem or a tool's own image check.
      return { data: block.data, mimeType: block.mimeType as ImageMimeType };
    }
  }
  return undefined;
}

/** One `images: "ref"` subscription: rewrites what it sends and answers refs from its current view. */
export class ImageRefs {
  /**
   * `view` with image blocks at the three content positions swapped for refs;
   * other subtrees keep their identity. Async only to hash a cold view in
   * batches — the returned value is the same one a single pass would build.
   */
  async value(view: JsonValue): Promise<JsonValue> {
    const blocks = imageBlocks(view);
    if (blocks.length > 0) await hashBlocks(blocks);
    return rewriteView(view);
  }

  /**
   * The bytes behind `ref` in `view`, or undefined once it no longer shows
   * that block. The gateway passes each ref subscription's current raw view,
   * so refs expire when a block is withdrawn or otherwise leaves the view.
   */
  image(view: JsonValue, ref: string): MessageImage | undefined {
    return findImage(view, ref);
  }

  /**
   * The ops a client holding `value(before)` needs to reach the rewritten
   * state. An op that reaches inside an image block cannot apply to the ref
   * form, so the batch becomes one replacement of the state it produces.
   *
   * Each op is checked against the state *before it*, not the batch's
   * endpoints: a batch may insert a block, edit it, then move it, and only
   * the intermediate positions say where that out-of-place edit lands.
   */
  async ops(ops: readonly Op[], before: JsonValue): Promise<Op[]> {
    let state = before;
    let touched = false;
    for (const op of ops) {
      if (!touched && reachesIntoImage(op, state)) touched = true;
      state = applyImmutable(state, [op]) as JsonValue;
    }
    if (touched) {
      await hashBlocks(imageBlocks(state));
      return [["r", rewriteView(state)]];
    }
    // A whole-view replacement can carry a cold image set just like a snapshot.
    if (ops.some((op) => op[0] === "r")) await hashBlocks(imageBlocks(state));
    return ops.map(rewriteOp);
  }
}
