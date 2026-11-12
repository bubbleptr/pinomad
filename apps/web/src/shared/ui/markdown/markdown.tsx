// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/Markdown/Markdown.tsx), MIT.

import { cn } from "cn";
import { useId, useMemo, useRef, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { Code } from "@/shared/ui/code-block/code";
import { CodeBlock } from "@/shared/ui/code-block/code-block";
import {
  createIncrementalState,
  parseMarkdown,
  parseMarkdownIncremental,
  trimStreamingArtifacts,
  type BlockNode,
  type IncrementalState,
  type InlineNode,
} from "./parser";
import { computeBoundaries, computeSegments } from "./streaming";
import { STREAMING_MAX_FADE_SPANS, useStreamingText } from "./use-streaming-text";

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type Density = "default" | "compact";

export type MarkdownComponents = {
  code: ComponentType<{ code: string; language?: string }>;
  inlineCode: ComponentType<{ children: string }>;
  link: ComponentType<{ href: string; children: ReactNode }>;
  heading: ComponentType<{ level: HeadingLevel; children: ReactNode }>;
  paragraph: ComponentType<{ children: ReactNode }>;
  image: ComponentType<{ src: string; alt: string }>;
  blockquote: ComponentType<{ children: ReactNode }>;
  hr: ComponentType<object>;
};

export type MarkdownProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
  density?: Density;
  /**
   * The HTML heading level that markdown `#` maps to. `3` renders `#` as h3,
   * `##` as h4; levels past h6 clamp to h6.
   */
  headingLevelStart?: HeadingLevel;
  /** Parse incrementally and fade in each newly revealed chunk. */
  isStreaming?: boolean;
  components?: Partial<MarkdownComponents>;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** Readable line length for prose; tables and code blocks may grow past it. */
const proseWidth = "max-w-[680px]";
const blockWidth = "min-w-[min(680px,100%)]";

const headingClassNames: Record<HeadingLevel, string> = {
  1: "text-[1.5rem] leading-[1.3333] font-semibold",
  2: "text-[1.25rem] leading-[1.4] font-semibold",
  3: "text-[1.0625rem] leading-[1.4118] font-bold",
  4: "text-[0.875rem] leading-[1.4286] font-bold",
  5: "text-[0.75rem] leading-[1.6667] font-semibold",
  6: "text-[0.625rem] leading-[1.6] font-semibold",
};

/** [margin-block-start, margin-block-end] per block type and density. */
const spacing = {
  headingMajor: { default: ["mt-6", "mb-3"], compact: ["mt-4", "mb-2"] },
  headingMinor: { default: ["mt-4", "mb-2"], compact: ["mt-3", "mb-1"] },
  paragraph: { default: ["mt-3", "mb-3"], compact: ["mt-1", "mb-1"] },
  codeblock: { default: ["mt-4", "mb-4"], compact: ["mt-2", "mb-2"] },
  blockquote: { default: ["mt-4", "mb-4"], compact: ["mt-2", "mb-2"] },
  list: { default: ["mt-3", "mb-3"], compact: ["mt-1", "mb-1"] },
  table: { default: ["mt-4", "mb-4"], compact: ["mt-2", "mb-2"] },
  hr: { default: ["mt-6", "mb-6"], compact: ["mt-3", "mb-3"] },
  image: { default: ["mt-3", "mb-3"], compact: ["mt-2", "mb-2"] },
} as const;

function spacingKey(node: BlockNode): keyof typeof spacing {
  if (node.type === "heading") {
    return node.level <= 3 ? "headingMajor" : "headingMinor";
  }
  return node.type;
}

/** Block margins, with the outer margins of the first and last block dropped. */
function blockSpacing(node: BlockNode, density: Density, isFirst: boolean, isLast: boolean): string {
  const [start, end] = spacing[spacingKey(node)][density];
  return `${isFirst ? "mt-0" : start} ${isLast ? "mb-0" : end}`;
}

// Collapses to an instant swap under reduced motion: the 0s duration makes
// the @starting-style opacity jump non-animated.
const fadeInClassName =
  "opacity-100 transition-opacity duration-300 ease-[var(--ease-standard)] motion-reduce:duration-0 starting:opacity-0";

const bodySize = "text-[length:var(--text-body-size,0.875rem)]";

const cellAlignClassNames = {
  left: "",
  center: "text-center",
  right: "text-end",
} as const;

// ---------------------------------------------------------------------------
// Streaming fade-in
// ---------------------------------------------------------------------------

/**
 * Mutable cursor threaded through the render tree during streaming.
 * Tracks how many text characters we've visited so far. When `offset`
 * crosses a boundary, newly rendered content is wrapped in a fade-in span.
 */
interface StreamingCursor {
  /** Characters visited so far in this render pass */
  offset: number;
  /** Recent boundary positions, oldest first. Text before boundaries[0] is
   *  fully visible; text between boundaries[i] and boundaries[i+1] gets its
   *  own fade span; text after the last boundary is the newest chunk. */
  boundaries: number[];
  /** Whether streaming fade is active */
  active: boolean;
}

/**
 * Count the total text characters in inline nodes without rendering.
 */
function countInlineTextLength(nodes: InlineNode[]): number {
  let len = 0;
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        len += node.content.length;
        break;
      case "code":
        len += node.content.length;
        break;
      case "image":
        len += node.alt.length;
        break;
      case "bold":
      case "italic":
      case "strikethrough":
      case "link":
        len += countInlineTextLength(node.children);
        break;
      case "break":
        len += 1;
        break;
      case "citation":
        len += 1;
        break;
    }
  }
  return len;
}

/**
 * Count total text characters in a block node tree.
 */
function countBlockTextLength(nodes: BlockNode[]): number {
  let len = 0;
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
      case "paragraph":
        len += countInlineTextLength(node.children);
        break;
      case "codeblock":
        len += node.content.length;
        break;
      case "blockquote":
        len += countBlockTextLength(node.children);
        break;
      case "list":
        for (const item of node.items) {
          len += countBlockTextLength(item.children);
        }
        break;
      case "table":
        for (const h of node.headers) {
          len += countInlineTextLength(h.children);
        }
        for (const row of node.rows) {
          for (const cell of row) {
            len += countInlineTextLength(cell.children);
          }
        }
        break;
      case "hr":
        break;
      case "image":
        len += node.alt.length;
        break;
    }
  }
  return len;
}

/**
 * Split a text string into settled and fading spans at the streaming
 * boundaries it crosses. Returns the plain string when nothing is new.
 */
function wrapTextWithFade(content: string, cursor: StreamingCursor, key: string | number): ReactNode {
  const startOffset = cursor.offset;
  cursor.offset += content.length;

  if (!cursor.active) {
    return content;
  }

  const segments = computeSegments(content, startOffset, cursor.boundaries, key);

  if (segments == null) {
    return content;
  }

  const nodes = segments.map((seg) =>
    seg.fading ? (
      <span key={seg.key} className={fadeInClassName}>
        {seg.text}
      </span>
    ) : (
      <span key={seg.key}>{seg.text}</span>
    ),
  );

  return <span key={`wrap-${key}`}>{nodes}</span>;
}

// ---------------------------------------------------------------------------
// URL sanitization — block dangerous protocols
// ---------------------------------------------------------------------------

const DANGEROUS_URL_PATTERN = /^(javascript|data|vbscript):/i;

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (DANGEROUS_URL_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Inline renderer
// ---------------------------------------------------------------------------

interface RenderContext {
  density: Density;
  headingLevelStart: HeadingLevel;
  cursor: StreamingCursor;
  components: Partial<MarkdownComponents> | undefined;
}

function renderInlines(nodes: InlineNode[], ctx: RenderContext): ReactNode[] {
  return nodes.map((c, i) => renderInline(c, i, ctx));
}

function renderInline(node: InlineNode, index: number, ctx: RenderContext): ReactNode {
  const { cursor, components } = ctx;
  switch (node.type) {
    case "text":
      return wrapTextWithFade(node.content, cursor, index);
    case "bold":
      return (
        <strong key={index} className="font-semibold">
          {renderInlines(node.children, ctx)}
        </strong>
      );
    case "italic":
      return <em key={index}>{renderInlines(node.children, ctx)}</em>;
    case "strikethrough":
      return (
        <del key={index} className="text-muted-foreground">
          {renderInlines(node.children, ctx)}
        </del>
      );
    case "code": {
      // Track code content length for cursor but don't split inside code
      cursor.offset += node.content.length;
      const InlineCodeComp = components?.inlineCode;
      return InlineCodeComp ? (
        <InlineCodeComp key={index}>{node.content}</InlineCodeComp>
      ) : (
        <Code key={index}>{node.content}</Code>
      );
    }
    case "link": {
      const safeHref = sanitizeUrl(node.href);
      if (safeHref == null) {
        // Unsafe URL — render as plain text
        return <span key={index}>{renderInlines(node.children, ctx)}</span>;
      }
      const LinkComp = components?.link;
      if (LinkComp) {
        return (
          <LinkComp key={index} href={safeHref}>
            {renderInlines(node.children, ctx)}
          </LinkComp>
        );
      }
      const isExternal = safeHref.startsWith("https://") || safeHref.startsWith("http://");
      return (
        <a
          key={index}
          href={safeHref}
          {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="text-primary underline"
        >
          {renderInlines(node.children, ctx)}
        </a>
      );
    }
    case "image": {
      const safeSrc = sanitizeUrl(node.src);
      if (safeSrc == null) {
        return <span key={index}>[{node.alt}]</span>;
      }
      const ImageComp = components?.image;
      if (ImageComp) {
        return <ImageComp key={index} src={safeSrc} alt={node.alt} />;
      }
      return <img key={index} src={safeSrc} alt={node.alt} className="max-w-full rounded-[var(--radius-element)]" />;
    }
    case "break":
      cursor.offset += 1;
      return <br key={index} />;
    case "citation":
      // The parser only emits citations for known source ids, and this port
      // passes none; kept for exhaustiveness.
      cursor.offset += 1;
      return <span key={index}>[{node.sourceId}]</span>;
  }
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

/**
 * Compute per-column min-widths from table AST content.
 * Buckets: ≤6 chars → 60px, 7–15 → 80px, >15 → 120px.
 */
function computeTableColumnMinWidths(node: {
  headers: { children: InlineNode[] }[];
  rows: { children: InlineNode[] }[][];
}): number[] {
  return node.headers.map((h, colIdx) => {
    let maxLen = countInlineTextLength(h.children);
    for (const row of node.rows) {
      if (row[colIdx]) {
        const len = countInlineTextLength(row[colIdx].children);
        if (len > maxLen) {
          maxLen = len;
        }
      }
    }
    return maxLen <= 6 ? 60 : maxLen <= 15 ? 80 : 120;
  });
}

function renderBlocks(nodes: BlockNode[], ctx: RenderContext): ReactNode[] {
  return nodes.map((c, i) => renderBlock(c, i, nodes.length, ctx));
}

/** A list item's content: inline when it is a single paragraph (tight list). */
function renderListItemLabel(children: BlockNode[], ctx: RenderContext): ReactNode {
  const firstChild = children[0];
  if (children.length === 1 && firstChild?.type === "paragraph") {
    return renderInlines(firstChild.children, ctx);
  }
  return renderBlocks(children, ctx);
}

const listItemClassName =
  "relative box-border flex items-center gap-2 rounded-[var(--radius-element)] px-2 py-1 text-start [counter-increment:markdown-list]";
const listLabelClassName = `${bodySize} leading-[1.4286] text-foreground`;

function renderBlock(node: BlockNode, index: number, blockCount: number, ctx: RenderContext): ReactNode {
  const { density, headingLevelStart, components } = ctx;
  const margins = blockSpacing(node, density, index === 0, index === blockCount - 1);

  switch (node.type) {
    case "heading": {
      const level = Math.min(node.level + headingLevelStart - 1, 6) as HeadingLevel;
      const headingChildren = renderInlines(node.children, ctx);
      const HeadingComp = components?.heading;
      if (HeadingComp) {
        return (
          <HeadingComp key={index} level={level}>
            {headingChildren}
          </HeadingComp>
        );
      }
      const Tag = `h${level}` as const;
      return (
        <Tag
          key={index}
          data-slot="markdown-heading"
          data-density={density}
          data-level={level}
          className={cn(
            "font-[family-name:var(--font-family-body)] text-foreground",
            headingClassNames[level],
            margins,
            proseWidth,
          )}
        >
          {headingChildren}
        </Tag>
      );
    }
    case "paragraph": {
      const paraChildren = renderInlines(node.children, ctx);
      const ParagraphComp = components?.paragraph;
      if (ParagraphComp) {
        return <ParagraphComp key={index}>{paraChildren}</ParagraphComp>;
      }
      // Paragraphs render as <div>, not <p>: inline content can include
      // block-level nodes (images, custom inline components), which a <p>
      // would reparent. role="paragraph" keeps the prose semantics.
      return (
        <div
          key={index}
          role="paragraph"
          data-slot="markdown-paragraph"
          data-density={density}
          className={cn(margins, proseWidth)}
        >
          {paraChildren}
        </div>
      );
    }
    case "codeblock": {
      // Track codeblock content in cursor for accurate character counting
      ctx.cursor.offset += node.content.length;
      const CodeBlockComp = components?.code;
      if (CodeBlockComp) {
        return <CodeBlockComp key={index} code={node.content} language={node.language} />;
      }
      return (
        <div
          key={index}
          data-slot="markdown-codeblock"
          data-density={density}
          className={cn("max-w-full", margins)}
        >
          <CodeBlock code={node.content} language={node.language} isCollapsible className={blockWidth} />
        </div>
      );
    }
    case "blockquote": {
      const BlockquoteComp = components?.blockquote;
      if (BlockquoteComp) {
        return <BlockquoteComp key={index}>{renderBlocks(node.children, ctx)}</BlockquoteComp>;
      }
      return (
        <blockquote
          key={index}
          data-slot="markdown-blockquote"
          data-density={density}
          className={cn(
            "mx-0 border-s-2 border-solid border-[var(--color-border-emphasized)] ps-4 text-muted-foreground",
            margins,
            proseWidth,
          )}
        >
          {renderBlocks(node.children, ctx)}
        </blockquote>
      );
    }
    case "list": {
      // Task list: every item has a checked state
      const isTaskList = node.items.length > 0 && node.items.every((item) => item.checked != null);

      if (isTaskList) {
        return (
          <div key={index} data-slot="markdown-list" data-density={density} className={margins}>
            <div role="group" aria-label="Task list" className="-mx-2">
              <ul role="list" className="m-0 flex list-none flex-col gap-0.5 ps-0">
                {node.items.map((item, i) => (
                  <TaskListItem
                    key={i}
                    checked={item.checked === true}
                  >
                    {renderListItemLabel(item.children, ctx)}
                  </TaskListItem>
                ))}
              </ul>
            </div>
          </div>
        );
      }

      const ListTag = node.ordered ? "ol" : "ul";
      const start = node.ordered && node.start != null && node.start !== 1 ? node.start : undefined;
      return (
        <div key={index} data-slot="markdown-list" data-density={density} className={cn(margins, proseWidth)}>
          <ListTag
            role="list"
            start={start}
            className="-mx-2 m-0 flex list-none flex-col gap-0.5 ps-0"
            style={{ counterReset: start != null ? `markdown-list ${start - 1}` : "markdown-list" }}
          >
            {node.items.map((item, i) => (
              <li key={i} className={listItemClassName}>
                {node.ordered ? (
                  <span
                    className={cn(
                      bodySize,
                      "w-4 shrink-0 self-baseline leading-[1.4286] text-foreground before:content-[counter(markdown-list)_'.']",
                    )}
                  />
                ) : (
                  <span className="mt-[calc((1em*1.4286-6px)/2)] box-border flex w-4 shrink-0 items-center justify-center self-baseline">
                    <span className="size-1.5 rounded-full bg-foreground" />
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col text-start">
                  <span className={listLabelClassName}>{renderListItemLabel(item.children, ctx)}</span>
                </span>
              </li>
            ))}
          </ListTag>
        </div>
      );
    }
    case "table": {
      const colMinWidths = computeTableColumnMinWidths(node);

      return (
        <div
          key={index}
          // Keyboard-focusable so keyboard users can scroll a wide table.
          // role="group" (not "region") so several tables don't create
          // duplicate same-named landmarks.
          tabIndex={0}
          role="group"
          aria-label="Table"
          data-slot="markdown-table"
          data-density={density}
          className={cn("max-w-full overflow-x-auto", margins, blockWidth)}
        >
          <table className="w-full table-auto border-collapse border-spacing-0 font-[inherit] text-foreground">
            <thead>
              <tr>
                {node.headers.map((h, i) => (
                  <th
                    key={i}
                    style={{ minWidth: `${colMinWidths[i]}px` }}
                    className={cn(
                      "box-border max-w-0 truncate border-b border-solid border-border px-3 py-2 text-start text-[0.875rem] font-semibold text-muted-foreground first:ps-2 last:pe-2",
                      cellAlignClassNames[node.alignments[i] ?? "left"],
                    )}
                  >
                    {renderInlines(h.children, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => (
                <tr key={i} className="group/row">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={cn(
                        "box-border max-w-0 overflow-hidden border-b border-solid border-border px-3 py-2 align-middle [overflow-wrap:break-word] [word-break:break-word] first:ps-2 last:pe-2 group-last/row:border-b-0",
                        bodySize,
                        cellAlignClassNames[node.alignments[j] ?? "left"],
                      )}
                    >
                      {renderInlines(cell.children, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr": {
      const HrComp = components?.hr;
      if (HrComp) {
        return <HrComp key={index} />;
      }
      return (
        <hr
          key={index}
          data-slot="markdown-hr"
          data-density={density}
          className={cn("border-0 border-t border-solid border-border", margins)}
        />
      );
    }
    case "image": {
      const safeSrc = sanitizeUrl(node.src);
      if (safeSrc == null) {
        return (
          <div key={index} data-slot="markdown-image" data-density={density} className={margins}>
            [{node.alt}]
          </div>
        );
      }
      const ImageComp = components?.image;
      if (ImageComp) {
        return <ImageComp key={index} src={safeSrc} alt={node.alt} />;
      }
      return (
        <div key={index} data-slot="markdown-image" data-density={density} className={margins}>
          <img src={safeSrc} alt={node.alt} className="max-w-full rounded-[var(--radius-element)]" />
        </div>
      );
    }
  }
}

/** A read-only task list row: the checkbox mirrors `- [x]` and ignores clicks. */
function TaskListItem({ checked, children }: { checked: boolean; children: ReactNode }) {
  const labelId = useId();
  return (
    <li className={listItemClassName}>
      <span className="flex flex-none">
        <span className="relative isolate flex size-5 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            aria-readonly
            aria-labelledby={labelId}
            className="peer absolute z-1 m-0 size-5 cursor-pointer p-0 opacity-0"
          />
          <span
            aria-hidden
            className={cn(
              "flex size-5 items-center justify-center rounded-[var(--radius-inner)] border border-solid peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--primary)]",
              checked
                ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--color-border-emphasized)] bg-background text-[var(--primary)]",
            )}
          >
            {checked ? (
              <svg viewBox="0 0 10 10" className="block size-3">
                <path
                  d="M8.5 2.5L4 7.5L1.5 5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-start">
        <span id={labelId} className={listLabelClassName}>
          {children}
        </span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a markdown string. With `isStreaming`, bursty chunks are smoothed
 * into a steady reveal, parsed incrementally, and each new chunk fades in.
 */
export function Markdown({
  children,
  density = "default",
  headingLevelStart = 1,
  isStreaming = false,
  components,
  className,
  ...props
}: MarkdownProps) {
  // Smooth bursty streamed chunks into a steady character-by-character reveal.
  // When not streaming, the hook returns children unchanged (no-op).
  const smoothedText = useStreamingText(children, isStreaming);

  const incrementalStateRef = useRef<IncrementalState>(createIncrementalState());

  const blocks = useMemo(() => {
    if (isStreaming) {
      if (smoothedText === "") {
        incrementalStateRef.current = createIncrementalState();
        return [];
      }
      const input = trimStreamingArtifacts(smoothedText);
      return parseMarkdownIncremental(input, incrementalStateRef.current);
    }
    return parseMarkdown(children);
  }, [smoothedText, children, isStreaming]);

  // Recent boundaries for the stacked fade-in: one span per tick that is
  // still animating, so the oldest has just finished when it is evicted.
  const prevBlocksRef = useRef<BlockNode[]>([]);
  const boundariesRef = useRef<number[]>([]);
  const smoothedLen = smoothedText.length;
  const boundaries = useMemo(() => {
    void smoothedLen; // dep trigger
    const prevLen = countBlockTextLength(prevBlocksRef.current);
    const next = computeBoundaries(boundariesRef.current, prevLen, STREAMING_MAX_FADE_SPANS);
    boundariesRef.current = next;
    return next;
  }, [smoothedLen]);

  const ctx: RenderContext = {
    density,
    headingLevelStart,
    cursor: { offset: 0, boundaries, active: isStreaming },
    components,
  };

  const rendered = (
    <div
      role="document"
      data-slot="markdown"
      data-density={density}
      className={cn(
        bodySize,
        "w-full max-w-full min-w-0 font-sans leading-[1.4286] text-foreground [overflow-wrap:break-word]",
        className,
      )}
      {...props}
    >
      {renderBlocks(blocks, ctx)}
    </div>
  );

  // Store current blocks for next render's boundary calculation. Safe under
  // StrictMode: both invocations produce the same blocks.
  prevBlocksRef.current = blocks;

  return rendered;
}
