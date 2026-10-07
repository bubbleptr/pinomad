// codemode extension (ADR-0013): one `codemode` tool runs a JavaScript script
// in a QuickJS sandbox; inside it `tools.<name>(args)` reaches the agent's
// offered tools (minus model-only ones) plus the host's script-tool catalog
// (MCP `codemode`-exposed tools). Nested calls never create tool tasks or enter
// the transcript — the card shows them from the result's details instead.
import { withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  CodemodeSandbox,
  CodemodeSourceError,
  type CodemodeOutputItem,
  type CodemodeTool,
  loadQuickJSWasm,
  parseCodemodeSource,
  renderToolSignature,
} from "@earendil-works/pi-codemode";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PresentationType } from "@pinomad/protocol/presentation.ts";
import { Type } from "typebox";
import type { BuiltinExtension } from "../builtin-extension.ts";
import type { ScriptNamespace, ScriptTool } from "../script-tools.ts";

// The wasm module is shared across calls; load it once per process.
const wasm = loadQuickJSWasm();

/** Nested output() buffer: first and last 512 KiB survive a flood. */
const OUTPUT_CAP = 1024 * 1024;
const OUTPUT_HALF = OUTPUT_CAP / 2;

class NestedOutput {
  #head = "";
  #tail = "";
  #dropped = 0;
  readonly #decoder = new TextDecoder();

  push(chunk: string | Uint8Array): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (this.#dropped === 0 && this.#head.length + text.length <= OUTPUT_CAP) {
      this.#head += text;
      return;
    }
    if (this.#dropped === 0) {
      // First overflow: the head keeps its first half, the rest joins the tail.
      const rest = this.#head.slice(OUTPUT_HALF) + text;
      this.#head = this.#head.slice(0, OUTPUT_HALF);
      this.#dropped = Math.max(0, rest.length - OUTPUT_HALF);
      this.#tail = rest.slice(-OUTPUT_HALF);
      return;
    }
    const merged = this.#tail + text;
    this.#dropped += Math.max(0, merged.length - OUTPUT_HALF);
    this.#tail = merged.slice(-OUTPUT_HALF);
  }

  text(): string {
    const tail = this.#tail + this.#decoder.decode();
    return this.#dropped === 0
      ? this.#head + tail
      : `${this.#head}\n[... ${this.#dropped} characters omitted ...]\n${tail}`;
  }
}

type NestedRecord = {
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  details?: JsonValue;
};

const summarizeArgs = (args: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "null";
  } catch {
    text = String(args);
  }
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A callable's resolved value handed back to the script. */
type Callable =
  | { readonly kind: "agent"; readonly tool: ToolRegistration }
  | { readonly kind: "script"; readonly tool: ScriptTool };

const textOf = (content: ToolResultMessage["content"]): string =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const TOKENIZE = /[^a-z0-9]+/;
const tokens = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(TOKENIZE)
    .filter(Boolean);

/** BM25 over tool name + description + namespace text — enough ranking for a few hundred tools. */
function search(callables: Iterable<{ name: string; description: string; namespace?: ScriptNamespace }>, query: string, limit: number, namespace?: string) {
  const docs = [...callables]
    .filter((tool) => namespace === undefined || tool.namespace?.name === namespace)
    .map((tool) => {
      const text = [tool.name, tool.description, tool.namespace?.name, tool.namespace?.description].filter(Boolean).join(" ");
      return { tool, terms: tokens(text) };
    });
  const avgLength = docs.length === 0 ? 1 : docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length;
  const frequency = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const scored = docs.map((doc) => {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of tokens(query)) {
      const df = frequency.get(term);
      if (df === undefined) continue;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const tf = counts.get(term) ?? 0;
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * doc.terms.length) / avgLength));
    }
    return { tool: doc.tool, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      name: entry.tool.name,
      description: entry.tool.description.length <= 300 ? entry.tool.description : `${entry.tool.description.slice(0, 299)}…`,
    }));
}

export function createCodemode(options: {
  /** Live catalog of script-only tools — read per call so late MCP connections are visible. */
  readonly scriptTools: () => readonly ScriptTool[];
  /** Offered tool names scripts must not call (plus `codemode`, added here). */
  readonly modelOnly: readonly string[];
  /** Tool name → declared presentation; decides which nested `details` are kept. */
  readonly presentations: Readonly<Record<string, PresentationType>>;
}): BuiltinExtension {
  const excluded = new Set([...options.modelOnly, "codemode"]);
  const modelOnlyList = [...excluded].join(", ");

  const tool = defineTool({
    name: "codemode",
    description: DESCRIPTION.replace("{MODEL_ONLY}", modelOnlyList),
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: "Raw JavaScript source; see the tool description." }),
    }),
    execute: async (args, api, context) => {
      let parsed;
      try {
        parsed = parseCodemodeSource(args.code);
      } catch (error) {
        if (error instanceof CodemodeSourceError) {
          return { content: [{ type: "text", text: `Script failed: ${error.message}` }], isError: true };
        }
        throw error;
      }

      const agent = await api.agent(context);
      const callables = new Map<string, Callable>();
      for (const offered of agent.tools) {
        if (!excluded.has(offered.name)) callables.set(offered.name, { kind: "agent", tool: offered });
      }
      // Script tools win name clashes so a `direct` MCP tool still resolves to CallToolResult.
      for (const scriptTool of options.scriptTools()) callables.set(scriptTool.name, { kind: "script", tool: scriptTool });

      const calls: NestedRecord[] = [];
      // Nested details kept on the card are bounded: 64 KiB each, 512 KiB total.
      let detailsBudget = 512 * 1024;
      // The wire shape is `pinomad.codemode` (protocol); locally it must stay JsonValue.
      const snapshot = (): { code: string; calls: NestedRecord[] } => ({
        code: parsed.code,
        calls: calls.map((call) => ({ ...call })),
      });
      const publish = (): void => {
        void api.details(snapshot(), context).catch(() => {});
      };

      const executeNested = async (name: string, callArgs: unknown, signal: AbortSignal): Promise<unknown> => {
        const record: NestedRecord = { name, args: summarizeArgs(callArgs), status: "running" };
        calls.push(record);
        publish();
        const started = Date.now();
        try {
          const callable = callables.get(name);
          if (callable === undefined) throw new Error(`Unknown tool "${name}"`);
          const value =
            callable.kind === "script"
              ? await callable.tool.call(callArgs, signal)
              : await runAgentTool(callable.tool, callArgs, signal, record, calls.length - 1);
          record.status = signal.aborted ? "cancelled" : "ok";
          return value;
        } catch (error) {
          record.status = signal.aborted ? "cancelled" : "error";
          record.error = errorText(error).slice(0, 500);
          throw error;
        } finally {
          record.durationMs = Date.now() - started;
          publish();
        }
      };

      const runAgentTool = async (
        offered: ToolRegistration,
        callArgs: unknown,
        signal: AbortSignal,
        record: NestedRecord,
        index: number,
      ): Promise<unknown> => {
        const prepared = offered.prepareArguments === undefined ? callArgs : offered.prepareArguments(callArgs);
        const validated = validateToolArguments(offered, {
          type: "toolCall",
          id: `${api.callId}/${index}`,
          name: offered.name,
          arguments: prepared,
        } as never);
        const output = new NestedOutput();
        const diagnostics: string[] = [];
        let reported: unknown;
        const derived: ToolExecutionApi = {
          ...api,
          callId: `${api.callId}/${index}`,
          output: (chunk) => output.push(chunk),
          // The buffer transforms text, so no tail window may leak untruncated output past it.
          outputWindow: undefined,
          diagnostic: (diagnostic) => diagnostics.push(`[${diagnostic.severity}] ${diagnostic.message}`),
          details: async (value) => {
            reported = value;
          },
        };
        let result;
        try {
          result = await offered.execute(validated, derived, withAbortSignal(signal, context));
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(`${[output.text(), errorText(error)].filter(Boolean).join("\n")}`.trim());
        }
        const captured = result.details ?? reported;
        if (captured !== undefined && options.presentations[offered.name] !== undefined) {
          try {
            const size = JSON.stringify(captured).length;
            if (size <= 64 * 1024 && detailsBudget >= size) {
              detailsBudget -= size;
              record.details = captured as JsonValue;
            }
          } catch {
            // Unserializable details are skipped; the summary row still lands.
          }
        }
        const collected = [output.text(), ...diagnostics].filter(Boolean).join("\n");
        const content = result.content ?? [{ type: "text", text: collected }];
        if (result.isError === true) throw new Error(textOf(content) || collected);
        const texts = content.filter((block) => block.type === "text");
        return texts.length === content.length ? texts.map((block) => block.text).join("") : content;
      };

      const globals: CodemodeTool[] = [
        {
          name: "searchTools",
          spread: true,
          description: "Search callable tools by relevance.",
          execute: (callArgs) => {
            const [query, opts] = callArgs as [string, { limit?: number; namespace?: string }?];
            return search(
              [...callables.values()].map((callable) =>
                callable.kind === "script"
                  ? { name: callable.tool.name, description: callable.tool.description, namespace: callable.tool.namespace }
                  : { name: callable.tool.name, description: callable.tool.description ?? "", namespace: undefined },
              ),
              String(query ?? ""),
              typeof opts?.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 8,
              opts?.namespace,
            );
          },
        },
        {
          name: "describeTool",
          description: "The declaration of one callable tool, or undefined.",
          execute: (callArgs) => {
            const callable = callables.get(String(callArgs));
            if (callable === undefined) return undefined;
            return {
              name: callable.tool.name,
              description: callable.tool.description,
              declaration: renderToolSignature(
                callable.kind === "script"
                  ? { name: callable.tool.name, inputSchema: callable.tool.inputSchema, outputSchema: callable.tool.outputSchema }
                  : { name: callable.tool.name, inputSchema: callable.tool.parameters as Record<string, unknown> },
              ),
            };
          },
        },
        {
          name: "describeNamespace",
          description: "The tools of one script-only namespace, or undefined.",
          execute: (callArgs) => {
            const wanted = String(callArgs);
            const members = options.scriptTools().filter((tool) => tool.namespace?.name === wanted);
            if (members.length === 0) return undefined;
            const first = members[0]!.namespace!;
            return {
              name: wanted,
              ...(first.description === undefined ? {} : { description: first.description }),
              ...(first.instructions === undefined ? {} : { instructions: first.instructions }),
              tools: members.map((tool) => ({ name: tool.name, description: tool.description })),
            };
          },
        },
      ];

      const sandbox = new CodemodeSandbox({
        tools: [...callables.values()].map((callable) => ({
          name: callable.tool.name,
          ...(callable.tool.description === undefined ? {} : { description: callable.tool.description }),
          inputSchema: callable.kind === "script" ? callable.tool.inputSchema : (callable.tool.parameters as Record<string, unknown>),
          ...(callable.kind === "script" && callable.tool.outputSchema !== undefined
            ? { outputSchema: callable.tool.outputSchema }
            : {}),
          execute: (callArgs: unknown, { signal }: { signal: AbortSignal }) => executeNested(callable.tool.name, callArgs, signal),
        })),
        globals,
        memoryLimitBytes: 256 * 1024 * 1024,
        timeoutMs: parsed.options.timeoutMs ?? Infinity,
        wasm,
      });
      const started = Date.now();
      try {
        const result = await sandbox.execute(parsed.code, { signal: context.abortSignal });
        context.abortSignal?.throwIfAborted();
        return {
          content: resultContent(result, started, parsed.options.maxOutputTokens),
          isError: !result.ok,
          details: snapshot(),
        };
      } finally {
        await sandbox.close();
      }
    },
  });

  return {
    extension: defineExtension({
      name: "codemode",
      tools: [tool],
      sections: [
        section("codemode", (input) => {
          const offered = new Set(input.agent.tools.map((each) => each.name));
          const namespaces = new Map<string, { description?: string; scriptOnly: number }>();
          for (const tool of options.scriptTools()) {
            if (tool.namespace === undefined) continue;
            const entry = namespaces.get(tool.namespace.name) ?? { scriptOnly: 0 };
            namespaces.set(tool.namespace.name, {
              description: entry.description ?? tool.namespace.description,
              scriptOnly: entry.scriptOnly + (offered.has(tool.name) ? 0 : 1),
            });
          }
          const scriptOnly = [...namespaces.entries()]
            .filter(([, entry]) => entry.scriptOnly > 0)
            .sort(([a], [b]) => a.localeCompare(b));
          let text = `Every tool declared to you except ${modelOnlyList} can also be called from codemode scripts as tools.<name>(args), with the same arguments.`;
          if (scriptOnly.length > 0) {
            const lines = scriptOnly.map(([name, entry]) => {
              const firstLine = entry.description?.split("\n")[0];
              const clipped = firstLine === undefined ? "" : `: ${firstLine.slice(0, 200)}`;
              return `- ${name} (${entry.scriptOnly} tools)${clipped}`;
            });
            text += `\n\nThese namespaces are reachable only from codemode scripts; find their tools with describeNamespace(name) or searchTools(query):\n${lines.join("\n")}`;
          }
          return text;
        }),
      ],
    }),
    tools: { codemode: "pinomad.codemode" },
    modelOnly: ["codemode"],
  };
}

const DESCRIPTION = `Run a JavaScript script that calls other tools; only what the script outputs reaches you. Use it to run several tool calls in parallel (Promise.all / Promise.allSettled), to filter or aggregate large results before you see them, and to call tools that are only reachable from scripts, such as most MCP tools.

\`code\` is raw JavaScript, not JSON and not a markdown fence. It runs as the body of an async function in a QuickJS sandbox, so top-level await and return work. There are no Node APIs, file system, network, timers, or modules: scripts reach the outside world only through tools. The script may start with one options line: // @options: {"max_output_tokens": 2000, "timeout_ms": 60000}. max_output_tokens defaults to 10000; longer output keeps its start and end. timeout_ms is unset by default.

Globals:
- tools.<name>(args): call a tool with one arguments object. Characters that are invalid in identifiers become _, so mcp__my-server__search is tools.mcp__my_server__search.
- text(value): add to the output; strings as is, other values as JSON. console.log(...) and a top-level \`return value\` do the same.
- image(block): add an image from an image block { type: "image", data, mimeType } or a base64 data: URL.
- exit(): end the script successfully.
- ALL_TOOLS: every callable tool as { name, description }.
- searchTools(query, { limit?, namespace? }): resolves to the callable tools ranked by relevance (default limit 8), as { name, description }[].
- describeTool(name): resolves to { name, description, declaration } with the tool's TypeScript declaration, or undefined.
- describeNamespace(name): resolves to { name, description?, instructions?, tools } for a namespace such as an MCP server, or undefined.
These three return promises: await them.

What a call resolves to: MCP tools resolve to their CallToolResult { content, isError?, structuredContent? }, also when isError is true. Other tools resolve to their text output, or to an array of text and image blocks when the output has images. A call that fails or gets invalid arguments rejects with an Error carrying the tool's error text; use Promise.allSettled to keep the calls that succeed. Tool calls are real: calls made before a failure are not undone, and calls still running when the script ends are cancelled.

Call describeTool before using a tool whose arguments you have not seen. Scripts cannot call {MODEL_ONLY}.`;

/** The model-facing content: status line, script output, return value, error tail — text truncated to the token budget. */
function resultContent(
  result: Awaited<ReturnType<CodemodeSandbox["execute"]>>,
  started: number,
  maxOutputTokens: number | undefined,
): ToolResultMessage["content"] {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const items: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: result.ok ? `Script completed in ${seconds}s` : `Script failed in ${seconds}s` },
  ];
  for (const item of result.output as CodemodeOutputItem[]) {
    items.push(item.type === "text" ? { type: "text", text: item.text } : { type: "image", data: item.data, mimeType: item.mimeType });
  }
  if (result.ok && result.value !== undefined) {
    items.push({ type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value) });
  }
  if (!result.ok) {
    const error = result.error;
    items.push({
      type: "text",
      text:
        error.kind === "timeout"
          ? "Script error: timed out"
          : error.kind === "aborted"
            ? "Script error: aborted"
            : `Script error: ${error.name ?? "Error"}: ${error.message}`,
    });
  }
  // Merge consecutive text blocks, then bound total text by the output token budget.
  const merged: typeof items = [];
  for (const item of items) {
    const last = merged.at(-1);
    if (item.type === "text" && last?.type === "text") merged[merged.length - 1] = { type: "text", text: `${last.text}\n${item.text}` };
    else merged.push(item);
  }
  return truncateText(merged, (maxOutputTokens ?? 10_000) * 4);
}

function truncateText(
  items: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
  budget: number,
): typeof items {
  const total = items.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0);
  if (total <= budget) return items;
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  const head: typeof items = [];
  let used = 0;
  for (const item of items) {
    if (used >= headBudget) break;
    if (item.type !== "text") {
      head.push(item);
      continue;
    }
    const take = Math.min(headBudget - used, item.text.length);
    head.push({ type: "text", text: item.text.slice(0, take) });
    used += take;
  }
  const tail: typeof items = [];
  let tailUsed = 0;
  for (const item of [...items].reverse()) {
    if (tailUsed >= tailBudget) break;
    if (item.type !== "text") {
      tail.unshift(item);
      continue;
    }
    const take = Math.min(tailBudget - tailUsed, item.text.length);
    tail.unshift({ type: "text", text: item.text.slice(-take) });
    tailUsed += take;
  }
  const omitted = total - used - tailUsed;
  return [...head, { type: "text", text: `\n[... ${omitted} characters omitted ...]\n` }, ...tail];
}
