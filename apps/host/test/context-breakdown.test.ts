import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Harness } from "@earendil-works/pi-durable";
import { contextUsage } from "@pinomad/client/context-usage.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { describe, expect, it } from "vitest";
import { breakdownOf, estimateRequest } from "../src/context-breakdown.ts";
import { createContextBreakdown } from "../src/extensions/context-breakdown.ts";
import { todo } from "../src/extensions/todo.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const sum = (parts: Record<string, number>): number =>
  parts.system! + parts.skills! + parts.tools! + parts.mcp! + parts.messages!;

const PREAMBLE = "You are PiNomad, a coding agent. ".repeat(40);
// The skills section exactly as `createContext` renders it (an untagged section).
const SKILLS = formatSkillsForPrompt(
  Array.from({ length: 30 }, (_, index) => ({
    name: `skill-${index}`,
    description: "Review a diff against the repo's standards.",
    filePath: `/skills/skill-${index}/SKILL.md`,
    baseDir: `/skills/skill-${index}`,
    sourceInfo: { path: `/skills/skill-${index}/SKILL.md`, source: "local", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  })),
  "read",
);
const CODEMODE = [
  "<codemode>",
  "Tools scripts can call (`await tools.<name>(args)`):",
  "### `read`\nRead a file.\n## not a namespace heading inside a description",
  "## github\nGitHub's MCP server.",
  `### \`mcp__github__search\`\n${"declare function search(q: string): string;\n".repeat(20)}`,
  "</codemode>",
].join("\n\n");
const SYSTEM = [PREAMBLE, SKILLS, CODEMODE].join("\n\n");
const SCHEMA = { type: "object", properties: { path: { type: "string", description: "x".repeat(400) } } };
const NAMESPACES = [{ name: "github", prefix: "mcp__github__" }];

describe("estimateRequest", () => {
  it("splits the system prompt into system, skills and MCP, and tools by origin", () => {
    const estimate = estimateRequest(
      {
        system: [{ type: "text", text: SYSTEM }],
        tools: [
          { name: "read", description: "Read a file.", input_schema: SCHEMA },
          { name: "mcp__linear__issue", description: "Get an issue.", input_schema: SCHEMA },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      NAMESPACES,
    )!;
    const listing = SKILLS.slice(SKILLS.indexOf("<available_skills>"));
    expect(estimate.skills).toBe(Math.ceil(listing.length / 4));
    // The "## not a namespace" line stays with the built-in tools: only known namespaces start MCP.
    const builtinCodemode = CODEMODE.slice(0, CODEMODE.indexOf("\n## github"));
    expect(estimate.system).toBeGreaterThanOrEqual(Math.floor((PREAMBLE.length + builtinCodemode.length) / 4) - 4);
    // Direct MCP tools and the MCP part of the codemode section both count as MCP; the rest are tools.
    const oneTool = Math.ceil(JSON.stringify({ name: "read", description: "Read a file.", input_schema: SCHEMA }).length / 4);
    expect(estimate.tools).toBe(oneTool);
    expect(estimate.mcp).toBeGreaterThan(oneTool);
  });

  // Shapes as pi-ai 1.5's adapters build them (dist/api/*.js).
  it.each([
    [
      "openai-completions",
      {
        messages: [{ role: "developer", content: SYSTEM }, { role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "mcp__github__search", parameters: SCHEMA } }],
      },
    ],
    [
      // Tools added mid-conversation ride in a system item of their own.
      "openai-completions, tools added later",
      {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "hi" },
          { role: "system", tools: [{ type: "function", function: { name: "mcp__github__search", parameters: SCHEMA } }] },
        ],
      },
    ],
    [
      "openai-responses",
      {
        input: [{ role: "developer", content: SYSTEM }, { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "mcp__github__search", parameters: SCHEMA }] }],
      },
    ],
    ["openai-codex-responses", { instructions: SYSTEM, input: [], tools: [{ type: "function", name: "mcp__github__search", parameters: SCHEMA }] }],
    [
      "google-generative-ai",
      {
        contents: [],
        config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations: [{ name: "mcp__github__search", parameters: SCHEMA }] }] },
      },
    ],
    [
      "bedrock-converse-stream",
      { system: [{ text: SYSTEM }], toolConfig: { tools: [{ toolSpec: { name: "mcp__github__search", inputSchema: { json: SCHEMA } } }] } },
    ],
    [
      "pi-messages",
      {
        context: {
          messages: [
            { role: "system", content: PREAMBLE, sections: { skills: SKILLS, codemode: CODEMODE }, toolsAdded: [{ name: "mcp__github__search", parameters: SCHEMA }] },
          ],
        },
      },
    ],
  ])("reads the system prompt and tools of a %s request", (_api, payload) => {
    const estimate = estimateRequest(payload, NAMESPACES)!;
    const promptOnly = estimateRequest({ system: SYSTEM }, NAMESPACES)!;
    expect(estimate.skills).toBe(promptOnly.skills);
    // Adapters join prompt parts with different separators: a token either way.
    expect(Math.abs(estimate.system - promptOnly.system)).toBeLessThanOrEqual(2);
    expect(estimate.tools).toBe(0);
    // The codemode MCP part plus the direct tool's ~400-character schema.
    expect(estimate.mcp).toBeGreaterThan(promptOnly.mcp + 100);
  });

  it("gives up on a request it cannot read", () => {
    expect(estimateRequest({ prompt: "hi" }, [])).toBeUndefined();
    expect(estimateRequest(undefined, [])).toBeUndefined();
  });
});

describe("breakdownOf", () => {
  it("gives messages the rest of the provider's count", () => {
    const parts = breakdownOf({ system: 100, skills: 20, tools: 300, mcp: 80 }, 10_000);
    expect(parts).toEqual({ used: 10_000, system: 100, skills: 20, tools: 300, mcp: 80, messages: 9_500 });
  });

  it("scales estimates that overshoot the real count so the parts still sum to it", () => {
    const parts = breakdownOf({ system: 700, skills: 100, tools: 900, mcp: 301 }, 1_000);
    expect(sum(parts)).toBe(1_000);
    expect(parts.messages).toBeGreaterThanOrEqual(0);
    expect(parts.tools).toBeGreaterThan(parts.system);
  });
});

describe("the context breakdown document", () => {
  const defer = useCleanups();

  // Faux sends nothing over the wire, so its responses play the provider
  // adapter's part and hand `onPayload` a body before replying — the
  // pi-messages shape, which carries pi's transcript as is.
  const answer =
    (text: string): FauxResponseFactory =>
    async (request, options, _state, model) => {
      await options?.onPayload?.({ model: model.id, context: request }, model);
      return fauxAssistantMessage(text);
    };

  it("follows each reply with parts that sum to the meter's count", async () => {
    const host = await startFauxHost(defer, {
      extensions: ({ harness }: { harness: () => Harness }) => [todo, createContextBreakdown({ harness })],
      answers: [answer("first"), answer("second")],
    });
    const client = await connectTo(defer, host);
    const breakdown = (view: DurableView) => {
      const doc = view.docs.find((each) => each.kind === "context.breakdown");
      const classified = classify(doc?.presentation, doc?.value);
      return classified.type === "pinomad.context" ? classified.value : undefined;
    };
    const meter = (view: DurableView) => contextUsage(view.conversation!, 1)?.used;

    await startChat(client, "hello");
    await waitForView(client.view, (view) => meter(view) !== undefined && breakdown(view)?.used === meter(view));
    const first = breakdown(client.view.current())!;
    expect(first.system + first.skills + first.tools + first.mcp + first.messages).toBe(first.used);
    // todo_write's schema; this host installs no prompt sections, so tools is all there is besides messages.
    expect(first.tools).toBeGreaterThan(0);

    await client.controller.submit("again", "followUp");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "second");
    await waitForView(client.view, (view) => breakdown(view)?.used === meter(view));
    expect(breakdown(client.view.current())!.used).toBeGreaterThan(first.used);
  });
});
