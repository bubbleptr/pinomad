// Comparison vectors for the Rust `pinomad-core` (ADR-0024 §6): cases the
// TypeScript reference computes once, committed to
// `test/fixtures/rust-vectors/`, that the Rust suite replays verbatim. A
// vitest checks they are fresh — regenerate with PINOMAD_UPDATE_VECTORS=1.
// The Rust side treats these files as ground truth, so they are written in
// the shape the wire actually carries: JSON texts, hex blobs, decoded ops.
import { applyImmutable } from "@earendil-works/chord/delta";
import { UnsafePathError, PathError } from "@earendil-works/chord/delta";
import {
  CALL_SINCE,
  FEATURE_SINCE,
  HOST_STREAMS,
  hostSupportsCall,
  hostSupportsFeature,
  PROTOCOL,
  type CallMethod,
} from "../src/frames.ts";
import { initiateIK, keyPairFromPrivate, respondIK } from "../src/noise.ts";
import { encodeClientHello, encodeHostHello, SECURE_PROLOGUE, SecureSession, SIGNAL_PROLOGUE } from "../src/secure-channel.ts";
import { isRtcHello, RTC_DEFAULT_STUN } from "../src/rtc.ts";
import {
  ENDPOINT_SET_SCHEMA_VERSION,
  MAX_HOST_ENDPOINTS,
  MAX_HOST_ENDPOINT_URL_LENGTH,
  encodeEndpointSetParam,
  parseEndpointSet,
  parseEndpointSetParam,
  type EndpointSet,
  type HostEndpoint,
} from "../src/endpoints.ts";
import { pairingFragment, parsePairParam, parsePairingLink } from "../src/pairing-link.ts";

export interface VectorFile {
  readonly name: string;
  readonly text: string;
}

const write = (name: string, data: unknown): VectorFile => ({
  name,
  text: `${JSON.stringify(data, null, 2)}\n`,
});

/** `JSON.stringify` of a value — what the vectors compare byte-for-byte. */
const wire = (value: unknown): string => JSON.stringify(value);

// ─── Frames ──────────────────────────────────────────────────────────────────
//
// Each server case is the raw text a socket delivers and the frame variant
// the Rust decoder must classify it as ("ignored" for anything this build
// does not know — ADR-0018 §4). Client cases are the exact JSON.stringify
// output the typed encoder must reproduce.

function framesVector(): VectorFile {
  const snapshotValue = {
    device: "Workphone \ud83d", // host truncation leaves a lone surrogate
    nested: { keep: ["a", "b"], n: 1e21 },
  };
  const serverFrames = [
    { name: "hello", wire: wire({ type: "hello", protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor }, hostVersion: "1.2.3", session: { id: "s1", directory: "/data" }, models: [], docs: [], toolPresentations: { edit: "pinomad.diff" } }), expect: "hello" },
    { name: "hello-legacy-int-protocol", wire: wire({ type: "hello", protocol: 4, session: { id: "s", directory: "/d" }, models: [], docs: [], toolPresentations: {} }), expect: "hello" },
    { name: "hello-unknown-fields", wire: wire({ type: "hello", protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor }, session: { id: "s", directory: "/d" }, models: [], docs: [], toolPresentations: {}, future: { anything: [1, 2] } }), expect: "hello" },
    { name: "signalHello", wire: wire({ type: "signalHello", protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor }, rtc: { stun: [...RTC_DEFAULT_STUN], signalOnly: true } }), expect: "signalHello" },
    { name: "signalHello-no-rtc", wire: wire({ type: "signalHello", protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor } }), expect: "signalHello" },
    { name: "snapshot", wire: wire({ type: "snapshot", stream: "index", value: snapshotValue }), expect: "snapshot", stream: "index" },
    { name: "snapshot-nonstring-stream", wire: wire({ type: "snapshot", stream: 7, value: 1 }), expect: "snapshot" },
    { name: "ops", wire: wire({ type: "ops", stream: "index", ops: [["s", ["a", "b"], 1], ["a", ["s"], "x"]] }), expect: "ops", stream: "index" },
    { name: "ended", wire: wire({ type: "ended", stream: "conversation:3", reason: "gone" }), expect: "ended", stream: "conversation:3" },
    { name: "result-ok", wire: wire({ type: "result", id: 4, ok: true, value: { conversationId: 9 } }), expect: "result" },
    { name: "result-err", wire: wire({ type: "result", id: 5, ok: false, error: "nope" }), expect: "result" },
    { name: "result-absent-value", wire: wire({ type: "result", id: 6, ok: true }), expect: "result" },
    { name: "notice", wire: wire({ type: "notice", level: "error", message: "bad" }), expect: "notice" },
    { name: "unknown-type", wire: wire({ type: "from-the-future", data: 1 }), expect: "ignored" },
    { name: "unknown-type-similar", wire: wire({ type: "snapshots" }), expect: "ignored" },
    { name: "missing-type", wire: wire({ stream: "index" }), expect: "ignored" },
    { name: "nonstring-type", wire: wire({ type: 4 }), expect: "ignored" },
    { name: "array-frame", wire: wire([1, 2]), expect: "ignored" },
    { name: "null-frame", wire: "null", expect: "ignored" },
    { name: "string-frame", wire: '"subscribe"', expect: "ignored" },
    { name: "number-frame", wire: "5", expect: "ignored" },
    { name: "empty-object", wire: "{}", expect: "ignored" },
  ];
  // Inputs JSON.parse rejects outright; the record layer hands these to the
  // frame parser only as raw text, which must fail the same way.
  const badJson = ["{", "[1,2", '"unterminated', "{'a':1}", "undefined", '{"a":}', "01", "+1", "\\x", '"\\x"', '"\t"'];
  const clientFrames = [
    { name: "subscribe", wire: wire({ type: "subscribe", stream: "conversation:12" }) },
    { name: "unsubscribe", wire: wire({ type: "unsubscribe", stream: "doc:pinomad.title:3" }) },
    {
      name: "call-submit",
      wire: wire({ type: "call", id: 7, method: "submit", args: { conversationId: 2, text: "中文 ✓ 🚀", whenBusy: "followUp", requestId: "req-1", images: [{ data: "AA==", mimeType: "image/png" }] } }),
    },
    // 5.15: a retry can name the image by ref alone (ADR-0027).
    {
      name: "call-submit-ref",
      wire: wire({ type: "call", id: 19, method: "submit", args: { conversationId: 2, text: "again", whenBusy: "followUp", requestId: "req-ref", images: [{ ref: "abc123" }] } }),
    },
    // 5.16: the `$` picks ride submit and createConversation (ADR-0028).
    {
      name: "call-submit-skills",
      wire: wire({ type: "call", id: 20, method: "submit", args: { conversationId: 2, text: "$review then $deploy", whenBusy: "followUp", requestId: "req-s", skills: ["review", "deploy"] } }),
    },
    {
      name: "call-createConversation-skills",
      wire: wire({ type: "call", id: 21, method: "createConversation", args: { home: { kind: "chat" }, text: "plain", requestId: "r", skills: [] } }),
    },
    {
      name: "call-createConversation",
      wire: wire({ type: "call", id: 8, method: "createConversation", args: { home: { kind: "project", path: "/home/u/app" }, text: "go", requestId: "r", checkout: "worktree", model: { provider: "p", modelId: "m" }, thinkingLevel: "high" } }),
    },
    // 5.10: the named-agent field rides the same call (ADR-0023 §8).
    {
      name: "call-createConversation-agent",
      wire: wire({ type: "call", id: 11, method: "createConversation", args: { home: { kind: "chat" }, text: "go", requestId: "r", agent: "reviewer" } }),
    },
    {
      name: "call-listFiles-conversation",
      wire: wire({ type: "call", id: 12, method: "listFiles", args: { scope: { kind: "conversation", conversationId: 7 }, query: "src/" } }),
    },
    {
      name: "call-listFiles-project",
      wire: wire({ type: "call", id: 13, method: "listFiles", args: { scope: { kind: "project", path: "/home/u/app", checkout: "worktree" }, query: "" } }),
    },
    // 5.13: listSkills — one wire case per scope kind (issue #143).
    {
      name: "call-listSkills-conversation",
      wire: wire({ type: "call", id: 14, method: "listSkills", args: { scope: { kind: "conversation", conversationId: 7 } } }),
    },
    {
      name: "call-listSkills-project",
      wire: wire({ type: "call", id: 15, method: "listSkills", args: { scope: { kind: "project", path: "/home/u/app", checkout: "worktree" } } }),
    },
    {
      name: "call-listSkills-chat",
      wire: wire({ type: "call", id: 16, method: "listSkills", args: { scope: { kind: "chat" } } }),
    },
    // 5.14: withdraw/promote queued input (issue #144).
    {
      name: "call-withdrawQueued",
      wire: wire({ type: "call", id: 17, method: "withdrawQueued", args: { conversationId: 2, submissionId: 3 } }),
    },
    {
      name: "call-steerQueued",
      wire: wire({ type: "call", id: 18, method: "steerQueued", args: { conversationId: 2, submissionId: 3 } }),
    },
    // 5.17: host-declared slash commands (issue #254).
    {
      name: "call-listCommands",
      wire: wire({ type: "call", id: 19, method: "listCommands", args: { conversationId: 2 } }),
    },
    {
      name: "call-runCommand",
      wire: wire({ type: "call", id: 20, method: "runCommand", args: { conversationId: 2, name: "compact", args: "keep API notes" } }),
    },
    {
      name: "call-runCommand-no-args",
      wire: wire({ type: "call", id: 21, method: "runCommand", args: { conversationId: 2, name: "compact" } }),
    },
    // 5.18: switching the conversation's named agent (issue #314).
    {
      name: "call-setAgent",
      wire: wire({ type: "call", id: 22, method: "setAgent", args: { conversationId: 2, agent: "reviewer" } }),
    },
    {
      name: "call-setAgent-null",
      wire: wire({ type: "call", id: 23, method: "setAgent", args: { conversationId: 2, agent: null } }),
    },
    // 5.19: file attachments (issue #321).
    {
      name: "call-beginAttachment",
      wire: wire({ type: "call", id: 24, method: "beginAttachment", args: { name: "notes.txt", size: 5 } }),
    },
    {
      name: "call-appendAttachment",
      wire: wire({ type: "call", id: 25, method: "appendAttachment", args: { attachmentId: "A".repeat(22), offset: 0, data: "aGVsbG8=" } }),
    },
    {
      name: "call-submit-attachments",
      wire: wire({ type: "call", id: 26, method: "submit", args: { conversationId: 2, text: "look", whenBusy: "followUp", requestId: "r", attachments: ["A".repeat(22)] } }),
    },
    { name: "call-empty-args", wire: wire({ type: "call", id: 9, method: "createPairing", args: {} }) },
    { name: "call-null-arg", wire: wire({ type: "call", id: 10, method: "setPushToken", args: { token: null } }) },
  ];
  // The complete version gates (ADR-0018 §2), not a hand-picked sample: the
  // Rust mirror must know every row, and its calls/streams/features must flip
  // at the same minor. Sorted so fixture diffs show additions in place.
  const sorted = (entries: [string, number][]) => entries.sort(([a], [b]) => a.localeCompare(b));
  const calls = sorted(Object.entries(CALL_SINCE)).map(([name, since]) => ({ name, since }));
  const streams = sorted(Object.entries(HOST_STREAMS)).map(([name, since]) => ({ name, since }));
  const features = sorted(Object.entries(FEATURE_SINCE)).map(([name, since]) => ({ name, since }));
  const gates = { call: calls, stream: streams, feature: features };
  const versionGates = [
    ...calls.flatMap(({ name, since }) => [
      { name: `${name}@${since}`, minor: since, call: name, expect: hostSupportsCall(since, name as CallMethod) },
      ...(since > 0
        ? [{ name: `${name}@${since - 1}`, minor: since - 1, call: name, expect: hostSupportsCall(since - 1, name as CallMethod) }]
        : []),
    ]),
    ...features.flatMap(({ name, since }) => [
      { name: `${name}@${since}`, minor: since, feature: name, expect: hostSupportsFeature(since, name as never) },
      ...(since > 0
        ? [{ name: `${name}@${since - 1}`, minor: since - 1, feature: name, expect: hostSupportsFeature(since - 1, name as never) }]
        : []),
    ]),
  ];
  // ADR-0033's hello block and offer args: the Rust mirror parses the same
  // shapes, and "absent" is not "malformed" (an older host has no RTC).
  const rtcCases: readonly { name: string; value?: unknown }[] = [
    { name: "absent" },
    { name: "valid", value: { stun: [...RTC_DEFAULT_STUN], signalOnly: true } },
    { name: "empty-stun", value: { stun: [], signalOnly: true } },
    { name: "missing-signal-only", value: { stun: [...RTC_DEFAULT_STUN] } },
    { name: "signal-only-false", value: { stun: [...RTC_DEFAULT_STUN], signalOnly: false } },
    { name: "empty-stun-entry", value: { stun: [""], signalOnly: true } },
    { name: "non-string-stun", value: { stun: [1], signalOnly: true } },
    { name: "not-object", value: "rtc" },
  ];
  const rtcHello = rtcCases.map(({ name, value }) => {
    const valid = value !== undefined && isRtcHello(value);
    return {
      name,
      hello: wire(value === undefined ? {} : { rtc: value }),
      expect: value === undefined ? "none" : valid ? "valid" : "invalid",
      ...(valid ? { stun: value.stun, signalOnly: true } : {}),
    };
  });
  const rtcOfferArgs = [
    { name: "valid", args: { attempt: "attempt-1", sdp: "v=0\r\n" }, expect: "valid", attempt: "attempt-1", sdp: "v=0\r\n" },
    { name: "empty-attempt", args: { attempt: "", sdp: "v=0" }, expect: "invalid" },
    { name: "empty-sdp", args: { attempt: "a", sdp: "" }, expect: "invalid" },
    { name: "missing", args: {}, expect: "invalid" },
    { name: "non-string", args: { attempt: 1, sdp: "v=0" }, expect: "invalid" },
  ].map(({ name, args, expect, ...rest }) => ({ name, args: wire(args), expect, ...rest }));
  return write("frames", {
    protocol: PROTOCOL,
    serverFrames,
    badJson,
    clientFrames,
    gates,
    versionGates,
    rtcHello,
    rtcOfferArgs,
  });
}

// ─── Delta ───────────────────────────────────────────────────────────────────
//
// before/ops/after are JSON texts; the Rust side parses before, decodes ops,
// applies, and compares its re-encoding to `after` byte-for-byte. The TS
// side computes `after` with chord's own applyImmutable, so the reference is
// always the real one. Errors record which failure the Rust port must give.

type DeltaCase = { name: string; before: unknown; ops: unknown[]; after?: unknown; error?: string };

function deltaVector(): VectorFile {
  const cases: DeltaCase[] = [
    // Object writes, deletes, and key order.
    { name: "set-new-key", before: { a: 1 }, ops: [["s", ["b"], 2]], after: undefined },
    { name: "set-existing-key", before: { a: 1, b: 2 }, ops: [["s", ["a"], 9]], after: undefined },
    { name: "set-nested", before: { a: { b: { c: [] } } }, ops: [["s", ["a", "b", "d"], "x"]], after: undefined },
    { name: "set-preserves-key-order", before: { b: 1, a: 2 }, ops: [["s", ["b"], 9], ["s", ["c"], 3]], after: undefined },
    { name: "delete-key", before: { a: 1, b: 2 }, ops: [["d", ["a"]]], after: undefined },
    { name: "delete-missing-key-is-noop", before: { a: 1 }, ops: [["d", ["zzz"]]], after: undefined },
    { name: "delete-then-reset", before: { a: 1, b: 2 }, ops: [["d", ["a"]], ["s", ["a"], 7]], after: undefined },
    // Integer-index keys enumerate first in JS — parse→apply→encode order.
    { name: "index-key-order", before: { x: 0 }, ops: [["s", ["2"], "two"], ["s", ["10"], "ten"], ["s", ["1"], "one"]], after: undefined },
    { name: "numeric-seg-on-object", before: { "0": "zero" }, ops: [["s", [0], "ZERO"], ["s", [3], "three"]], after: undefined },
    // Strings, including lone surrogates and surrogate-boundary slicing.
    { name: "append-string", before: { s: "he" }, ops: [["a", ["s"], "llo"]], after: undefined },
    { name: "append-to-nested-string", before: { a: { s: "x" }, b: 2 }, ops: [["a", ["a", "s"], "yz"]], after: undefined },
    { name: "append-joins-lone-surrogates", before: { s: "phone \ud83d" }, ops: [["a", ["s"], "\udcf1 ok"]], after: undefined },
    { name: "truncate-string", before: { s: "abcdef" }, ops: [["t", ["s"], 2]], after: undefined },
    { name: "truncate-splits-surrogate-pair", before: { s: "a🚀b" }, ops: [["t", ["s"], 2]], after: undefined },
    { name: "truncate-past-end", before: { s: "ab" }, ops: [["t", ["s"], 99]], after: undefined },
    { name: "truncate-zero", before: { s: "ab" }, ops: [["t", ["s"], 0]], after: undefined },
    // Arrays.
    { name: "splice-append", before: { items: [1, 2] }, ops: [["p", ["items"], 2, 0, [3, 4]]], after: undefined },
    { name: "splice-remove", before: { items: [1, 2, 3, 4] }, ops: [["p", ["items"], 1, 2, []]], after: undefined },
    { name: "splice-replace", before: { items: [1, 2, 3] }, ops: [["p", ["items"], 1, 1, ["a", "b"]]], after: undefined },
    { name: "splice-clamps-index", before: { items: [1] }, ops: [["p", ["items"], 99, 0, ["x"]]], after: undefined },
    { name: "splice-clamps-remove", before: { items: [1, 2] }, ops: [["p", ["items"], 1, 99, []]], after: undefined },
    { name: "splice-root-array", before: [1, 2], ops: [["p", [], 1, 0, ["x"]]], after: undefined },
    { name: "set-array-index", before: { items: [1, 2] }, ops: [["s", ["items", 0], 9]], after: undefined },
    { name: "set-array-append-one", before: { items: [1, 2] }, ops: [["s", ["items", 2], 3]], after: undefined },
    { name: "delete-array-index", before: { items: [1, 2, 3] }, ops: [["d", ["items", 1]]], after: undefined },
    { name: "permute", before: { items: ["a", "b", "c"] }, ops: [["m", ["items"], [2, 0, 1]]], after: undefined },
    { name: "append-on-array-string-element", before: { items: ["ab"] }, ops: [["a", ["items", 0], "cd"]], after: undefined },
    // Root replacement.
    { name: "replace-object-with-array", before: { a: 1 }, ops: [["r", [1, 2]]], after: undefined },
    { name: "replace-scalar", before: { a: 1 }, ops: [["r", "text"]], after: undefined },
    { name: "replace-then-mutate", before: { a: 1 }, ops: [["r", { b: { c: [], s: "x" } }], ["s", ["b", "d"], 1], ["a", ["b", "s"], "y"]], after: undefined },
    // A key the client's types do not know keeps working as a delta target —
    // the ADR-0018 reason unknown fields are never dropped (ADR-0024 §4).
    { name: "ops-under-unknown-field", before: { known: 1, future: { list: [], note: "x" } }, ops: [["p", ["future", "list"], 0, 0, [{ new: 1 }]], ["a", ["future", "note"], "y"]], after: undefined },
    // Number formatting survives the round trip — JS's rules, not Rust's.
    { name: "number-formatting", before: {}, ops: [["s", ["big"], 1e21], ["s", ["bigger"], 1e22], ["s", ["small"], 1e-7], ["s", ["fraction"], 0.30000000000000004], ["s", ["neg"], -0.5], ["s", ["hugeInt"], 9007199254740993]], after: undefined },
    // Failures, mapped to the Rust error kind.
    { name: "unsafe-proto", before: {}, ops: [["s", ["__proto__", "isAdmin"], true]], error: "unsafe-path" },
    { name: "unsafe-constructor", before: {}, ops: [["s", ["constructor"], 1]], error: "unsafe-path" },
    { name: "unsafe-string-key-on-array", before: { items: [1, 2] }, ops: [["s", ["items", "0"], 9]], error: "unsafe-path" },
    { name: "unsafe-array-gap", before: { items: [1] }, ops: [["s", ["items", 5], 9]], error: "unsafe-path" },
    { name: "unsafe-negative-index", before: { items: [1] }, ops: [["s", ["items", -1], 9]], error: "unsafe-path" },
    { name: "unsafe-noninteger-index", before: { items: [1] }, ops: [["s", ["items", 1.5], 9]], error: "unsafe-path" },
    { name: "unsafe-bool-segment", before: {}, ops: [["s", [true], 1]], error: "unsafe-path" },
    { name: "path-missing-key", before: { a: 1 }, ops: [["s", ["b", "c"], 1]], error: "path" },
    { name: "path-through-scalar", before: { a: { b: 1 } }, ops: [["s", ["a", "b", "c"], 1]], error: "path" },
    { name: "path-splice-on-object", before: { o: {} }, ops: [["p", ["o"], 0, 0, [1]]], error: "path" },
    // assertIndexInRange runs before the verb check: past-end deletes are
    // unsafe-path, exactly-at-end deletes are path.
    { name: "unsafe-delete-past-end", before: { items: [1] }, ops: [["d", ["items", 4]]], error: "unsafe-path" },
    { name: "path-delete-at-end", before: { items: [1] }, ops: [["d", ["items", 1]]], error: "path" },
    { name: "path-append-nonstring", before: { s: 7 }, ops: [["a", ["s"], "x"]], error: "path" },
    { name: "type-permute-not-bijection", before: { items: [1, 2] }, ops: [["m", ["items"], [1, 0, 0]]], error: "type" },
    { name: "path-permute-nonarray", before: { o: {} }, ops: [["m", ["o"], [0]]], error: "path" },
    { name: "type-empty-path-set", before: { a: 1 }, ops: [["s", [], 1]], error: "type" },
    { name: "type-bad-verb", before: {}, ops: [["q", ["a"], 1]], error: "type" },
    { name: "type-non-array-op", before: {}, ops: ["s"], error: "type" },
    { name: "type-non-verb", before: {}, ops: [[1, ["a"], 1]], error: "type" },
    // A failed op mid-batch leaves the value at its last good state…
    { name: "batch-error-midway", before: { a: 1 }, ops: [["s", ["b"], 2], ["s", ["__proto__"], 1]], error: "unsafe-path" },
    // …while a clean batch composes — this one exercises shared subtrees:
    // ops 2 and 3 touch the same copied container from different directions.
    { name: "batch-shared-subtree", before: { a: { b: { s: "x" } }, z: [0] }, ops: [["a", ["a", "b", "s"], "y"], ["s", ["a", "b", "t"], 1], ["p", ["z"], 0, 0, [9]], ["d", ["a", "b"]]], after: undefined },
  ];
  const out = cases.map((entry) => {
    if (entry.error !== undefined) {
      let thrown = "";
      try {
        applyImmutable(entry.before, entry.ops as Parameters<typeof applyImmutable>[1]);
        thrown = "<no error — the reference applied this batch>";
      } catch (error) {
        thrown = error instanceof UnsafePathError ? "unsafe-path" : error instanceof PathError ? "path" : "type";
      }
      return { name: entry.name, before: wire(entry.before), ops: wire(entry.ops), error: thrown };
    }
    return {
      name: entry.name,
      before: wire(entry.before),
      ops: wire(entry.ops),
      after: wire(applyImmutable(entry.before, entry.ops as Parameters<typeof applyImmutable>[1])),
    };
  });
  return write("delta", { cases: out });
}

// ─── Secure channel ──────────────────────────────────────────────────────────
//
// One scripted IK exchange with fixed statics and ephemerals: both message
// bytes, both hello payload texts, the handshake hash, then records in both
// directions — byte-boundary cases, a UTF-8 sequence split across records,
// the empty frame. The Rust side replays the whole transcript.

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string): Uint8Array => new Uint8Array(text.match(/../g)!.map((b) => parseInt(b, 16)));

function recordsVector(): VectorFile {
  // Deterministic key material — any valid scalars work.
  const deviceStatic = keyPairFromPrivate(unhex("11".repeat(32)));
  const deviceEphemeral = keyPairFromPrivate(unhex("22".repeat(32)));
  const hostStatic = keyPairFromPrivate(unhex("33".repeat(32)));
  const hostEphemeral = keyPairFromPrivate(unhex("44".repeat(32)));

  const pairing = { secret: "s3cr3t-pairing", name: "Test Phone" };
  const clientHelloText = new TextDecoder().decode(encodeClientHello({ v: 1, pair: pairing }));
  const hostHelloText = new TextDecoder().decode(encodeHostHello({ v: 1 }));

  const initiator = initiateIK({
    prologue: SECURE_PROLOGUE,
    static: deviceStatic,
    remoteStatic: hostStatic.publicKey,
    ephemeral: deviceEphemeral,
  });
  const responder = respondIK({ prologue: SECURE_PROLOGUE, static: hostStatic, ephemeral: hostEphemeral });

  const message1 = initiator.writeMessage1(encodeClientHello({ v: 1, pair: pairing }));
  const { payload: clientPayload, remoteStatic: seenStatic } = responder.readMessage1(message1);
  const { message: message2, result: responderResult } = responder.writeMessage2(encodeHostHello({ v: 1 }));
  const { payload: hostPayload, result: initiatorResult } = initiator.readMessage2(message2);
  const handshakeHash = initiatorResult.handshakeHash;

  const client = new SecureSession(initiatorResult);
  const server = new SecureSession(responderResult);

  // The signal prologue handshake (ADR-0033 §1): same keys, same hellos, a
  // different transcript. The Rust side replays it with SIGNAL_PROLOGUE and
  // also proves a business responder rejects it.
  const signalInitiator = initiateIK({
    prologue: SIGNAL_PROLOGUE,
    static: deviceStatic,
    remoteStatic: hostStatic.publicKey,
    ephemeral: deviceEphemeral,
  });
  const signalResponder = respondIK({ prologue: SIGNAL_PROLOGUE, static: hostStatic, ephemeral: hostEphemeral });
  const signalMessage1 = signalInitiator.writeMessage1(encodeClientHello({ v: 1 }));
  const signalOpened = signalResponder.readMessage1(signalMessage1);
  const signalMessage2 = signalResponder.writeMessage2(encodeHostHello({ v: 1 }));
  const signalRead = signalInitiator.readMessage2(signalMessage2.message);

  // Long texts to hit the record boundary: 65518 body bytes is one record,
  // 65519 splits. The multibyte case straddles a 3-byte char across the
  // split — the chunks are bytes, the decoded text is whole.
  const boundary65518 = "x".repeat(65518);
  const boundary65519 = "x".repeat(65519);
  const utf8Split = "x".repeat(65516) + "中"; // 65519 bytes: 2 of 中's bytes in record 1
  const cases = [
    { name: "empty", direction: "c2s", text: "" },
    { name: "short-frame", direction: "c2s", text: '{"type":"subscribe","stream":"tasks"}' },
    { name: "server-reply", direction: "s2c", text: '{"type":"snapshot","stream":"tasks","value":null}' },
    { name: "unicode", direction: "s2c", text: '中文 emoji 🚀 "quotes" \\' },
    { name: "boundary-65518", direction: "c2s", text: boundary65518 },
    { name: "boundary-65519", direction: "c2s", text: boundary65519 },
    { name: "utf8-split-across-records", direction: "c2s", text: utf8Split },
    { name: "multi-c2s-1", direction: "c2s", text: '{"type":"call","id":1,"method":"a","args":{}}' },
    { name: "multi-s2c-1", direction: "s2c", text: '{"type":"result","id":1,"ok":true,"value":{}}' },
    { name: "multi-c2s-2", direction: "c2s", text: '{"type":"call","id":2,"method":"b","args":{}}' },
  ].map((entry) => {
    // Seal once on this transcript — nonces advance per record, so the
    // recorded chunks are only reproducible in order.
    const sender = entry.direction === "c2s" ? client : server;
    const chunks = sender.seal(entry.text).map(hex);
    return { name: entry.name, direction: entry.direction, text: entry.text, chunks };
  });

  return write("records", {
    prologue: hex(SECURE_PROLOGUE),
    signalPrologue: hex(SIGNAL_PROLOGUE),
    signalHandshake: {
      message1: hex(signalMessage1),
      clientPayload: hex(signalOpened.payload),
      remoteStaticSeen: hex(signalOpened.remoteStatic),
      message2: hex(signalMessage2.message),
      hostPayload: hex(signalRead.payload),
      handshakeHash: hex(signalRead.result.handshakeHash),
    },
    keys: {
      deviceStatic: hex(deviceStatic.privateKey),
      deviceStaticPublic: hex(deviceStatic.publicKey),
      deviceEphemeral: hex(deviceEphemeral.privateKey),
      hostStatic: hex(hostStatic.privateKey),
      hostStaticPublic: hex(hostStatic.publicKey),
      hostEphemeral: hex(hostEphemeral.privateKey),
    },
    hellos: { client: clientHelloText, host: hostHelloText },
    message1: hex(message1),
    clientPayload: hex(clientPayload),
    remoteStaticSeen: hex(seenStatic),
    message2: hex(message2),
    hostPayload: hex(hostPayload),
    handshakeHash: hex(handshakeHash),
    records: cases,
  });
}

// ─── Endpoint sets ───────────────────────────────────────────────────────────

const relayEndpoint: HostEndpoint = {
  transport: "webSocket",
  role: "relay",
  url: "wss://relay.example.com/c/host",
};
const directEndpoint: HostEndpoint = {
  transport: "webSocket",
  role: "direct",
  url: "ws://192.168.1.5:7422/secure",
};
const endpointSet = (...endpoints: HostEndpoint[]): EndpointSet => ({
  schemaVersion: ENDPOINT_SET_SCHEMA_VERSION,
  endpoints,
});
const urlLimit = "ws://e/" + "a" + "😀".repeat((MAX_HOST_ENDPOINT_URL_LENGTH - "ws://e/".length - 1) / 2);
// Different lone surrogates normalize to the same URL, but identity and
// deduplication must keep the published UTF-16 values distinct.
const surrogateEndpointA: HostEndpoint = { ...relayEndpoint, url: "ws://example.com/\uD800" };
const surrogateEndpointB: HostEndpoint = { ...relayEndpoint, url: "ws://example.com/\uD801" };

function endpointCase(name: string, value: unknown, present = true) {
  const parsed = parseEndpointSet(value);
  return {
    name,
    present,
    value: present ? wire(value) : null,
    kind: parsed.kind,
    expect: parsed.kind === "valid" ? wire(parsed.endpointSet) : null,
  };
}

function endpointVector(): VectorFile {
  const future = { transport: "quic", role: "relay", url: "quic://relay.example.com" } as unknown as HostEndpoint;
  const cases = [
    endpointCase("absent", undefined, false),
    endpointCase("valid", endpointSet(relayEndpoint, directEndpoint)),
    endpointCase("empty", endpointSet()),
    endpointCase("deduped", endpointSet(relayEndpoint, relayEndpoint)),
    endpointCase("role-conflict", endpointSet(directEndpoint, { ...directEndpoint, role: "relay" })),
    endpointCase("surrogate-distinct-same-role", endpointSet(surrogateEndpointA, surrogateEndpointB)),
    endpointCase("surrogate-identical-deduped", endpointSet(surrogateEndpointA, surrogateEndpointA)),
    endpointCase(
      "surrogate-role-conflict",
      endpointSet(surrogateEndpointA, { ...surrogateEndpointA, role: "direct" }),
    ),
    endpointCase("unknown-transport-mixed", endpointSet(future, relayEndpoint)),
    endpointCase("unknown-transport-only", endpointSet(future)),
    endpointCase("unknown-schema", { schemaVersion: 2, endpoints: "not an array" }),
    endpointCase("missing-schema", { endpoints: [] }),
    endpointCase("malformed-shape", "set"),
    endpointCase("malformed-array", []),
    endpointCase("malformed-endpoints", { schemaVersion: 1, endpoints: null }),
    endpointCase("malformed-entry", endpointSet(null as unknown as HostEndpoint)),
    endpointCase("malformed-role", endpointSet({ ...relayEndpoint, role: "backup" } as unknown as HostEndpoint)),
    endpointCase("malformed-url", endpointSet({ ...relayEndpoint, url: "http://relay.example.com" })),
    endpointCase("url-at-limit", endpointSet({ ...directEndpoint, url: urlLimit })),
    endpointCase("url-over-limit", endpointSet({ ...directEndpoint, url: urlLimit + "a" })),
    endpointCase(
      "raw-list-over-limit",
      endpointSet(relayEndpoint, relayEndpoint, relayEndpoint, relayEndpoint, relayEndpoint),
    ),
  ];
  const params = [
    {
      name: "valid",
      text: wire(endpointSet(relayEndpoint, directEndpoint)),
      kind: "valid",
      expect: wire(endpointSet(relayEndpoint, directEndpoint)),
    },
    { name: "malformed-json", text: "{", kind: "malformed", expect: null },
    {
      name: "unknown-schema",
      text: wire({ schemaVersion: 2, endpoints: [] }),
      kind: "unsupported",
      expect: null,
    },
  ];
  return write("endpoints", {
    maxEndpoints: MAX_HOST_ENDPOINTS,
    maxUrlLength: MAX_HOST_ENDPOINT_URL_LENGTH,
    cases,
    params,
  });
}

// ─── Pairing links ───────────────────────────────────────────────────────────

function pairingVector(): VectorFile {
  const hostKey = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE"; // 32 zero-ish bytes
  const pair = `${hostKey}.s3cr3t-token_1`;
  const relayTarget = encodeURIComponent(relayEndpoint.url);
  const setParam = encodeEndpointSetParam(endpointSet(relayEndpoint, directEndpoint));
  const loopbackTarget = encodeURIComponent("ws://127.0.0.1:7420/secure");
  const malformedSet = encodeURIComponent(
    JSON.stringify({ schemaVersion: 1, endpoints: [{ transport: "webSocket", role: "backup", url: relayEndpoint.url }] }),
  );
  const unknownSchema = encodeURIComponent(JSON.stringify({ schemaVersion: 2, endpoints: [relayEndpoint] }));
  const unknownTransport = encodeURIComponent(
    JSON.stringify({ schemaVersion: 1, endpoints: [{ transport: "quic", role: "relay", url: "quic://relay" }] }),
  );
  const link = (name: string, pasted: string) => {
    const parsed = parsePairingLink(pasted);
    return {
      name,
      pasted,
      expect: pairingFragment(pasted),
      url: parsed?.url ?? null,
      endpointSet: parsed?.endpointSet ?? null,
    };
  };
  const withSet = (endpointValue: string, target = relayTarget) =>
    `pinomad://pair#pair=${pair}&url=${target}&endpointSet=${endpointValue}`;
  const links = [
    { name: "https-link", pasted: `https://omarchy/#pair=${pair}&url=wss%3A%2F%2Fomarchy%3A8443%2F`, expect: pairingFragment(`https://omarchy/#pair=${pair}&url=wss%3A%2F%2Fomarchy%3A8443%2F`), url: "wss://omarchy:8443/", endpointSet: null },
    { name: "http-link-defaults-socket", pasted: `http://192.168.1.9:4400/#pair=${pair}`, expect: pairingFragment(`http://192.168.1.9:4400/#pair=${pair}`), url: "ws://192.168.1.9:4400/", endpointSet: null },
    { name: "deep-link", pasted: `pinomad://pair#pair=${pair}&url=wss%3A%2F%2Fomarchy%3A8443%2F`, expect: pairingFragment(`pinomad://pair#pair=${pair}&url=wss%3A%2F%2Fomarchy%3A8443%2F`), url: "wss://omarchy:8443/", endpointSet: null },
    { name: "http-link-port", pasted: `http://omarchy:4400/#pair=${pair}&url=ws%3A%2F%2Fomarchy%3A4400%2F`, expect: pairingFragment(`http://omarchy:4400/#pair=${pair}&url=ws%3A%2F%2Fomarchy%3A4400%2F`), url: "ws://omarchy:4400/", endpointSet: null },
    { name: "missing-fragment", pasted: "https://omarchy/", expect: pairingFragment("https://omarchy/"), url: null, endpointSet: null },
    { name: "deep-link-missing-url", pasted: `pinomad://pair#pair=${pair}`, expect: pairingFragment(`pinomad://pair#pair=${pair}`), url: null, endpointSet: null },
    { name: "non-ws-url", pasted: `https://omarchy/#pair=${pair}&url=https%3A%2F%2Fevil%2F`, expect: pairingFragment(`https://omarchy/#pair=${pair}&url=https%3A%2F%2Fevil%2F`), url: null, endpointSet: null },
    { name: "bad-pair-shape", pasted: `https://omarchy/#pair=not.a.pair&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=not.a.pair&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "three-part-pair", pasted: `https://omarchy/#pair=a.b.c&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=a.b.c&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "empty-secret", pasted: `https://omarchy/#pair=${hostKey}.&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=${hostKey}.&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "non-b64-secret", pasted: `https://omarchy/#pair=${hostKey}.has%20space&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=${hostKey}.has%20space&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "short-key", pasted: `https://omarchy/#pair=${"QQ"}.sec&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=${"QQ"}.sec&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "non-b64-key", pasted: `https://omarchy/#pair=${"!!"}.sec&url=wss%3A%2F%2Fomarchy%2F`, expect: pairingFragment(`https://omarchy/#pair=${"!!"}.sec&url=wss%3A%2F%2Fomarchy%2F`), url: null, endpointSet: null },
    { name: "token-smuggling-field", pasted: `https://omarchy/#pair=${pair}&url=wss%3A%2F%2Fomarchy%2F&token=abc`, expect: pairingFragment(`https://omarchy/#pair=${pair}&url=wss%3A%2F%2Fomarchy%2F&token=abc`), url: "wss://omarchy/", endpointSet: null },
    { name: "garbage-url", pasted: "not a url", expect: pairingFragment("not a url"), url: null, endpointSet: null },
    { name: "javascript-scheme", pasted: `javascript:alert(1)#pair=${pair}`, expect: pairingFragment(`javascript:alert(1)#pair=${pair}`), url: null, endpointSet: null },
    link("endpoint-set", withSet(setParam)),
    link("endpoint-set-loopback-legacy", withSet(setParam, loopbackTarget)),
    link("endpoint-set-empty", withSet(encodeEndpointSetParam(endpointSet()))),
    link("endpoint-set-malformed", withSet(malformedSet)),
    link("endpoint-set-duplicate-param", withSet(`${setParam}&endpointSet=${setParam}`)),
    link("endpoint-set-unknown-schema", withSet(unknownSchema)),
    link("endpoint-set-unknown-transport", withSet(unknownTransport)),
    link("endpoint-set-deduped", withSet(encodeEndpointSetParam(endpointSet(relayEndpoint, relayEndpoint)))),
  ];
  const params = [
    { name: "valid", pair, expect: parsePairParam(pair) != null },
    { name: "two-dots", pair: `${hostKey}.a.b`, expect: parsePairParam(`${hostKey}.a.b`) != null },
    { name: "no-dot", pair: "abc", expect: parsePairParam("abc") != null },
    { name: "short-key", pair: "QQ.sec", expect: parsePairParam("QQ.sec") != null },
    { name: "empty-secret", pair: `${hostKey}.`, expect: parsePairParam(`${hostKey}.`) != null },
    { name: "bad-secret-char", pair: `${hostKey}.sec ret`, expect: parsePairParam(`${hostKey}.sec ret`) != null },
  ];
  return write("pairing", { links, params });
}

/** Every vector file, `test/fixtures/rust-vectors/<name>.json`. */
export function buildVectors(): readonly VectorFile[] {
  return [framesVector(), deltaVector(), recordsVector(), endpointVector(), pairingVector()];
}
