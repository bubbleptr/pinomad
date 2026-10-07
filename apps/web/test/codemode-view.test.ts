import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodemodeView } from "../src/presentation/codemode.tsx";
import type { ToolCallView } from "../src/presentation/chat.ts";

const details = {
  code: "await tools.bash({})",
  calls: [{ name: "bash", args: "{}", status: "running" as const, durationMs: 10 }],
};
const tool = (status: ToolCallView["status"], output?: string): ToolCallView =>
  ({ callId: "c1", name: "codemode", args: "{}", status, ...(output === undefined ? {} : { output }) }) as ToolCallView;

const markup = (t: ToolCallView) =>
  renderToStaticMarkup(createElement(CodemodeView, { details, tool: t, toolPresentations: {} }));

describe("CodemodeView", () => {
  it("keeps a running row as running while the card runs", () => {
    expect(markup(tool("running"))).toContain("running");
  });

  it("shows a still-running row as cancelled once the card settled", () => {
    const html = markup(tool("complete"));
    expect(html).toContain("cancelled");
    expect(html).not.toContain(">running<");
  });

  it("does not repeat the output on an error card but keeps images", () => {
    const t = tool("error", "the only output") as ToolCallView;
    const html = renderToStaticMarkup(
      createElement(CodemodeView, {
        details,
        tool: { ...t, images: [{ data: "aGk=", mimeType: "image/png" }] },
        toolPresentations: {},
      }),
    );
    expect(html).not.toContain("the only output");
    expect(html).toContain("data:image/png;base64,aGk=");
  });
});
