// Shared inputs for tool-item/tool-diff-stat/tool-target/classify: the
// vitest suites assert on these and rust-vectors.ts serializes them for the
// Rust replay — one table, no copies. A case key left out of the JSON means
// the function is called with `undefined`.
import type { PresentationType } from "@pinomad/protocol/presentation.ts";

export interface NamedCase<T> {
  readonly name: string;
  readonly input: T;
}

/** `toolTargetFromArgs` argsText strings; `undefined` input is named. */
export const TOOL_TARGET_ARGS_CASES: NamedCase<string | undefined>[] = [
  { name: "path", input: '{"path":"src/index.ts"}' },
  { name: "file_path-with-extra", input: '{"file_path":"a.ts","limit":5}' },
  { name: "command", input: '{"command":"git diff --stat"}' },
  { name: "query", input: '{"query":"astryx tokens"}' },
  { name: "missing", input: undefined },
  { name: "not-json", input: "not json" },
  { name: "no-known-key", input: '{"foo":1}' },
  { name: "non-string", input: '{"path":42}' },
  { name: "long", input: JSON.stringify({ command: "x".repeat(300) }) },
];

/** `toolTarget` on raw argument objects — protocol-level coverage incl. UTF-16 truncation. */
export const TOOL_TARGET_CASES: NamedCase<unknown>[] = [
  { name: "priority", input: { path: "p.ts", command: "ls" } },
  { name: "task", input: { task: "survey the codebase" } },
  { name: "empty-string-skipped", input: { path: "", command: "ls" } },
  { name: "non-object", input: "a string" },
  { name: "null", input: null },
  { name: "none", input: { foo: 1 } },
  // 121 UTF-16 units → truncates at 120 and appends the ellipsis.
  { name: "truncate", input: { path: "p".repeat(121) } },
  // A surrogate pair counts as two units; 60 pairs land exactly at the cap.
  { name: "truncate-pair", input: { path: "\u{1F680}".repeat(61) } },
];

export const TOOL_DISPLAY_NAME_CASES: NamedCase<string | undefined>[] = [
  { name: "mcp", input: "mcp__playwright__screenshot" },
  { name: "mcp-extra-underscore", input: "mcp__srv__a__b" },
  { name: "mcp-no-tool-sep", input: "mcp__alone" },
  { name: "plain", input: "read" },
  { name: "missing", input: undefined },
];

export const TOOL_DURATION_CASES: NamedCase<number | undefined>[] = [
  { name: "ms", input: 45 },
  { name: "ms-round", input: 999.5 },
  { name: "s", input: 3200 },
  { name: "s-60", input: 60_000 },
  // Exact half-second ties: JS toFixed picks the larger candidate, so these
  // are the cases half-to-even rounding would get wrong.
  { name: "s-tie-1.25", input: 1250 },
  { name: "s-tie-2.25", input: 2250 },
  { name: "s-tie-3.25", input: 3250 },
  { name: "missing", input: undefined },
  { name: "negative", input: -5 },
  { name: "nan", input: Number.NaN },
];

export const TOOL_NAME_CASES: NamedCase<string | undefined>[] = [
  { name: "bash", input: "bash" },
  { name: "shell", input: "shell" },
  { name: "grep", input: "grep" },
  { name: "find", input: "find" },
  { name: "web_search", input: "web_search" },
  { name: "webfetch", input: "webfetch" },
  { name: "read", input: "read" },
  { name: "read_file", input: "read_file" },
  { name: "edit", input: "edit" },
  { name: "write", input: "write" },
  { name: "case-normalized", input: "Bash" },
  { name: "hyphen-normalized", input: "web-search" },
  { name: "sleep", input: "sleep" },
  { name: "missing", input: undefined },
];

export const TOOL_KIND_SETS: NamedCase<(string | undefined)[]>[] = [
  { name: "same-kind", input: ["bash", "shell"] },
  { name: "mixed", input: ["bash", "read"] },
  { name: "generic", input: ["sleep"] },
  { name: "empty", input: [] },
];

// Pi's `edit` tool result carries the change twice: `details.patch` is a
// standard single-file unified patch (the authority), `details.diff` is Pi's
// display rendering ("+221  code", "-219  code", " 217  code", "     ...").
// write returns no details at all, so it never gets stats.
export const DIFF_STAT_CASES: NamedCase<unknown>[] = [
  {
    name: "single-hunk",
    input: {
      content: [],
      details: {
        patch: [
          "--- a/src/main.ts",
          "+++ b/src/main.ts",
          "@@ -10,4 +10,7 @@ function main() {",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
          "+const d = 5;",
          "+const e = 6;",
          " const f = 7;",
          " const g = 8;",
        ].join("\n"),
      },
    },
  },
  {
    name: "two-hunks",
    input: {
      details: {
        patch: [
          "--- a/src/main.ts",
          "+++ b/src/main.ts",
          "@@ -1,2 +1,3 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
          "@@ -20,3 +20,2 @@",
          " const x = 1;",
          "-const y = 2;",
          "-const z = 3;",
          "+const y = 20;",
        ].join("\n"),
      },
    },
  },
  {
    name: "dash-dash-line",
    // Inside a hunk the marker is only the first column, so `--- x` is a
    // deletion of the content `-- x`; outside a hunk `--- ` is a header.
    input: {
      details: {
        patch: ["--- a/src/flags.ts", "+++ b/src/flags.ts", "@@ -1,2 +1,2 @@", " const keep = 1;", "--- x", "+const flag = true;"].join("\n"),
      },
    },
  },
  {
    name: "no-newline-marker",
    input: {
      details: {
        patch: [
          "--- a/src/main.ts",
          "+++ b/src/main.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "\\ No newline at end of file",
        ].join("\n"),
      },
    },
  },
  {
    name: "missing-count",
    input: { details: { patch: ["@@ -5 +5 @@", "-a", "+b"].join("\n") } },
  },
  {
    name: "display-diff",
    input: {
      details: {
        diff: [
          " 216   export const schema = {",
          " 217   ? [",
          "-219   foo",
          "+221         validateSearch: value,",
          "+222         required: true,",
          "     ...",
          " 400   }",
        ].join("\n"),
      },
    },
  },
  {
    name: "patch-wins",
    input: {
      details: {
        patch: ["@@ -1,1 +1,2 @@", " const a = 1;", "+const b = 2;"].join("\n"),
        diff: ["+10   one", "+11   two", "+12   three", "-9   old"].join("\n"),
      },
    },
  },
  {
    name: "serialized-string",
    input: JSON.stringify({ details: { patch: ["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n") } }),
  },
  { name: "details-undefined", input: { details: undefined } },
  { name: "no-details", input: { content: [] } },
  { name: "details-empty", input: { details: {} } },
  {
    name: "context-only",
    input: { details: { patch: ["@@ -1,1 +1,1 @@", " const a = 1;"].join("\n") } },
  },
  { name: "patch-non-string", input: { details: { patch: 42 } } },
  { name: "not-json", input: "not json" },
  { name: "json-string", input: '"a json string"' },
  { name: "number", input: 42 },
  { name: "null", input: null },
];

export interface ClassifyCase {
  readonly name: string;
  readonly presentation: PresentationType | undefined;
  readonly value: unknown;
}

export const CLASSIFY_CASES: ClassifyCase[] = [
  {
    name: "todo",
    presentation: "pinomad.todo",
    value: { items: [{ text: "Ship it", status: "pending" }] },
  },
  {
    name: "question",
    presentation: "pinomad.question",
    value: {
      requests: [
        { id: "r1", askedAt: 1, questions: [{ header: "Pick one", question: "Which way?", options: [{ label: "A" }, { label: "B" }] }] },
      ],
    },
  },
  {
    name: "question-extra-fields",
    presentation: "pinomad.question",
    value: {
      requests: [
        { id: "r1", askedAt: 1, waitTask: 7, questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }] },
      ],
    },
  },
  {
    name: "diff",
    presentation: "pinomad.diff",
    value: { patch: "@@ -1 +1 @@\n-a\n+b\n", diff: {}, firstChangedLine: 1 },
  },
  { name: "diff-missing-patch", presentation: "pinomad.diff", value: { noPatch: true } },
  {
    name: "codemode",
    presentation: "pinomad.codemode",
    value: {
      code: "await tools.read({ path: 'a' })",
      calls: [
        { name: "read", args: '{"path":"a"}', status: "ok", durationMs: 12 },
        { name: "edit", args: "{}", status: "error", error: "nope", details: { patch: "--- a\n+++ b\n" } },
      ],
    },
  },
  {
    name: "codemode-upstream",
    // Upstream durable codemode writes no `code` and numbers each call.
    presentation: "pinomad.codemode",
    value: {
      calls: [
        { id: 1, name: "read", args: '{"path":"a"}', status: "ok", durationMs: 12 },
        { id: 2, name: "bash", args: "{}", status: "error", error: "nope" },
      ],
      fullOutputPath: "/tmp/out.txt",
    },
  },
  {
    name: "codemode-bad-call",
    presentation: "pinomad.codemode",
    value: { code: "x", calls: [{ name: "read" }] },
  },
  { name: "codemode-bad-code", presentation: "pinomad.codemode", value: { code: 1 } },
  { name: "todo-bad-status", presentation: "pinomad.todo", value: { items: [{ text: "Ship it", status: "unknown" }] } },
  { name: "todo-missing-field", presentation: "pinomad.todo", value: { items: [{ status: "pending" }] } },
  { name: "todo-non-object", presentation: "pinomad.todo", value: "not a todo" },
  { name: "question-malformed", presentation: "pinomad.question", value: { requests: [{ id: "r1" }] } },
  { name: "question-non-object", presentation: "pinomad.question", value: "nope" },
  { name: "no-presentation", presentation: undefined, value: { items: [{ text: "x", status: "pending" }] } },
  // A presentation string a newer host might send falls back.
  { name: "unknown-presentation", presentation: "pinomad.progress" as never, value: { requests: [] } },
  {
    name: "question-resolved",
    presentation: "pinomad.question",
    value: {
      requests: [
        {
          id: "r1",
          askedAt: 1,
          questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }],
          resolution: { outcome: "answered", at: 2, answers: [{ selected: ["a"], other: "note" }] },
        },
      ],
    },
  },
  {
    name: "question-dismissed",
    presentation: "pinomad.question",
    value: {
      requests: [{ id: "r1", askedAt: 1, questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }], resolution: { outcome: "dismissed", at: 2 } }],
    },
  },
  { name: "question-bad-resolution", presentation: "pinomad.question", value: { requests: [{ id: "r1", askedAt: 1, questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }], resolution: { outcome: "unknown", at: 2 } }] } },
  { name: "question-header-too-long", presentation: "pinomad.question", value: { requests: [{ id: "r1", askedAt: 1, questions: [{ header: "x".repeat(17), question: "q", options: [{ label: "a" }, { label: "b" }] }] }] } },
  // header counts code points, not UTF-16 units: 16 emoji fit the max.
  { name: "question-header-pair", presentation: "pinomad.question", value: { requests: [{ id: "r1", askedAt: 1, questions: [{ header: "\u{1F680}".repeat(16), question: "q", options: [{ label: "a" }, { label: "b" }] }] }] } },
];
