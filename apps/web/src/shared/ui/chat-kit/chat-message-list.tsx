// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessageList.tsx (MIT).
//
// A role="log" container for a chat history: density context, configurable
// gap, empty state, a spacer that pushes messages to the bottom, and an
// infinite-scroll sentinel. Auto-scroll and the scroll-to-bottom button
// belong to ChatLayout.

import { type ReactNode, type Ref, useEffect, useMemo, useRef, useTransition } from "react";
import { cn } from "cn";
import { ChatListContext, type ChatDensity, useChatLayoutContext } from "./chat-context";
import { ChatSpinner } from "./chat-spinner";
import { themeProps, type BaseProps } from "./theme-props";

export type SpacingStep = 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 | 8 | 10;

export interface ChatMessageListProps extends BaseProps<HTMLDivElement> {
  /** Ref forwarded to the root element */
  ref?: Ref<HTMLDivElement>;

  /**
   * Message elements — typically ChatMessage components.
   * Also accepts Divider (date separators) or any ReactNode.
   */
  children: ReactNode;

  /**
   * Custom content when the list has no messages.
   */
  emptyState?: ReactNode;

  /**
   * Async action when the user scrolls to the top.
   * Use for loading older messages. Wrapped in useTransition —
   * shows a spinner at the top while pending.
   */
  scrollToTopAction?: () => Promise<void>;

  /**
   * Visual density — flows to child messages via context.
   * Individual messages can override.
   * @default 'balanced'
   */
  density?: ChatDensity;

  /**
   * Gap between top-level message rows, using the spacing scale.
   * Defaults to the selected density's gap.
   */
  gap?: SpacingStep;

  /**
   * Whether an assistant message is actively streaming into the list.
   * Marks the log `aria-busy="true"` so assistive tech announces the
   * completed message once instead of every partial mutation.
   *
   * @default false
   */
  isStreaming?: boolean;

  "data-testid"?: string;
}

// =============================================================================
// Styles
// =============================================================================

const densityGapClasses = {
  compact: "gap-2 px-3 py-2",
  balanced: "gap-4 p-4",
  spacious: "gap-6 p-6",
} as const;

const gapClasses: Record<SpacingStep, string> = {
  0: "gap-0",
  0.5: "gap-0.5",
  1: "gap-1",
  1.5: "gap-1.5",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  10: "gap-10",
};

// =============================================================================
// Component
// =============================================================================

export function ChatMessageList({
  children,
  emptyState,
  scrollToTopAction,
  density = "balanced",
  gap,
  isStreaming = false,
  className,
  style,
  "data-testid": testId,
  ref,
  ...rest
}: ChatMessageListProps) {
  const layoutContext = useChatLayoutContext();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [isLoadingTop, startTransition] = useTransition();

  // Register inner content element with the layout for height observation
  useEffect(() => {
    if (layoutContext?.contentRef && innerRef.current) {
      layoutContext.contentRef(innerRef.current);
      return () => layoutContext.contentRef(null);
    }
  }, [layoutContext]);

  const hasChildren = children != null && children !== false && !(Array.isArray(children) && children.length === 0);

  // IntersectionObserver for scroll-to-top infinite scroll
  useEffect(() => {
    const scrollContainer = layoutContext?.scrollContainerRef?.current;
    if (!scrollToTopAction || !sentinelRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          startTransition(async () => {
            await scrollToTopAction();
          });
        }
      },
      { root: scrollContainer ?? null, threshold: 0 },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [scrollToTopAction, layoutContext]);

  const contextValue = useMemo(() => ({ density }), [density]);
  const theme = themeProps("chat-message-list", { density });

  return (
    <ChatListContext value={contextValue}>
      <div
        {...rest}
        ref={ref}
        role="log"
        aria-live="polite"
        aria-busy={isStreaming || undefined}
        tabIndex={0}
        data-testid={testId}
        {...theme}
        className={cn(theme.className, "flex min-h-0 flex-1 flex-col", className)}
        style={style}
      >
        <div
          ref={innerRef}
          className={cn("flex min-h-0 flex-1 flex-col", densityGapClasses[density], gap == null ? null : gapClasses[gap])}
        >
          {/* Sentinel for infinite scroll */}
          {scrollToTopAction && <div ref={sentinelRef} aria-hidden />}

          {/* Loading spinner at top */}
          {isLoadingTop && (
            <div className="flex justify-center py-3">
              <ChatSpinner size="md" />
            </div>
          )}

          {/* Spacer pushes messages to bottom when list isn't full */}
          <div className="min-h-0 flex-1" aria-hidden />

          {/* Messages or empty state */}
          {hasChildren ? (
            children
          ) : emptyState ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">{emptyState}</div>
          ) : null}
        </div>
      </div>
    </ChatListContext>
  );
}

ChatMessageList.displayName = "ChatMessageList";
