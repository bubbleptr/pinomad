// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessageBubble.tsx (MIT).

import type { ReactNode, Ref } from "react";
import { cn } from "cn";
import { useChatMessageContext } from "./chat-context";
import { themeProps, type BaseProps } from "./theme-props";

export type ChatMessageBubbleVariant = "filled" | "ghost";

export interface ChatMessageBubbleProps extends BaseProps<HTMLDivElement> {
  /** Ref forwarded to the root element */
  ref?: Ref<HTMLDivElement>;

  /**
   * Bubble content — text, Markdown, or any ReactNode.
   */
  children: ReactNode;

  /**
   * Visual variant.
   * - 'filled': background color based on sender (default)
   * - 'ghost': no background, but keeps padding for consistent alignment
   * @default 'filled'
   */
  variant?: ChatMessageBubbleVariant;

  /**
   * Sender name rendered above the bubble, aligned with bubble text padding.
   */
  name?: ReactNode;

  /**
   * Metadata content rendered below the bubble, aligned with bubble text padding.
   */
  metadata?: ReactNode;

  /**
   * Position within a multi-bubble group.
   * Controls corner radius reduction on the sender side.
   * - 'first': bottom sender-side corner tightened
   * - 'middle': both sender-side corners tightened
   * - 'last': top sender-side corner tightened
   * Leave unset for standalone bubbles (full radius).
   */
  group?: "first" | "middle" | "last";

  "data-testid"?: string;
}

// =============================================================================
// Styles
// =============================================================================

// Bubbles use the 28px chat radius: rounder than cards in the same view.
const contentClass =
  "flex max-w-[max(80%,280px)] flex-col rounded-[28px] font-sans text-[length:var(--font-size-base)] leading-[1.4286] [overflow-wrap:break-word] [word-break:break-word]";

const paddingClasses = {
  compact: "px-4 py-3",
  balanced: "px-4 py-3",
  spacious: "px-5 py-4",
} as const;

const metadataPaddingClasses = {
  compact: "px-4",
  balanced: "px-4",
  spacious: "px-5",
} as const;

// Grouped corners use logical radii, so the tail follows reading direction:
// the assistant tucks toward the start of the line, the user toward the end.
const groupClasses = {
  assistant: {
    first: "rounded-es-[var(--radius-inner)]",
    middle: "rounded-ss-[var(--radius-inner)] rounded-es-[var(--radius-inner)]",
    last: "rounded-ss-[var(--radius-inner)]",
  },
  user: {
    first: "rounded-ee-[var(--radius-inner)]",
    middle: "rounded-se-[var(--radius-inner)] rounded-ee-[var(--radius-inner)]",
    last: "rounded-se-[var(--radius-inner)]",
  },
} as const;

// =============================================================================
// Component
// =============================================================================

export function ChatMessageBubble({
  children,
  variant = "filled",
  name,
  metadata,
  group,
  className,
  style: styleProp,
  "data-testid": testId,
  ref,
  ...rest
}: ChatMessageBubbleProps) {
  const msgContext = useChatMessageContext();
  const sender = msgContext?.sender ?? "assistant";
  const density = msgContext?.density ?? "balanced";

  const isUser = sender === "user";
  const theme = themeProps("chat-message-bubble", { sender, variant, density });

  return (
    <>
      {name && (
        <div
          data-chat-name
          className={cn(metadataPaddingClasses[density], "-mb-1.5 flex h-5 items-center", isUser && "text-end")}
        >
          {name}
        </div>
      )}
      <div
        {...theme}
        {...rest}
        ref={ref}
        data-testid={testId}
        className={cn(
          theme.className,
          contentClass,
          density === "compact" && "rounded-[var(--radius-container)]",
          // Sender backgrounds share a default; the data-sender attribute
          // leaves room to tell them apart.
          variant === "ghost"
            ? "bg-transparent text-[var(--foreground)]"
            : "bg-[var(--default)] text-[var(--foreground)]",
          paddingClasses[density],
          variant === "ghost" && "py-0",
          group == null ? null : groupClasses[isUser ? "user" : "assistant"][group],
          className,
        )}
        style={styleProp}
      >
        {children}
      </div>
      {metadata && (
        <div className={cn(metadataPaddingClasses[density], "-mt-1.5", isUser && "text-end")}>{metadata}</div>
      )}
    </>
  );
}

ChatMessageBubble.displayName = "ChatMessageBubble";
