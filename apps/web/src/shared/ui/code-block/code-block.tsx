// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/CodeBlock/CodeBlock.tsx), MIT.

import "./code-block.css";
import { cn } from "cn";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconButton } from "@/shared/ui/icon-button";
import { ChevronRight } from "@/shared/ui/icons";
import { CopyIcon } from "@/shared/ui/copy-icon";
import { applyHighlightRangesChunked } from "./highlight-ranges";
import { SYNC_TOKENIZE_THRESHOLD, tokenize, tokenizeAsync, type SyntaxToken, type TokenLine } from "./tokenizer";

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

const LINE_CHUNK_SIZE = 20;
const LINE_CHUNK_THRESHOLD = 100;

/**
 * Memoized chunk component — cheaper than memoizing every individual line.
 */
const CodeChunk = memo(function CodeChunk({
  lines,
  startIndex,
  renderLineContent,
}: {
  lines: string[];
  startIndex: number;
  renderLineContent: (line: string, lineIndex: number) => ReactNode;
}) {
  return (
    <>
      {lines.map((line, j) => {
        const i = startIndex + j;
        return (
          <div key={i} data-line={i + 1} className="leading-[1.4286]">
            {renderLineContent(line, i)}
          </div>
        );
      })}
    </>
  );
});

function renderLines(lines: string[], renderLineContent: (line: string, lineIndex: number) => ReactNode): ReactNode {
  if (lines.length < LINE_CHUNK_THRESHOLD) {
    return <CodeChunk lines={lines} startIndex={0} renderLineContent={renderLineContent} />;
  }

  const chunks: ReactNode[] = [];
  for (let start = 0; start < lines.length; start += LINE_CHUNK_SIZE) {
    const end = Math.min(start + LINE_CHUNK_SIZE, lines.length);
    const chunkLines = lines.slice(start, end);
    chunks.push(
      <div
        key={start}
        className="[content-visibility:auto]"
        style={{ containIntrinsicBlockSize: `auto ${chunkLines.length}lh` }}
      >
        <CodeChunk lines={chunkLines} startIndex={start} renderLineContent={renderLineContent} />
      </div>,
    );
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasHighlightAPI(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

/**
 * Safari supports the Highlight API JS objects but has rendering issues
 * with ::highlight() in code blocks. Detect Safari (WebKit without Chrome)
 * so we can fall back to spans.
 */
function isSafari(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  return ua.includes("AppleWebKit") && !ua.includes("Chrome");
}

/**
 * Per-line tokens: synchronous below SYNC_TOKENIZE_THRESHOLD characters,
 * otherwise tokenized off the critical path and shown plain until done.
 */
function useTokenLines(code: string, language: string): TokenLine[] {
  const [asyncTokenResult, setAsyncTokenResult] = useState<{
    code: string;
    language: string;
    tokens: TokenLine[];
  } | null>(null);

  const syncTokens = useMemo(() => {
    if (code.length >= SYNC_TOKENIZE_THRESHOLD) {
      return null;
    }
    return tokenize(code, language);
  }, [code, language]);

  useEffect(() => {
    if (code.length < SYNC_TOKENIZE_THRESHOLD) {
      return;
    }

    const abortController = new AbortController();

    async function tokenizeLargeCode() {
      try {
        const tokens = await tokenizeAsync(code, language, abortController.signal);
        if (!abortController.signal.aborted) {
          setAsyncTokenResult({ code, language, tokens });
        }
      } catch {
        if (!abortController.signal.aborted) {
          setAsyncTokenResult({ code, language, tokens: [] });
        }
      }
    }

    void tokenizeLargeCode();

    return () => {
      abortController.abort();
    };
  }, [code, language]);

  if (syncTokens != null) {
    return syncTokens;
  }

  if (asyncTokenResult?.code === code && asyncTokenResult.language === language) {
    return asyncTokenResult.tokens;
  }

  return [];
}

const codeClassName =
  "m-0 block flex-1 px-4 py-3 font-mono text-[0.875rem] text-[var(--syntax-variable)] [tab-size:2]";
const codeNoWrapClassName = "whitespace-pre break-normal [overflow-wrap:normal]";
const codeWrapClassName = "whitespace-pre-wrap break-all [overflow-wrap:break-word]";

// ---------------------------------------------------------------------------
// Span-mode code element
// ---------------------------------------------------------------------------

function buildSpanLine(lineText: string, tokens: SyntaxToken[]): ReactNode {
  if (tokens.length === 0) {
    return lineText || "​";
  }

  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const token of tokens) {
    if (token.start > cursor) {
      parts.push(lineText.slice(cursor, token.start));
    }
    const end = Math.min(token.end, lineText.length);
    parts.push(
      <span key={`${token.start}-${token.type}`} className={`token-${token.type}`}>
        {lineText.slice(token.start, end)}
      </span>,
    );
    cursor = end;
  }

  if (cursor < lineText.length) {
    parts.push(lineText.slice(cursor));
  }
  return parts.length > 0 ? parts : "​";
}

function SpanCodeContent({
  lines,
  tokenLines,
  isWrapped,
}: {
  lines: string[];
  tokenLines: TokenLine[];
  isWrapped: boolean;
}) {
  const renderLineContent = useCallback(
    (line: string, lineIndex: number): ReactNode => (
      <span className="min-w-0">{buildSpanLine(line, tokenLines[lineIndex] ?? [])}</span>
    ),
    [tokenLines],
  );

  return (
    <code className={cn(codeClassName, isWrapped ? codeWrapClassName : codeNoWrapClassName)}>
      {renderLines(lines, renderLineContent)}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Range-mode code element
// ---------------------------------------------------------------------------

function RangeCodeContent({
  lines,
  tokenLines,
  isWrapped,
}: {
  lines: string[];
  tokenLines: TokenLine[];
  isWrapped: boolean;
}) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!hasHighlightAPI()) {
      return;
    }

    const codeEl = codeRef.current;
    if (!codeEl || tokenLines.length === 0) {
      return;
    }

    return applyHighlightRangesChunked(codeEl, tokenLines);
  }, [tokenLines]);

  // Range mode keeps the line's text as a bare text node (its firstChild) so
  // applyHighlightRangesChunked can map token offsets onto it — no wrapper.
  const renderLineContent = useCallback((line: string): ReactNode => line || "​", []);

  return (
    <code ref={codeRef} className={cn(codeClassName, isWrapped ? codeWrapClassName : codeNoWrapClassName)}>
      {renderLines(lines, renderLineContent)}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type CodeBlockProps = Omit<ComponentProps<"pre">, "children"> & {
  code: string;
  /** Tokenizer language; also shown as the header label unless `plaintext`. */
  language?: string;
  title?: string;
  hasLanguageLabel?: boolean;
  hasCopyButton?: boolean;
  onCopy?: () => void;
  isWrapped?: boolean;
  /** Let the header collapse blocks of at least `collapsibleThreshold` lines. */
  isCollapsible?: boolean;
  collapsibleThreshold?: number;
  /**
   * Any CSS width. `fit-content` shrinks to the longest line, with a floor
   * of min(100%, 400px).
   */
  width?: string;
};

/**
 * Read-only code display with syntax highlighting and a copy button.
 */
function CodeBlock({
  code,
  language = "plaintext",
  title,
  hasLanguageLabel = true,
  hasCopyButton = true,
  onCopy,
  isWrapped = false,
  isCollapsible = false,
  collapsibleThreshold = 10,
  width = "fit-content",
  className,
  style,
  ...props
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending "copied" reset when the block unmounts.
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current != null) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const useSpans = !hasHighlightAPI() || isSafari();

  const lines = useMemo(() => {
    const l = code.split("\n");
    if (l.length > 1 && l[l.length - 1] === "") {
      l.pop();
    }
    return l;
  }, [code]);

  const tokenLines = useTokenLines(code, language);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      onCopy?.();
      // Restart the reset timer on every copy — otherwise a rapid re-copy
      // is reverted early by the previous click's timer.
      if (copyResetTimerRef.current != null) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => {
        copyResetTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard failures leave the copied state unchanged.
    }
  }, [code, onCopy]);

  const languageLabel = hasLanguageLabel && language !== "plaintext" ? language : null;
  const showHeader = title != null || languageLabel != null;

  const canCollapse = isCollapsible && lines.length >= collapsibleThreshold;
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Links the collapsible header to the code region it shows/hides. The
  // region stays mounted when collapsed, so aria-controls always resolves.
  const regionId = useId();

  const copyButtonEl = hasCopyButton ? (
    <IconButton
      label={copied ? "Copied" : "Copy code"}
      icon={<CopyIcon copied={copied} />}
      size="sm"
      onClick={(e) => {
        // Stop propagation so copying does not toggle the collapsible header.
        e.stopPropagation();
        void handleCopy();
      }}
      // Offsets that leave the icon where the 24px button had it: the header
      // row keeps its height, and without a header the button hangs 2px past
      // the block's clipped edge, so its focus ring is drawn inset. Important,
      // so the Settings rule for a card's trailing icon button (styles.css)
      // does not move it.
      className={cn(
        "text-[var(--syntax-comment)]",
        showHeader ? "-my-0.5 -me-2.5!" : "absolute -end-0.5 top-1.5 me-0! focus-visible:ring-inset",
      )}
    />
  ) : null;

  const headerEl = showHeader ? (
    <div className="sticky top-0 z-1 flex items-center justify-between bg-[var(--syntax-background)] px-4 py-2">
      <div
        role={canCollapse ? "button" : undefined}
        tabIndex={canCollapse ? 0 : undefined}
        aria-expanded={canCollapse ? !isCollapsed : undefined}
        aria-controls={canCollapse ? regionId : undefined}
        onClick={canCollapse ? () => setIsCollapsed((prev) => !prev) : undefined}
        onKeyDown={
          canCollapse
            ? (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIsCollapsed((prev) => !prev);
                }
              }
            : undefined
        }
        className={cn(
          "flex min-w-0 flex-1 items-center border-0 bg-transparent p-0 text-start",
          canCollapse &&
            "cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]",
        )}
      >
        <span className="m-0 flex items-center font-mono text-[0.75rem] leading-[1.6667] font-medium text-[var(--syntax-comment)]">
          {canCollapse && (
            <span
              className={cn(
                "me-1 inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-[var(--syntax-comment)] transition-transform duration-[125ms] ease-[var(--ease-standard)] [animation:code-block-chevron-reveal_300ms_var(--ease-standard)] motion-reduce:[animation:none]",
                !isCollapsed && "rotate-90",
              )}
            >
              <ChevronRight size={12} aria-hidden />
            </span>
          )}
          {title}
          {title && languageLabel ? " — " : ""}
          {languageLabel}
        </span>
      </div>
      {copyButtonEl}
    </div>
  ) : null;

  const codeBody = (
    // The scroll container is keyboard-focusable so keyboard users can
    // scroll long or wide code. role="group" (not "region") so several
    // blocks on a page don't create duplicate same-named landmarks.
    <div tabIndex={0} role="group" aria-label={languageLabel ?? "Code"} className="overflow-auto">
      <div className={cn("flex min-w-fit", showHeader && "-mt-2")}>
        {useSpans ? (
          <SpanCodeContent lines={lines} tokenLines={tokenLines} isWrapped={isWrapped} />
        ) : (
          <RangeCodeContent lines={lines} tokenLines={tokenLines} isWrapped={isWrapped} />
        )}
      </div>
    </div>
  );

  return (
    <pre
      data-slot="code-block"
      data-language={language}
      className={cn(
        "relative isolate m-0 flex flex-col overflow-hidden rounded-[var(--radius-element)] border border-border bg-[var(--syntax-background)] font-mono text-[0.875rem] leading-[1.4286]",
        width === "fit-content" && "w-fit max-w-full min-w-[min(100%,400px)]",
        className,
      )}
      style={width === "fit-content" ? style : { width, ...style }}
      {...props}
    >
      {headerEl}
      {canCollapse ? (
        <div
          id={regionId}
          // Collapsed is only a 0fr grid row; inert also drops the region
          // from the tab order and accessibility tree.
          inert={isCollapsed ? true : undefined}
          className={cn(
            "grid grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-[var(--ease-standard)]",
            isCollapsed && "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">{codeBody}</div>
        </div>
      ) : (
        codeBody
      )}
      {!showHeader && copyButtonEl}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </pre>
  );
}

export { CodeBlock, type CodeBlockProps };
