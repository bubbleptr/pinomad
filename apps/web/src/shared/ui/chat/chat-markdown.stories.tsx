import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatMarkdown, ChatStreamMarkdown } from "./chat-markdown.tsx";

const meta = {
  title: "Shared/Chat/ChatMarkdown",
  component: ChatMarkdown,
  args: {
    children: [
      "The tokenizer drops the trailing newline, so **`parseLine`** sees an empty token at EOF.",
      "",
      "1. Normalize `\\r\\n` in `tokenize`",
      "2. Add a regression test",
      "3. Regenerate the Rust vectors",
      "",
      "| Project | Before | After |",
      "| - | - | - |",
      "| protocol | 3 failed | pass |",
      "| client | pass | pass |",
      "",
      "```ts",
      "export function tokenize(source: string) {",
      '  return source.replace(/\\r\\n/g, "\\n").split("\\n");',
      "}",
      "```",
      "",
      "> The freshness test catches any drift in the vectors.",
    ].join("\n"),
  },
} satisfies Meta<typeof ChatMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Prose: Story = {};

// `#` renders as a level-3 heading so it sits under the page title.
export const Headings: Story = {
  args: {
    children: ["# Summary", "", "The fix is in.", "", "## Changes", "", "- tokenizer", "", "### Follow-ups", "", "None."].join("\n"),
  },
};

export const FileLinks: Story = {
  args: {
    fileLinks: true,
    linkedInlineCode: new Set(["AGENTS.md"]),
    children: [
      "Edited [src/parser.ts:12](src/parser.ts:12) and [the tokenizer](packages/client/src/tokenize.ts#L40).",
      "",
      "The rule is in `AGENTS.md`; `not-a-file.md` stays plain code. See [the docs](https://pinomad.si/docs).",
    ].join("\n"),
  },
};

export const Streaming: Story = {
  render: (args) => (
    <ChatStreamMarkdown isStreaming fileLinks={args.fileLinks}>
      {"Checking the tokenizer. It splits on `\\n` only, so a Windows checkout"}
    </ChatStreamMarkdown>
  ),
};
