// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/Markdown/Markdown.test.tsx), MIT.

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it('renders with role="document"', () => {
    render(<Markdown>Hello</Markdown>);
    expect(screen.getByRole("document")).toBeInTheDocument();
  });

  it("renders headings", () => {
    render(<Markdown>{"# Heading 1\n\n## Heading 2"}</Markdown>);
    expect(screen.getByText("Heading 1").tagName).toBe("H1");
    expect(screen.getByText("Heading 2").tagName).toBe("H2");
  });

  it("renders paragraphs as block <div> (never <p>) for composition safety", () => {
    render(<Markdown>{"Hello world"}</Markdown>);
    const para = screen.getByText("Hello world");
    expect(para.tagName).toBe("DIV");
    expect(para).toHaveAttribute("role", "paragraph");
  });

  describe("block slots", () => {
    // Every block carries a data-slot so callers can tune one block type
    // (chat.css adjusts headings and paragraph gaps) without descendant
    // selectors on tag names.
    it("renders a data-slot on every block type", () => {
      const { container } = render(
        <Markdown>
          {[
            "# Heading",
            "Paragraph text",
            "- item one",
            "```\ncode\n```",
            "> quoted",
            "| a | b |\n| - | - |\n| 1 | 2 |",
            "---",
            "![alt](https://example.com/x.png)",
          ].join("\n\n")}
        </Markdown>,
      );
      for (const slot of [
        "markdown-heading",
        "markdown-paragraph",
        "markdown-list",
        "markdown-codeblock",
        "markdown-blockquote",
        "markdown-table",
        "markdown-hr",
        "markdown-image",
      ]) {
        expect(container.querySelector(`[data-slot="${slot}"]`), `expected a ${slot} element`).not.toBeNull();
      }
    });

    it("renders the slot on task lists too", () => {
      const { container } = render(<Markdown>{"- [ ] todo"}</Markdown>);
      expect(container.querySelector('[data-slot="markdown-list"]')).not.toBeNull();
    });

    it("reflects density on blocks as data-density", () => {
      const { rerender } = render(<Markdown>{"Hello world"}</Markdown>);
      expect(screen.getByText("Hello world")).toHaveAttribute("data-density", "default");
      rerender(<Markdown density="compact">{"Hello world"}</Markdown>);
      expect(screen.getByText("Hello world")).toHaveAttribute("data-density", "compact");
    });

    it("reflects the rendered heading level as data-level", () => {
      render(<Markdown headingLevelStart={3}>{"## Section"}</Markdown>);
      const heading = screen.getByText("Section");
      expect(heading).toHaveAttribute("data-slot", "markdown-heading");
      expect(heading).toHaveAttribute("data-level", "4");
    });

    it("does not apply the slot when a custom block component is provided", () => {
      const { container } = render(
        <Markdown
          components={{
            heading: ({ children }: { children: ReactNode }) => <h2 data-custom>{children}</h2>,
          }}
        >
          {"# Custom heading"}
        </Markdown>,
      );
      expect(container.querySelector('[data-slot="markdown-heading"]')).toBeNull();
      expect(container.querySelector("[data-custom]")).not.toBeNull();
    });
  });

  it("renders bold text", () => {
    render(<Markdown>{"**bold text**"}</Markdown>);
    expect(screen.getByText("bold text").tagName).toBe("STRONG");
  });

  it("renders italic text", () => {
    render(<Markdown>{"*italic text*"}</Markdown>);
    expect(screen.getByText("italic text").tagName).toBe("EM");
  });

  it("renders strikethrough text", () => {
    render(<Markdown>{"~~struck~~"}</Markdown>);
    expect(screen.getByText("struck").tagName).toBe("DEL");
  });

  it("renders inline code with Code", () => {
    render(<Markdown>{"Use `code` here"}</Markdown>);
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("code")).toHaveAttribute("data-slot", "code");
  });

  it("routes inline code through components.inlineCode", () => {
    render(
      <Markdown components={{ inlineCode: ({ children }) => <kbd data-testid="custom-code">{children}</kbd> }}>
        {"Use `code` here"}
      </Markdown>,
    );
    expect(screen.getByTestId("custom-code")).toHaveTextContent("code");
  });

  it("renders code blocks with CodeBlock", () => {
    const { container } = render(<Markdown>{"```js\nconst x = 1;\n```"}</Markdown>);
    expect(container.querySelector('pre[data-slot="code-block"]')).toBeInTheDocument();
  });

  it("makes fenced code of 10+ lines collapsible", () => {
    const code = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    render(<Markdown>{`\`\`\`ts\n${code}\n\`\`\``}</Markdown>);
    expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("ts");
  });

  it('adds target="_blank" to external links', () => {
    render(<Markdown>{"[ext](https://example.com)"}</Markdown>);
    const link = screen.getByText("ext");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("routes links through components.link", () => {
    render(
      <Markdown
        components={{
          link: ({ href, children }) => (
            <a href={href} data-testid="custom-link">
              {children}
            </a>
          ),
        }}
      >
        {"[docs](src/a.ts)"}
      </Markdown>,
    );
    expect(screen.getByTestId("custom-link")).toHaveAttribute("href", "src/a.ts");
  });

  it("renders a footer reference-style link as an anchor", () => {
    render(<Markdown>{"See [the docs][docs] here.\n\n[docs]: https://example.com/docs\n"}</Markdown>);
    const link = screen.getByText("the docs");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.queryByText(/\[docs\]:/)).toBeNull();
  });

  it("renders a shortcut reference-style link as an anchor", () => {
    render(<Markdown>{"See [the docs].\n\n[the docs]: /docs"}</Markdown>);
    const link = screen.getByText("the docs");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/docs");
  });

  it('does not add target="_blank" to relative links', () => {
    render(<Markdown>{"[internal](/page)"}</Markdown>);
    expect(screen.getByText("internal").getAttribute("target")).toBeNull();
  });

  it("renders blockquotes", () => {
    render(<Markdown>{"> A quote"}</Markdown>);
    expect(document.querySelector("blockquote")).toBeInTheDocument();
  });

  it("renders unordered lists", () => {
    render(<Markdown>{"- A\n- B\n- C"}</Markdown>);
    expect(document.querySelector("ul")).toBeInTheDocument();
    expect(document.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders ordered list items as direct children of ol (no span wrapper)", () => {
    render(<Markdown>{"1. First\n2. Second\n3. Third"}</Markdown>);
    const ol = document.querySelector("ol")!;
    const directChildren = Array.from(ol.children);
    expect(directChildren.every((c) => c.tagName === "LI")).toBe(true);
    expect(directChildren).toHaveLength(3);
  });

  it("joins blank-line-separated 1./1./1. into a single ordered list", () => {
    render(<Markdown>{"1. apple\n\n1. banana\n\n1. cherry"}</Markdown>);
    const ols = document.querySelectorAll("ol");
    expect(ols).toHaveLength(1);
    expect(ols[0].querySelectorAll("li")).toHaveLength(3);
  });

  it("forwards a non-default start onto the <ol> and its counter", () => {
    render(<Markdown>{"5. five\n6. six\n7. seven"}</Markdown>);
    const ol = document.querySelector("ol")!;
    expect(ol.getAttribute("start")).toBe("5");
    expect(ol.style.counterReset).toBe("markdown-list 4");
  });

  it("renders task lists with read-only checkboxes named by their label", () => {
    render(<Markdown>{"- [x] Done\n- [ ] Todo"}</Markdown>);
    const done = screen.getByRole("checkbox", { name: "Done" });
    const todo = screen.getByRole("checkbox", { name: "Todo" });
    expect(done).toBeChecked();
    expect(todo).not.toBeChecked();
    act(() => todo.click());
    expect(todo).not.toBeChecked();
    expect(screen.getByRole("group", { name: "Task list" })).toBeInTheDocument();
  });

  it("renders tables", () => {
    render(<Markdown>{"| A | B |\n| --- | --- |\n| 1 | 2 |"}</Markdown>);
    expect(document.querySelector("table")).toBeInTheDocument();
    expect(document.querySelectorAll("th")).toHaveLength(2);
    expect(document.querySelectorAll("td")).toHaveLength(2);
  });

  it("makes the table scroll wrapper keyboard-focusable", () => {
    render(<Markdown>{"| A | B |\n| --- | --- |\n| 1 | 2 |"}</Markdown>);
    const wrapper = document.querySelector("table")!.closest('[role="group"][tabindex="0"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper).toHaveAttribute("aria-label", "Table");
  });

  it("renders horizontal rules", () => {
    render(<Markdown>{"---"}</Markdown>);
    expect(document.querySelector("hr")).toBeInTheDocument();
  });

  it("renders images", () => {
    render(<Markdown>{"![alt text](image.png)"}</Markdown>);
    const img = document.querySelector("img");
    expect(img!.getAttribute("alt")).toBe("alt text");
    expect(img!.getAttribute("src")).toBe("image.png");
  });

  it("uses the components.image override for a standalone (block) image", () => {
    render(
      <Markdown
        components={{
          image: ({ src, alt }) => (
            <span data-testid="custom-image" data-src={src}>
              {alt}
            </span>
          ),
        }}
      >
        {"![alt text](image.png)"}
      </Markdown>,
    );
    expect(document.querySelector("img")).not.toBeInTheDocument();
    const custom = screen.getByTestId("custom-image");
    expect(custom).toHaveTextContent("alt text");
    expect(custom.getAttribute("data-src")).toBe("image.png");
  });

  it("shifts heading levels with headingLevelStart", () => {
    render(<Markdown headingLevelStart={3}>{"# Heading 1"}</Markdown>);
    expect(screen.getByText("Heading 1").tagName).toBe("H3");
  });

  it("clamps shifted heading levels to h6", () => {
    render(<Markdown headingLevelStart={3}>{"##### Deep"}</Markdown>);
    expect(screen.getByText("Deep").tagName).toBe("H6");
  });

  it("supports data-testid and className", () => {
    render(
      <Markdown data-testid="md" className="extra">
        {"Hello"}
      </Markdown>,
    );
    expect(screen.getByTestId("md")).toHaveClass("extra");
  });

  it("forwards ref", () => {
    const ref = { current: null as HTMLDivElement | null };
    render(<Markdown ref={ref}>{"Hello"}</Markdown>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("sanitizes javascript: URLs in links", () => {
    const { container } = render(<Markdown>{"[click](javascript:alert(1))"}</Markdown>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });

  it("sanitizes data: URLs in images", () => {
    const { container } = render(<Markdown>{"![xss](data:text/html,<script>alert(1)</script>)"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
  });

  it("allows safe URLs", () => {
    const { container } = render(<Markdown>{"[safe](https://example.com) and [relative](/page)"}</Markdown>);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[1].getAttribute("href")).toBe("/page");
  });
});

describe("Markdown streaming", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushFrames(count: number) {
    for (let i = 0; i < count; i++) {
      const cb = frames.pop();
      if (cb) {
        act(() => cb(1000 + i * 20));
      }
    }
  }

  it("reveals streamed text progressively and fades in the new chunk", () => {
    const { container } = render(<Markdown isStreaming>{"Streaming answer that keeps growing."}</Markdown>);
    expect(container.textContent).toBe("");

    flushFrames(1);
    expect(container.textContent).toBe("Streaming ");
    expect(container.querySelector(".starting\\:opacity-0")).not.toBeNull();

    flushFrames(10);
    expect(container.textContent).toBe("Streaming answer that keeps growing.");
  });

  it("renders the full text once streaming ends", () => {
    const { container, rerender } = render(<Markdown isStreaming>{"# Title\n\nBody"}</Markdown>);
    rerender(<Markdown>{"# Title\n\nBody"}</Markdown>);
    expect(screen.getByText("Title").tagName).toBe("H1");
    expect(container.querySelector(".starting\\:opacity-0")).toBeNull();
  });
});
