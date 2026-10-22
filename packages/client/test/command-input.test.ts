import { describe, expect, it } from "vitest";
import type { CommandInfo } from "@pinomad/protocol/commands.ts";
import { parseCommandInput, type CommandInput } from "../src/command-input.ts";
import { COMMAND_INPUT_CASES } from "./command-input-cases.ts";

// The expected results for the shared case table (issue #254) — kept here
// because the same table feeds the Rust comparison vectors.
const EXPECTED: Record<string, CommandInput | undefined> = {
  bare: { name: "compact" },
  "with-args": { name: "compact", args: "keep API notes" },
  "args-trimmed": { name: "compact", args: "keep API notes" },
  "trailing-space-only": { name: "compact" },
  "multiline-args": { name: "compact", args: "keep API notes\nand the plan" },
  "tab-separator": { name: "compact", args: "notes" },
  "nbsp-separator": { name: "compact", args: "notes" },
  "ideographic-separator": { name: "compact", args: "保留接口说明" },
  "bom-follower": undefined,
  "bom-in-args": { name: "compact", args: "﻿notes﻿" },
  "leading-space": undefined,
  "mid-text": undefined,
  unknown: undefined,
  "glued-suffix": undefined,
  "punctuation-suffix": undefined,
  "case-sensitive": undefined,
  path: undefined,
  "slash-only": undefined,
  "slash-space": undefined,
  "double-slash": undefined,
  empty: undefined,
  "no-commands": undefined,
  "longer-name": { name: "compact-all", args: "now" },
  "emoji-args": { name: "compact", args: "😀 keep" },
};

describe("parseCommandInput", () => {
  it("covers every shared case", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(COMMAND_INPUT_CASES.map((c) => c.name).sort());
  });

  for (const c of COMMAND_INPUT_CASES) {
    it(c.name, () => {
      const commands = c.names.map((name) => ({ name }));
      expect(parseCommandInput(c.text, commands)).toEqual(EXPECTED[c.name]);
    });
  }

  it("still parses a disabled command — the UI decides what to do with it", () => {
    const commands: readonly CommandInfo[] = [{ name: "compact", description: "", source: "builtin", disabled: "Busy" }];
    expect(parseCommandInput("/compact", commands)).toEqual({ name: "compact" });
  });
});
