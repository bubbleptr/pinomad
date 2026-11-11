// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatLayout.tsx (MIT).
//
// Layout contract: the root is a flex column. The message area flexes
// (grow 1, shrink 0) to fill the space the dock doesn't need; the sticky dock
// keeps its natural height in flow. Short content therefore fills exactly
// 100% with no overflow, and long content grows past the root so self-scroll
// mode scrolls. In external-scrollRef mode the dock is position: fixed (out
// of flow) and the message area fills the root.

import { type ReactNode, type Ref, type RefObject, useMemo, useRef } from "react";
import { cn } from "cn";
import { useChatStreamScroll } from "./use-chat-stream-scroll";
import { useChatNewMessages } from "./use-chat-new-messages";
import { ChatLayoutScrollButton } from "./chat-layout-scroll-button";
import { ChatLayoutContext } from "./chat-context";
import { mergeRefs, themeProps, type BaseProps } from "./theme-props";

// =============================================================================
// Types
// =============================================================================

type Density = "compact" | "balanced" | "spacious";

export interface ChatLayoutProps extends BaseProps<HTMLDivElement> {
  /** Ref forwarded to the root element. */
  ref?: Ref<HTMLDivElement>;

  /**
   * Message content — flows naturally in the page, scrolls with the page.
   * Typically ChatMessageList with ChatMessage children.
   */
  children: ReactNode;

  /**
   * Composer element — fixed to the bottom with a frosted glass dock.
   * Typically ChatComposer.
   */
  composer: ReactNode;

  /**
   * Content shown when children is empty.
   */
  emptyState?: ReactNode;

  /**
   * Scroll-to-bottom button rendered above the composer in the dock.
   * Defaults to ChatLayoutScrollButton with useChatStreamScroll.
   * Pass a custom ReactNode to override, or `null` to hide.
   */
  scrollButton?: ReactNode | null;

  /**
   * External scroll container ref. When provided, auto-scroll and
   * scroll-to-bottom target this element instead of the layout root.
   *
   * When omitted, the layout root itself is the scroll container.
   */
  scrollRef?: RefObject<HTMLElement | null>;

  /**
   * Layout density. Controls spacing, max-width, and blur layer sizing.
   *
   * @default 'balanced'
   */
  density?: Density;

  "data-testid"?: string;
}

// =============================================================================
// Styles
// =============================================================================

const densityStyles = {
  compact: {
    messageArea: "max-w-full px-0",
    blurLayer: "h-20 [mask-image:linear-gradient(to_bottom,transparent,black_24px)]",
    dock: "px-2 pb-2",
    dockInner: "max-w-full",
  },
  balanced: {
    messageArea: "max-w-full px-0",
    blurLayer: "h-[100px] [mask-image:linear-gradient(to_bottom,transparent,black_36px)]",
    dock: "px-3 pb-3",
    dockInner: "max-w-full",
  },
  spacious: {
    messageArea: "max-w-[800px] px-4",
    blurLayer: "h-[120px] [mask-image:linear-gradient(to_bottom,transparent,black_48px)]",
    dock: "px-4 pb-3",
    dockInner: "max-w-[800px]",
  },
} as const;

// =============================================================================
// Helpers
// =============================================================================

function hasVisibleContent(children: ReactNode): boolean {
  if (children == null || children === false) {
    return false;
  }
  if (Array.isArray(children) && children.length === 0) {
    return false;
  }
  return true;
}

// =============================================================================
// Component
// =============================================================================

export function ChatLayout({
  children,
  composer,
  density = "balanced",
  emptyState,
  scrollButton,
  scrollRef: externalScrollRef,
  className,
  style,
  "data-testid": testId,
  ref,
  ...rest
}: ChatLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const scrollContainerRef = externalScrollRef ?? rootRef;
  const isSelfScrolling = !externalScrollRef;

  // --- Default scroll behavior ---
  const scroll = useChatStreamScroll({ scrollRef: scrollContainerRef });
  const newMsgs = useChatNewMessages({
    isLocked: scroll.isLocked,
    onResize: scroll.scrollIfLocked,
  });

  const defaultScrollButton = (
    <ChatLayoutScrollButton
      isVisible={scroll.isScrolledUp || newMsgs.hasNewMessages}
      label={newMsgs.hasNewMessages ? "New messages" : undefined}
      onClick={() => {
        newMsgs.dismiss();
        scroll.scrollToBottom();
      }}
    />
  );

  // --- Layout context ---
  const layoutContext = useMemo(
    () => ({ scrollContainerRef, contentRef: newMsgs.contentRef }),
    [scrollContainerRef, newMsgs.contentRef],
  );

  // --- Derived styles ---
  const showEmpty = !hasVisibleContent(children);
  const currentDensity = densityStyles[density];
  const theme = themeProps("chat-layout", { density });

  return (
    <ChatLayoutContext value={layoutContext}>
      <div
        {...theme}
        {...rest}
        ref={mergeRefs(ref, rootRef)}
        data-testid={testId}
        className={cn(
          theme.className,
          "relative flex min-h-0 flex-1 flex-col [container-type:inline-size]",
          // The scrollbar hides while a programmatic scroll animates, so it
          // does not flash.
          isSelfScrolling && "overflow-x-hidden overflow-y-auto",
          className,
        )}
        style={style}
      >
        {/* Message area */}
        <div
          className={cn(
            "mx-auto flex w-full max-w-full shrink-0 grow basis-auto flex-col px-0 pb-6",
            currentDensity.messageArea,
          )}
        >
          {showEmpty && emptyState ? (
            <div className="flex min-h-[200px] flex-1 items-center justify-center">{emptyState}</div>
          ) : (
            children
          )}
        </div>

        {/* Dock container — sticky/fixed, holds blur + scroll button + composer */}
        <div
          className={cn(
            "pointer-events-none inset-x-0 bottom-0 isolate z-0 shrink-0",
            isSelfScrolling ? "sticky" : "fixed",
          )}
        >
          {/* Scroll-to-bottom button */}
          {scrollButton === undefined ? defaultScrollButton : scrollButton}

          {/* Frosted glass layer */}
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 backdrop-blur-[12px]",
              currentDensity.blurLayer,
            )}
          />

          {/* Composer */}
          <div className={cn("pointer-events-auto relative z-[1]", currentDensity.dock)}>
            <div className={cn("mx-auto w-full", currentDensity.dockInner)}>{composer}</div>
          </div>
        </div>
      </div>
    </ChatLayoutContext>
  );
}

ChatLayout.displayName = "ChatLayout";
