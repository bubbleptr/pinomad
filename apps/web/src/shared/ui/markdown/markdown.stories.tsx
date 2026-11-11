import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Markdown } from "./markdown.tsx";

const answer = [
  "# Summary",
  "",
  "The tokenizer drops the trailing newline, so **`parseLine`** sees an empty token at EOF. See [the spec](https://spec.commonmark.org).",
  "",
  "## Changes",
  "",
  "1. Normalize `\\r\\n` in `tokenize`",
  "2. Add a regression test",
  "",
  "- [x] protocol vectors",
  "- [ ] client vectors",
  "",
  "| Project | Before | After |",
  "| - | :-: | -: |",
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
  "",
  "---",
  "",
  "That's all.",
].join("\n");

const meta = {
  title: "Shared/Markdown",
  component: Markdown,
  args: { children: answer },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Chat's settings: tighter block rhythm, `#` rendered as h3 under the page title.
export const CompactInChat: Story = {
  args: { density: "compact", headingLevelStart: 3 },
};

function StreamingAnswer() {
  const [length, setLength] = useState(0);
  useEffect(() => {
    if (length >= answer.length) {
      return;
    }
    const timer = setTimeout(() => setLength((n) => n + 24), 60);
    return () => clearTimeout(timer);
  }, [length]);
  return (
    <Markdown density="compact" isStreaming={length < answer.length}>
      {answer.slice(0, length)}
    </Markdown>
  );
}

// Chunks arrive in bursts; each newly revealed span fades in.
export const Streaming: Story = {
  render: () => <StreamingAnswer />,
};
