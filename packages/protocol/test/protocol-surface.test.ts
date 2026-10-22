// Keeps the append-only protocol surface history honest (issue #165,
// ADR-0018). Re-record only after bumping PROTOCOL:
// PINOMAD_UPDATE_SURFACE=1 bunx vitest run --project protocol protocol-surface
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractProtocolSurface,
  hashSurface,
  recordSurface,
  stableStringify,
  SURFACE_PATH,
  validateHistory,
  type ProtocolSurfaceArchive,
  type ProtocolSurfaceEntry,
  type ProtocolSurfaceHistory,
  type ProtocolSurfaceRecord,
} from "./protocol-surface.ts";

interface MutableRecord {
  protocol: { major: number; minor: number };
  calls: string[];
  streams: string[];
  gates: { call: Record<string, number>; stream: Record<string, number>; feature: Record<string, number> };
  surface: Record<string, string>;
}

const sourcePath = (file: string): string => fileURLToPath(new URL("../src/" + file, import.meta.url));

async function loadHistory(): Promise<ProtocolSurfaceHistory> {
  try {
    return JSON.parse(await readFile(SURFACE_PATH, "utf8")) as ProtocolSurfaceHistory;
  } catch {
    return { history: [] };
  }
}

function latest(history: ProtocolSurfaceHistory): ProtocolSurfaceEntry {
  const record = history.history.at(-1);
  if (record === undefined || !("surface" in record)) {
    throw new Error("protocol surface history is empty; run with PINOMAD_UPDATE_SURFACE=1 first");
  }
  return record;
}

function mutableLatest(history: ProtocolSurfaceHistory): MutableRecord {
  return structuredClone(latest(history)) as MutableRecord;
}

/** Compact the previous last record, then append a candidate for validation-only tests. */
function append(history: ProtocolSurfaceHistory, next: ProtocolSurfaceEntry): ProtocolSurfaceRecord[] {
  const records = [...history.history];
  const last = records.at(-1);
  if (last !== undefined && "surface" in last) {
    const { surface, ...base } = last;
    records[records.length - 1] = { ...base, surfaceHash: hashSurface(surface) };
  }
  return [...records, next];
}

/** Extract with one source file replaced in memory; src itself is never touched. */
function extractWith(file: string, mutate: (source: string) => string): ProtocolSurfaceEntry {
  const path = sourcePath(file);
  const original = readFileSync(path, "utf8");
  const changed = mutate(original);
  expect(changed, file + " mutation did not apply").not.toBe(original);
  return extractProtocolSurface({ sources: new Map([[path, changed]]) });
}

let baseline: ProtocolSurfaceEntry | undefined;
const surfaceBaseline = (): ProtocolSurfaceEntry => (baseline ??= extractProtocolSurface());

describe("protocol surface", () => {
  it("records or matches the committed append-only history", async () => {
    const history = await loadHistory();
    const current = extractProtocolSurface();
    if (process.env.PINOMAD_UPDATE_SURFACE === "1") {
      const next = recordSurface(history, current);
      if (stableStringify(next) !== stableStringify(history)) {
        await mkdir(dirname(SURFACE_PATH), { recursive: true });
        await writeFile(SURFACE_PATH, stableStringify(next));
      }
      return;
    }
    validateHistory(history.history);
    expect(latest(history)).toEqual(current);
  });

  it("does not append when the version and surface are unchanged", async () => {
    const history = await loadHistory();
    const next = recordSurface(history, extractProtocolSurface());
    expect(next.history).toHaveLength(history.history.length);
    expect(stableStringify(next)).toBe(stableStringify(history));
  });

  it("appends one record when the version moved and hashes the previous surface", async () => {
    const history = await loadHistory();
    const bumped = mutableLatest(history);
    bumped.protocol.minor += 1;
    const next = recordSurface(history, bumped);
    expect(next.history).toHaveLength(history.history.length + 1);
    expect(next.history.at(-1)!.protocol.minor).toBe(bumped.protocol.minor);
    const previous = next.history.at(-2)!;
    expect("surface" in previous).toBe(false);
    expect((previous as ProtocolSurfaceArchive).surfaceHash).toBe(hashSurface(bumped.surface));
  });

  it("keeps the full surface only on the newest record", async () => {
    const history = await loadHistory();
    const current = extractProtocolSurface();
    const { major, minor } = current.protocol;
    const first = { ...structuredClone(current), protocol: { major, minor: minor + 1 } };
    const second = { ...structuredClone(current), protocol: { major, minor: minor + 2 } };
    const afterFirst = recordSurface(history, first);
    expect("surface" in afterFirst.history.at(-1)!).toBe(true);
    const afterSecond = recordSurface(afterFirst, second);
    expect(afterSecond.history).toHaveLength(history.history.length + 2);
    for (const record of afterSecond.history.slice(0, -1)) {
      expect("surface" in record).toBe(false);
      expect("surfaceHash" in record).toBe(true);
    }
    // The current record and the first appended one both archive today's surface.
    for (const record of afterSecond.history.slice(-3, -1)) {
      expect((record as ProtocolSurfaceArchive).surfaceHash).toBe(hashSurface(current.surface));
    }
    const last = afterSecond.history.at(-1)!;
    expect("surface" in last).toBe(true);
    expect((last as ProtocolSurfaceEntry).surface).toEqual(current.surface);
  });

  it("refuses a changed surface when PROTOCOL was not bumped", async () => {
    const history = await loadHistory();
    const changed = extractWith("presentation.ts", (source) =>
      source.replace("text: Type.String({ minLength: 1 })", "text: Type.Number()"),
    );
    expect(() => recordSurface(history, changed)).toThrow(/PROTOCOL was not bumped/);
  });

  it("changes the snapshot when a nested schema field changes", () => {
    const before = surfaceBaseline();
    const after = extractWith("presentation.ts", (source) =>
      source.replace("text: Type.String({ minLength: 1 })", "text: Type.Number()"),
    );
    expect(after.surface.TodoItemSchema).not.toEqual(before.surface.TodoItemSchema);
    expect(after.surface).not.toEqual(before.surface);
  });

  it("ignores property order", () => {
    const before = surfaceBaseline();
    const after = extractWith("presentation.ts", (source) => {
      const text = '  text: Type.String({ minLength: 1 }),';
      const status = '  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),';
      return source.replace(text + "\n" + status, status + "\n" + text);
    });
    expect(after.surface).toEqual(before.surface);
  });

  it("ignores union member order", () => {
    const before = surfaceBaseline();
    const typebox = extractWith("presentation.ts", (source) =>
      source.replace(
        'Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")])',
        'Type.Union([Type.Literal("completed"), Type.Literal("pending"), Type.Literal("in_progress")])',
      ),
    );
    expect(typebox.surface).toEqual(before.surface);
    const typescript = extractWith("presentation.ts", (source) =>
      source.replace(
        'export type PresentationType = "pinomad.todo" | "pinomad.question" | "pinomad.diff" | "pinomad.codemode";',
        'export type PresentationType = "pinomad.codemode" | "pinomad.diff" | "pinomad.question" | "pinomad.todo";',
      ),
    );
    expect(typescript.surface).toEqual(before.surface);
  });

  it("ignores readonly modifiers", () => {
    const before = surfaceBaseline();
    const after = extractWith("organization.ts", (source) =>
      source.replace(
        "  readonly path: string;\n  readonly name: string;\n  readonly addedAt: number;",
        "  path: string;\n  name: string;\n  addedAt: number;",
      ),
    );
    expect(after.surface).toEqual(before.surface);
  });

  it("ignores client-only API changes in view.ts", () => {
    const before = surfaceBaseline();
    const after = extractWith("view.ts", (source) =>
      source.replace(/\n}\n$/, "\n  extraClientMethod(): void;\n}\n"),
    );
    expect(after.surface).toEqual(before.surface);
  });

  it("ignores comments", () => {
    const before = surfaceBaseline();
    const after = extractWith("presentation.ts", (source) =>
      source.replace("// ADR-0005: the runtime-schematized", "// This comment changed without changing the wire."),
    );
    expect(after.surface).toEqual(before.surface);
  });

  it("removes calls only on a major bump", async () => {
    const history = await loadHistory();
    const record = mutableLatest(history);
    record.protocol.minor += 1;
    const removed = record.calls[0]!;
    record.calls = record.calls.filter((name) => name !== removed);
    delete record.gates.call[removed];
    expect(() => validateHistory(append(history, record))).toThrow("call " + removed + " was removed");

    const major = mutableLatest(history);
    major.protocol = { major: 6, minor: 0 };
    major.calls = major.calls.slice(0, 5);
    for (const name of Object.keys(major.gates.call)) {
      if (!major.calls.includes(name)) delete major.gates.call[name];
    }
    for (const name of major.calls) major.gates.call[name] = 0;
    major.streams = [];
    major.gates.stream = {};
    major.gates.feature = {};
    expect(() => validateHistory(append(history, major))).not.toThrow();
  });

  it("removes host streams only on a major bump", async () => {
    const history = await loadHistory();
    const record = mutableLatest(history);
    record.protocol.minor += 1;
    const removed = record.streams[0]!;
    record.streams = record.streams.filter((name) => name !== removed);
    delete record.gates.stream[removed];
    expect(() => validateHistory(append(history, record))).toThrow("host stream " + removed + " was removed");
  });

  it("changes existing gates only on a major bump", async () => {
    const history = await loadHistory();
    const record = mutableLatest(history);
    record.protocol.minor += 1;
    record.gates.call.listFiles = 11;
    expect(() => validateHistory(append(history, record))).toThrow("call gate listFiles changed from 10 to 11");

    const major = mutableLatest(history);
    major.protocol = { major: 6, minor: 0 };
    for (const name of Object.keys(major.gates.call)) major.gates.call[name] = 0;
    for (const name of Object.keys(major.gates.stream)) major.gates.stream[name] = 0;
    for (const name of Object.keys(major.gates.feature)) major.gates.feature[name] = 0;
    expect(() => validateHistory(append(history, major))).not.toThrow();
  });

  it("requires a new gate to land after the previous minor", async () => {
    const history = await loadHistory();
    const record = mutableLatest(history);
    const { major, minor } = record.protocol;
    record.protocol.minor += 1;
    record.calls.push("futureCall");
    record.calls.sort();
    record.gates.call.futureCall = record.protocol.minor - 1;
    expect(() => validateHistory(append(history, record))).toThrow(`must be greater than ${major}.${minor}`);

    const later = mutableLatest(history);
    later.protocol.minor += 1;
    later.calls.push("futureCall");
    later.calls.sort();
    later.gates.call.futureCall = later.protocol.minor;
    expect(() => validateHistory(append(history, later))).not.toThrow();
  });

  it("refuses two records at the same protocol version", async () => {
    const history = await loadHistory();
    const duplicate = mutableLatest(history);
    expect(() => validateHistory(append(history, duplicate))).toThrow(/does not increase/);
  });

  it("refuses a minor rollback and an unreset major bump", async () => {
    const history = await loadHistory();
    const rollback = mutableLatest(history);
    rollback.protocol.minor -= 1;
    for (const name of Object.keys(rollback.gates.call)) rollback.gates.call[name] = Math.min(rollback.gates.call[name]!, rollback.protocol.minor);
    for (const name of Object.keys(rollback.gates.stream)) rollback.gates.stream[name] = Math.min(rollback.gates.stream[name]!, rollback.protocol.minor);
    for (const name of Object.keys(rollback.gates.feature)) rollback.gates.feature[name] = Math.min(rollback.gates.feature[name]!, rollback.protocol.minor);
    expect(() => validateHistory(append(history, rollback))).toThrow(/does not increase/);

    const major = mutableLatest(history);
    major.protocol = { major: 6, minor: 1 };
    for (const name of Object.keys(major.gates.call)) major.gates.call[name] = 0;
    for (const name of Object.keys(major.gates.stream)) major.gates.stream[name] = 0;
    for (const name of Object.keys(major.gates.feature)) major.gates.feature[name] = 0;
    expect(() => validateHistory(append(history, major))).toThrow(/must reset minor to 0/);
  });

  it("keeps every gate at or below the current minor", async () => {
    const history = await loadHistory();
    const record = mutableLatest(history);
    record.gates.call.listFiles = record.protocol.minor + 1;
    expect(() => validateHistory(append(history, record))).toThrow(/exceeds protocol/);
  });
});
