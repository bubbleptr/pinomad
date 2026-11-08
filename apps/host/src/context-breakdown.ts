// What filled the context window, estimated from the provider request body
// right before it is sent. Only the provider's total is measured; these parts
// are character estimates, so `breakdownOf` fits them under the real count.
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { ContextBreakdown } from "@pinomad/protocol/presentation.ts";

export type RequestEstimate = Pick<ContextBreakdown, "system" | "skills" | "tools" | "mcp">;

/** The same ratio pi uses for its own prompt-size estimates. */
const CHARS_PER_TOKEN = 4;
const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** The `mcp` bridge's direct-exposure tool names (`mcp__<server>__<tool>`). */
const MCP_TOOL = /^mcp__/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** A string, or the `text` of each block in a list or `{ parts }` object. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (isObject(value) && "parts" in value) return textOf(value.parts);
  return arrayOf(value)
    .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * Where an adapter keeps the request: the body itself, Google's `config`, or
 * pi-messages' `context` (pi's own transcript, sent as is).
 */
const sourcesOf = (payload: Json): readonly Json[] => [payload, payload.config, payload.context].filter(isObject);

/** System and developer items of a source's `messages` / `input` (OpenAI, Mistral, pi-messages). */
const systemItemsOf = (source: Json): readonly Json[] =>
  [...arrayOf(source.messages), ...arrayOf(source.input)].filter(
    (item): item is Json => isObject(item) && (item.role === "system" || item.role === "developer"),
  );

/**
 * The system prompt, wherever the API puts it: Anthropic and Bedrock `system`,
 * OpenAI Responses `instructions`, Google `systemInstruction`, or system and
 * developer items, whose pi form adds named `sections`. Later system items
 * (prompt updates sent in place) stay in the request, so they count too.
 */
function systemTextOf(payload: Json): string {
  return sourcesOf(payload)
    .flatMap((source) => [
      textOf(source.system),
      textOf(source.instructions),
      textOf(source.systemInstruction),
      ...systemItemsOf(source).flatMap((item) => [
        textOf(item.content),
        ...(isObject(item.sections) ? Object.values(item.sections).filter((section) => typeof section === "string") : []),
      ]),
    ])
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * Declared tools: a `tools` list (Google nests `functionDeclarations`),
 * Bedrock's `toolConfig.tools`, or tools a system item adds (OpenAI's tool
 * additions, pi's `toolsAdded`).
 */
function toolsOf(payload: Json): readonly Json[] {
  const listed = sourcesOf(payload).flatMap((source) => [
    ...arrayOf(source.tools),
    ...arrayOf(isObject(source.toolConfig) ? source.toolConfig.tools : undefined),
    ...systemItemsOf(source).flatMap((item) => [...arrayOf(item.tools), ...arrayOf(item.toolsAdded)]),
  ]);
  return listed.flatMap((tool) =>
    isObject(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations.filter(isObject) : isObject(tool) ? [tool] : [],
  );
}

function toolName(tool: Json): string | undefined {
  for (const holder of [tool, tool.function, tool.toolSpec]) {
    if (isObject(holder) && typeof holder.name === "string") return holder.name;
  }
  return undefined;
}

/** Remove `<tag>…</tag>` from `text`, returning what was inside and what remains. */
function cut(text: string, tag: string): { inside: string; rest: string } {
  const open = text.indexOf(`<${tag}>`);
  const close = open < 0 ? -1 : text.indexOf(`</${tag}>`, open);
  if (close < 0) return { inside: "", rest: text };
  return { inside: text.slice(open, close + tag.length + 3), rest: text.slice(0, open) + text.slice(close + tag.length + 3) };
}

/**
 * Codemode lists namespaced (MCP) tools after the plain ones, each namespace
 * under a `## <name>` heading. Only known names split it: a tool description
 * may carry its own `## ` lines.
 */
function splitCodemode(section: string, namespaces: readonly CodemodeNamespace[]): { builtin: string; mcp: string } {
  const starts = namespaces
    .map(({ name }) => section.search(new RegExp(`\\n## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\n| \\(|$)`)))
    .filter((index) => index >= 0);
  if (starts.length === 0) return { builtin: section, mcp: "" };
  const first = Math.min(...starts);
  return { builtin: section.slice(0, first), mcp: section.slice(first) };
}

/** Estimate the fixed parts of a provider request body; undefined when it carries neither a system prompt nor tools. */
export function estimateRequest(payload: unknown, namespaces: readonly CodemodeNamespace[]): RequestEstimate | undefined {
  if (!isObject(payload)) return undefined;
  const system = systemTextOf(payload);
  const tools = toolsOf(payload);
  if (system === "" && tools.length === 0) return undefined;

  const skills = cut(system, "skills");
  const codemode = cut(skills.rest, "codemode");
  const { builtin, mcp } = splitCodemode(codemode.inside, namespaces);
  let toolTokens = 0;
  let mcpTokens = tokensOf(mcp);
  for (const tool of tools) {
    const cost = tokensOf(JSON.stringify(tool));
    if (MCP_TOOL.test(toolName(tool) ?? "")) mcpTokens += cost;
    else toolTokens += cost;
  }
  return {
    // The codemode section's built-in part describes the script API: system prompt text, like the rest.
    system: tokensOf(codemode.rest) + tokensOf(builtin),
    skills: tokensOf(skills.inside),
    tools: toolTokens,
    mcp: mcpTokens,
  };
}

/**
 * The breakdown of a reply that reported `used` context tokens: messages take
 * the remainder. Estimates that overshoot the real count (a short conversation
 * on a tokenizer denser than 4 chars/token) are scaled down to fit, so the
 * parts always sum to `used`.
 */
export function breakdownOf(estimate: RequestEstimate, used: number): ContextBreakdown {
  const fixed = estimate.system + estimate.skills + estimate.tools + estimate.mcp;
  const scale = fixed > used ? used / fixed : 1;
  const system = Math.floor(estimate.system * scale);
  const skills = Math.floor(estimate.skills * scale);
  const tools = Math.floor(estimate.tools * scale);
  const mcp = Math.floor(estimate.mcp * scale);
  return { used, system, skills, tools, mcp, messages: used - system - skills - tools - mcp };
}
