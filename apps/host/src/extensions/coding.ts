import type { Context } from "@earendil-works/chord";
import { type ToolExecutionApi, wrapTool } from "@earendil-works/pi-durable";
import { CodingTools, createWriteTool, type WriteToolInput } from "@earendil-works/pi-durable/tools";
import { createPatch } from "diff";
import type { BuiltinExtension } from "../builtin-extension.ts";

// `write` ships no details; wrap it so the result carries a unified patch of
// the file's before/after, the same story `edit` tells (ADR-0005). The old
// content is read through the conversation's own env and path resolution —
// a missing file counts as empty. The text result is untouched.
const writeWithDiff = wrapTool(createWriteTool(), (tool) => ({
  ...tool,
  execute: async (args: WriteToolInput, api: ToolExecutionApi, context: Context) => {
    let oldContent = "";
    const absolute = await api.env?.absolutePath(args.path, context);
    if (absolute?.ok === true) {
      const old = await api.env!.readTextFile(absolute.value, context);
      if (old.ok) oldContent = old.value;
    }
    const result = await tool.execute(args, api, context);
    // The patch is named by the path the agent asked for — what the transcript says.
    return { ...result, details: { patch: createPatch(args.path, oldContent, args.content) } };
  },
}));

// Durable's read/write/edit/bash bundle; runs directly against the conversation env, no approval gate.
export const coding: BuiltinExtension = {
  extension: { ...CodingTools, wraps: [writeWithDiff] },
  tools: { edit: "pinomad.diff", write: "pinomad.diff" },
};
