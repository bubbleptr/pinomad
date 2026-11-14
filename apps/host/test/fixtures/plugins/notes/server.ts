// Test fixture plugin (ADR-0049): a shared note board and a host-only counter.
import { definePlugin } from "@pinomad/plugin/v1";

export default definePlugin((pinomad) => {
  const board = pinomad.state("board", { version: 1, initial: () => ({ notes: [] as string[] }) });
  const writes = pinomad.state("writes", { version: 1, shared: false, initial: () => ({ count: 0 }) });

  pinomad.tool({
    name: "notes_add",
    description: "Add a note to the board.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async (args, ctx) => {
      await ctx.change(async (tx) => {
        (await tx.get(board)).notes.push(String(args.text));
        (await tx.get(writes)).count += 1;
      });
      return { text: `Added note ${(await ctx.read(board)).notes.length}` };
    },
  });

  pinomad.tool({
    name: "notes_fail",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new Error("notes tool failed");
    },
  });

  pinomad.method("add", async (args, ctx) => {
    await ctx.change(async (tx) => {
      (await tx.get(board)).notes.push(String(args));
      (await tx.get(writes)).count += 1;
    });
    return { writes: (await ctx.read(writes)).count };
  });

  pinomad.method("fail", async () => {
    throw new Error("plugin method failed");
  });
});
