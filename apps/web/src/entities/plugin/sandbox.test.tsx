// jsdom: the shell side of the sandbox (ADR-0049). jsdom never loads the
// sandbox page, so the page's "ready" is dispatched by hand; whether scripts
// run and stay isolated is checked under the real CSP in apps/web/test/web-csp.test.ts.
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "./sandbox.tsx";

const ready = (source: MessageEventSource | null) =>
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: "pinomad-sandbox-ready", source }));
  });

const frame = () => screen.getByTitle<HTMLIFrameElement>("Artifact");

describe("Sandbox", () => {
  it("frames the sandbox page with scripts allowed and nothing else", () => {
    render(<Sandbox html="<p>hi</p>" title="Artifact" />);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("src")).toBe("/sandbox.html");
  });

  it("posts the HTML once, and only after its own frame said it is ready", () => {
    render(<Sandbox html="<p>hi</p>" title="Artifact" />);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    ready(window);
    expect(post).not.toHaveBeenCalled();
    ready(frame().contentWindow);
    expect(post).toHaveBeenCalledExactlyOnceWith("<p>hi</p>", "*");
    // The document it wrote can say "ready" too; it gets nothing more.
    ready(frame().contentWindow);
    expect(post).toHaveBeenCalledOnce();
  });

  it("replaces the frame when the HTML changes", () => {
    const { rerender } = render(<Sandbox html="<p>one</p>" title="Artifact" />);
    const first = frame();
    rerender(<Sandbox html="<p>two</p>" title="Artifact" />);
    expect(frame()).not.toBe(first);
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    ready(frame().contentWindow);
    expect(post).toHaveBeenCalledExactlyOnceWith("<p>two</p>", "*");
  });
});
