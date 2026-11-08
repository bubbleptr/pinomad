// Built-in extension (ADR-0004, ADR-0045): the model's four background-process
// tools. The runtime is injected — this file never imports the gateway or a
// pty — so the extension only describes calls and results.
import { randomUUID } from "node:crypto";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { processStatusText } from "@pinomad/client/processes.ts";
import type { ProcessInfo, ProcessState } from "@pinomad/protocol/processes.ts";
import type { BuiltinExtension } from "../builtin-extension.ts";
import { ProcessDoc } from "../process-doc.ts";
import type { ProcessRuntime } from "../processes.ts";

const ID = Type.String({ minLength: 1, description: "The process id returned by process_start." });

/** The extension depends only on this injected runtime (ADR-0004). */
export function createProcesses(options: { readonly runtime?: ProcessRuntime }): BuiltinExtension {
  const { runtime } = options;
  // Without a pty the document stays available (the historical list and the
  // presentation), but no tool is registered (ADR-0045 §2).
  if (runtime === undefined) {
    return {
      extension: defineExtension({ name: "processes", tools: [] }),
      docs: [{ token: ProcessDoc, presentation: "pinomad.processes" }],
    };
  }

  const start = defineTool({
    name: "process_start",
    callers: ["model"],
    description:
      "Start a long-running command in the background and return its id. The command runs in your conversation's working directory under a pty, so dev servers and monitors keep running after the call returns. " +
      "It cannot receive input. Use process_output to read it, process_stop to end it, and process_list to recover ids after a context reset. " +
      "The host keeps at most 8 unfinished processes per conversation family. Write monitors as commands that exit when the event happens (for example a one-shot grep) so the exit report wakes you; line-by-line callbacks are not supported.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command; it is run with the login shell's -c." }),
      name: Type.Optional(Type.String({ description: "Short label for lists, e.g. \"dev server\". Defaults to the command's first line." })),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      const agent = await api.agent(context);
      const cwd = agent.cwd;
      if (cwd === undefined) throw new Error("This conversation has no working directory");
      const name = cleanName(args.name) ?? defaultName(args.command);
      // Record the id before any process starts: a replay of this exact call
      // must return the same id instead of starting a second process.
      const memo = await api.memo("process.start", { id: randomUUID(), name }, context);
      const process = await runtime.start({
        conversationId: api.conversationId,
        command: args.command,
        name: memo.name,
        cwd,
        id: memo.id,
      }, context);
      return result(processResult("Started", process), { id: process.id, name: process.name });
    },
  });

  const output = defineTool({
    name: "process_output",
    callers: ["model"],
    description:
      "Read a background process's output after a raw character position. Omit \"since\" for the retained output; pass the previous result's \"next\" to read only what is new. " +
      "Returns at most 16 KiB of text with ANSI escapes removed; \"next\" stays a raw output position. \"truncated\" is true when the start of the retained output was already dropped. " +
      "If the process ended, status and exitCode say how; output may be unavailable after it falls out of history or the host restarts.",
    parameters: Type.Object({
      id: ID,
      since: Type.Optional(Type.Integer({ minimum: 0, description: "The previous result's next position." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const value = await runtime.output({
        conversationId: api.conversationId,
        id: args.id,
        ...(args.since === undefined ? {} : { since: args.since }),
      }, context);
      const heading = statusLine(value.status);
      const body = value.released === true
        ? "Output is no longer available."
        : value.text === "" ? "(no new output)" : value.text;
      const truncated = value.truncated && value.released !== true
        ? "\n(the beginning of the retained output was truncated)"
        : "";
      return result(`${heading}\n${body}${truncated}`, value);
    },
  });

  const stop = defineTool({
    name: "process_stop",
    callers: ["model"],
    description:
      "Stop a background process and wait until it has exited. The host sends SIGTERM to the whole process group, then SIGKILL after 5 seconds. " +
      "A process that exits after this call is treated as stopped, so it will not report back to you; the result carries its final state. Stopping an already ended process returns that state.",
    parameters: Type.Object({ id: ID }),
    replay: "safe",
    execute: async (args, api, context) => {
      const process = await runtime.stop({
        conversationId: api.conversationId,
        id: args.id,
        reason: "agent",
      }, context);
      return result(processResult("Stopped", process), { state: process.state });
    },
  });

  const list = defineTool({
    name: "process_list",
    callers: ["model"],
    description:
      "List this conversation family's background processes, running and recently ended, with ids and states. Use it to recover ids after a context reset. Output and stop work only while the host still has the process's pty.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const processes = await runtime.list(api.conversationId, context);
      const text =
        processes.length === 0
          ? "No background processes."
          : processes.map((process) => `${process.id}  ${process.name}  [${statusLine(process.state)}]  ${process.command}`).join("\n");
      return result(text, { processes });
    },
  });

  return {
    extension: defineExtension({ name: "processes", tools: [start, output, stop, list] }),
    docs: [{ token: ProcessDoc, presentation: "pinomad.processes" }],
  };
}

function result(text: string, details: unknown): ToolExecutionResult {
  return { output: [{ type: "text", text }], details: details as never };
}

function processResult(verb: string, process: ProcessInfo): string {
  return `${verb} ${process.name} (${process.id}): ${statusLine(process.state)}`;
}

function statusLine(state: ProcessState): string {
  return processStatusText(state);
}

function cleanName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function defaultName(command: string): string {
  const line = command.trim().split("\n", 1)[0]!.trim();
  if (line === "") return "Background process";
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}
