// ADR-0018 §5 contract snapshot: this test records every ServerFrame one real
// host sends — hello, stream snapshots, chord ops, a call result — and compares
// their *shape* against a committed baseline. On an `@earendil-works/*` upgrade
// rerun with PINOMAD_UPDATE_CONTRACT=1 and review the diff of
// packages/protocol/test/fixtures/host-frames.shape.json: additive changes →
// bump PROTOCOL.minor, breaking ones → PROTOCOL.major.
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyImmutable } from "@earendil-works/chord/delta";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { coding } from "../src/extensions/coding.ts";
import { startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();
const fixturesDir = fileURLToPath(new URL("../../../packages/protocol/test/fixtures", import.meta.url));
const RAW_PATH = join(fixturesDir, "host-frames.json");
const SHAPE_PATH = join(fixturesDir, "host-frames.shape.json");

type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };

/** String values under these keys carry meaning, not data: kept as `=<value>`. */
const LITERAL_KEYS = new Set(["type", "kind", "role"]);

/**
 * Objects that are maps keyed by a runtime id rather than a schema field —
 * found by recording twice and diffing. Their keys collapse to "<key>" so a
 * fresh id does not change the shape. Currently known:
 * - `tasks` (a `tasks` stream value's TaskGraph.tasks, keyed by decimal TaskId)
 * Decimal-keyed objects are treated the same wherever they appear, including
 * inside op payloads.
 */
const ID_KEYED_PATHS = new Set(["tasks"]);
const DECIMAL_KEY = /^\d+$/;

/** Sorted, JSON-deduped element shapes — an array keeps its array-ness even with one distinct element. */
function elementShapes(shapes: readonly Shape[]): Shape[] {
  const distinct = [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()];
  distinct.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return distinct;
}

const OR = "<or>";
const isShapeObject = (shape: Shape): shape is { readonly [key: string]: Shape } =>
  typeof shape === "object" && shape !== null && !Array.isArray(shape);
const isUnion = (shape: Shape): shape is { readonly [OR]: readonly Shape[] } =>
  isShapeObject(shape) && Object.keys(shape).length === 1 && OR in shape;

/** A union of value shapes, wrapped as `{ "<or>": [...] }` so it can't be confused with an array shape. */
function union(shapes: readonly Shape[]): Shape {
  const flat = shapes.flatMap((shape) => (isUnion(shape) ? [...shape[OR]] : [shape]));
  const distinct = elementShapes(flat);
  return distinct.length === 1 ? distinct[0]! : { [OR]: distinct };
}

/**
 * Merge two shapes of the same position: objects union their keys (a key seen
 * in only some values is simply part of the union — the merge makes transient
 * states like `pi.live.generation` stable whether they arrive by snapshot or
 * by ops), arrays union their element shapes, anything else unions directly.
 */
function merge(a: Shape, b: Shape): Shape {
  if (isShapeObject(a) && isShapeObject(b) && !isUnion(a) && !isUnion(b)) {
    const out: Record<string, Shape> = {};
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      out[key] = a[key] === undefined ? b[key]! : b[key] === undefined ? a[key]! : merge(a[key]!, b[key]!);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return elementShapes([...a, ...b]);
  return union([a, b]);
}

function shapeOf(value: unknown, path: string): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return elementShapes(value.map((element) => shapeOf(element, path)));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 0 && (ID_KEYED_PATHS.has(path) || entries.every(([key]) => DECIMAL_KEY.test(key)))) {
      return { "<key>": union(entries.map(([, entry]) => shapeOf(entry, `${path}.<key>`))) };
    }
    const out: Record<string, Shape> = {};
    for (const [key, entry] of entries) {
      out[key] =
        LITERAL_KEYS.has(key) && typeof entry === "string" ? `=${entry}` : shapeOf(entry, path === "" ? key : `${path}.${key}`);
    }
    return out;
  }
  return typeof value;
}

/** `conversation:4` and `doc:plan:4` collapse their trailing id so the stream key is stable. */
const streamKey = (stream: string): string => stream.replace(/:\d+$/, ":*");

/**
 * The recording's shape (ADR-0018 §5). Snapshot and ops frames are folded with
 * `applyImmutable` and every observed stream value merges into one shape per
 * stream — whether a commit lands before or after a snapshot is timing, not
 * contract. Ops contribute their discriminants per stream. Other frames merge
 * by type.
 */
function shape(frames: readonly unknown[]): Shape {
  const frameShapes = new Map<string, Shape>();
  const streamShapes = new Map<string, { value: unknown; shape: Shape | undefined; ops: Set<string> }>();
  for (const frame of frames as readonly ServerFrame[]) {
    if (frame.type === "snapshot" || frame.type === "ops") {
      const key = streamKey(frame.stream);
      let stream = streamShapes.get(key);
      if (frame.type === "snapshot") {
        stream = { value: frame.value, shape: stream?.shape, ops: stream?.ops ?? new Set() };
      } else if (stream !== undefined) {
        stream.value = applyImmutable(stream.value, frame.ops);
        for (const op of frame.ops) stream.ops.add(`=${op[0]}`);
      } else {
        // Ops without a snapshot would not apply; record the discriminants only.
        stream = { value: undefined, shape: undefined, ops: new Set(frame.ops.map((op) => `=${op[0]}`)) };
      }
      if (stream.value !== undefined) {
        const next = shapeOf(stream.value, "");
        stream.shape = stream.shape === undefined ? next : merge(stream.shape, next);
      }
      streamShapes.set(key, stream);
      continue;
    }
    const next = shapeOf(frame, "");
    frameShapes.set(frame.type, frameShapes.has(frame.type) ? merge(frameShapes.get(frame.type)!, next) : next);
  }
  return {
    frames: Object.fromEntries([...frameShapes.entries()].sort(([a], [b]) => a.localeCompare(b))),
    streams: Object.fromEntries(
      [...streamShapes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, stream]) => [
          key,
          {
            ...(stream.shape === undefined ? {} : { value: stream.shape }),
            ops: [...stream.ops].sort(),
          },
        ]),
    ),
  };
}

/**
 * One scripted run over a raw socket: a `write` tool call so a pinomad.diff
 * `details` reaches the wire, then a final answer. Returns every frame seen.
 */
async function recordFrames(): Promise<ServerFrame[]> {
  const host = await startFauxHost(defer, {
    extensions: [coding],
    answers: [
      fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "contract\n" }), { stopReason: "toolUse" }),
      "contract done",
    ],
  });
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  const latest = new Map<string, unknown>();
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "snapshot") latest.set(frame.stream, frame.value);
    if (frame.type === "ops") latest.set(frame.stream, applyImmutable(latest.get(frame.stream), frame.ops));
  });
  await once(socket, "open");
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  const until = async (predicate: () => boolean) => {
    while (!predicate()) await once(socket, "message");
  };

  const streams = ["conversations", "index", "devices", "mcp", "tasks"];
  for (const stream of streams) send({ type: "subscribe", stream });
  await until(() => streams.every((stream) => latest.has(stream)));

  send({
    type: "call",
    id: 1,
    method: "createConversation",
    args: { home: { kind: "chat" }, text: "contract run", requestId: "contract-1" },
  });
  await until(() => frames.some((frame) => frame.type === "result" && frame.id === 1));
  const result = frames.find((frame) => frame.type === "result" && frame.id === 1)!;
  const conversationId = (result as { value: { conversationId: number } }).value.conversationId;

  const stream = `conversation:${conversationId}`;
  send({ type: "subscribe", stream });
  const settled = (): boolean => {
    const view = latest.get(stream) as ConversationView | undefined;
    return view !== undefined && !isBusy(view) && transcript(view).at(-1)?.text === "contract done";
  };
  await until(settled);

  // The repo is public: machine paths must not land in the fixture. The data
  // dir is the only absolute path a faux host emits (session.directory and
  // every chat cwd sit under it); its basename is the session id.
  const hello = frames.find((frame) => frame.type === "hello")!;
  const text = JSON.stringify(frames)
    .replaceAll(hello.session.directory, "<dataDir>")
    .replaceAll(hello.session.id, "<sessionId>");
  return JSON.parse(text) as ServerFrame[];
}

describe("protocol contract", () => {
  it("matches the committed frame shapes", async () => {
    const frames = await recordFrames();
    const fresh = shape(frames);
    if (process.env.PINOMAD_UPDATE_CONTRACT === "1") {
      await mkdir(fixturesDir, { recursive: true });
      await writeFile(RAW_PATH, `${JSON.stringify(frames, null, 2)}\n`);
      await writeFile(SHAPE_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
      return;
    }
    const raw = JSON.parse(await readFile(RAW_PATH, "utf8")) as unknown[];
    const committed = JSON.parse(await readFile(SHAPE_PATH, "utf8")) as Shape;
    expect(shape(raw)).toEqual(committed);
    expect(fresh).toEqual(committed);
  });
});
