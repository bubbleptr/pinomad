// Shared inputs for `parseCommandInput` (issue #254): a command is recognized
// only at index 0, as `/<listed name>` followed by the end of the text or
// Unicode whitespace. The vitest suite and packages/client/test/rust-vectors.ts
// both consume this table, so the Rust `parse_command_input` replays the same
// cases.
export const COMMAND_INPUT_CASES: readonly {
  readonly name: string;
  readonly text: string;
  readonly names: readonly string[];
}[] = [
  { name: "bare", text: "/compact", names: ["compact"] },
  { name: "with-args", text: "/compact keep API notes", names: ["compact"] },
  // The rest is trimmed on both ends; whitespace-only args are no args.
  { name: "args-trimmed", text: "/compact   keep API notes  \n", names: ["compact"] },
  { name: "trailing-space-only", text: "/compact   ", names: ["compact"] },
  { name: "multiline-args", text: "/compact\n\nkeep API notes\nand the plan", names: ["compact"] },
  // Any Unicode whitespace separates — tab, NBSP, ideographic space.
  { name: "tab-separator", text: "/compact\tnotes", names: ["compact"] },
  { name: "nbsp-separator", text: "/compact\u00A0notes", names: ["compact"] },
  { name: "ideographic-separator", text: "/compact\u3000保留接口说明", names: ["compact"] },
  // U+FEFF is not White_Space: it glues to the name, and it is not trimmed
  // from args (String.prototype.trim would strip it — the rule doesn't).
  { name: "bom-follower", text: "/compact﻿", names: ["compact"] },
  { name: "bom-in-args", text: "/compact ﻿notes﻿", names: ["compact"] },
  // Only at index 0: leading whitespace or text before it is a message.
  { name: "leading-space", text: " /compact", names: ["compact"] },
  { name: "mid-text", text: "hello /compact", names: ["compact"] },
  // The name must be listed exactly, case-sensitive, and end at whitespace.
  { name: "unknown", text: "/foo bar", names: ["compact"] },
  { name: "glued-suffix", text: "/compactX", names: ["compact"] },
  { name: "punctuation-suffix", text: "/compact.", names: ["compact"] },
  { name: "case-sensitive", text: "/Compact", names: ["compact"] },
  { name: "path", text: "/usr/bin/x", names: ["compact", "usr"] },
  { name: "slash-only", text: "/", names: ["compact"] },
  { name: "slash-space", text: "/ compact", names: ["compact"] },
  { name: "double-slash", text: "//compact", names: ["compact"] },
  { name: "empty", text: "", names: ["compact"] },
  { name: "no-commands", text: "/compact", names: [] },
  // Picks the listed name the token spells, not a prefix of it.
  { name: "longer-name", text: "/compact-all now", names: ["compact", "compact-all"] },
  // Astral text in args survives intact.
  { name: "emoji-args", text: "/compact 😀 keep", names: ["compact"] },
];
