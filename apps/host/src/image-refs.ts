// Image refs on the wire (issue #167, ADR-0027). Storage keeps image bytes
// inline in the conversation's entries; a stream subscribed with
// `images: "ref"` sees `{ type: "image", mimeType, ref }` instead, and the
// `image` call answers the bytes. This way a reconnect or a repeated
// snapshot resends refs, never the images behind them.
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { Op, Path } from "@earendil-works/chord/delta";
import type { ImageMimeType, MessageImage } from "@pinomad/protocol/images.ts";

type JsonObject = { readonly [key: string]: JsonValue };
type ImageBlock = JsonObject & { readonly type: "image"; readonly data: string; readonly mimeType: string };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isImageBlock = (value: JsonObject): value is ImageBlock =>
  value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

// Views are immutable and share unchanged subtrees, so a block hashed once
// is the same object in every later snapshot and op.
const hashed = new WeakMap<object, string>();

function refOf(block: ImageBlock): string {
  let ref = hashed.get(block);
  if (ref === undefined) {
    ref = createHash("sha256").update(block.data).digest("hex");
    hashed.set(block, ref);
  }
  return ref;
}

function resolve(root: JsonValue, path: Path, length: number): JsonValue | undefined {
  let node: JsonValue | undefined = root;
  for (let i = 0; i < length; i++) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, JsonValue>)[path[i]!];
  }
  return node;
}

/** Whether `op` addresses something inside an image block of `root`, where the client holds a ref, not the bytes. */
function reachesIntoImage(op: Op, root: JsonValue): boolean {
  if (op[0] === "r") return false;
  const path = op[1];
  // s/d/a/t name a slot inside their parent; p/m name the array they edit.
  const depth = op[0] === "p" || op[0] === "m" ? path.length : path.length - 1;
  for (let length = 1; length <= depth; length++) {
    const node = resolve(root, path, length);
    if (isObject(node) && node.type === "image") return true;
  }
  return false;
}

/** One `images: "ref"` subscription: rewrites what it sends and remembers the bytes behind each ref it sent. */
export class ImageRefs {
  readonly #shown = new Map<string, MessageImage>();

  get(ref: string): MessageImage | undefined {
    return this.#shown.get(ref);
  }

  /** `value` with each image block's bytes swapped for its ref; subtrees without images keep their identity. */
  value(value: JsonValue): JsonValue {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      let out: JsonValue[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const next = this.value(value[i]!);
        if (next !== value[i]) (out ??= value.slice())[i] = next;
      }
      return out ?? value;
    }
    const object = value as JsonObject;
    if (isImageBlock(object)) {
      const ref = refOf(object);
      // The host admitted these through imageProblem or a tool's own image check.
      this.#shown.set(ref, { data: object.data, mimeType: object.mimeType as ImageMimeType });
      const { data: _data, ...rest } = object;
      return { ...rest, ref };
    }
    let out: Record<string, JsonValue> | undefined;
    for (const key of Object.keys(object)) {
      const next = this.value(object[key]!);
      if (next !== object[key]) (out ??= { ...object })[key] = next;
    }
    return out ?? value;
  }

  /**
   * The ops a client holding `value(before)` needs to reach `value(after)`.
   * An op reaching inside an image block can't apply to the ref form, so the
   * batch becomes one replacement. Upstream never edits an image block in
   * place; this keeps the stream correct if it ever does.
   */
  ops(ops: readonly Op[], before: JsonValue, after: JsonValue): Op[] {
    if (ops.some((op) => reachesIntoImage(op, before) || reachesIntoImage(op, after))) return [["r", this.value(after)]];
    return ops.map((op): Op => {
      switch (op[0]) {
        case "r":
          return ["r", this.value(op[1])];
        case "s":
          return ["s", op[1], this.value(op[2])];
        case "p":
          return ["p", op[1], op[2], op[3], op[4].map((item) => this.value(item))];
        default:
          return op;
      }
    });
  }
}
