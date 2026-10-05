// Built-in extension (ADR-0004): the model's working todo list as a rewindable
// conversation document. The doc kind is extension-owned and deliberately
// differs from the presentation type it renders as.
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { TodoItemSchema, type TodoState } from "@pinomad/protocol/presentation.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";

const TodoDoc = defineDoc<TodoState>({
  kind: "todo.list",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
});

const todoWrite = defineTool({
  name: "todo_write",
  description: "Replace the todo list shown to the user with the given items.",
  parameters: Type.Object({ items: Type.Array(TodoItemSchema) }),
  // The whole list is rewritten in one commit, so rerunning after a crash is safe.
  replay: "safe",
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      const doc = await tx.doc(TodoDoc, api.conversationId);
      doc.items = args.items.map((item) => ({ ...item }));
    }, context);
    return { content: [{ type: "text", text: `Todo list updated: ${args.items.length} item(s).` }] };
  },
});

export const todo: BuiltinExtension = {
  extension: defineExtension({ name: "todo", tools: [todoWrite] }),
  docs: [{ token: TodoDoc, presentation: "pinomad.todo" }],
};
