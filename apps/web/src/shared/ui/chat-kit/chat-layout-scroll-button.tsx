// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatLayoutScrollButton.tsx (MIT).

import type { Ref } from "react";
import { cn } from "cn";
import { ChatActionButton } from "./chat-action-button";
import { ChatKitIcon } from "./chat-kit-icons";
import type { BaseProps } from "./theme-props";

// =============================================================================
// Types
// =============================================================================

export interface ChatLayoutScrollButtonProps extends Omit<BaseProps<HTMLDivElement>, "onClick"> {
  ref?: Ref<HTMLDivElement>;
  /** Whether the button is visible. */
  isVisible: boolean;
  /** Optional label — expands the button (e.g. "New messages"). */
  label?: string;
  /** Click handler. */
  onClick: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Floating scroll-to-bottom button for use inside ChatLayout.
 *
 * @example
 * ```
 * <ChatLayoutScrollButton isVisible={!isAtBottom} onClick={scrollToBottom} />
 * ```
 */
export function ChatLayoutScrollButton({
  ref,
  isVisible,
  label,
  onClick,
  className,
  style,
  ...rest
}: ChatLayoutScrollButtonProps) {
  return (
    <div ref={ref} className={cn("flex justify-center pb-3", className)} style={style} {...rest}>
      <div
        className={cn(
          "pointer-events-auto h-8 overflow-hidden rounded-[var(--radius-full)] bg-[var(--color-background-popover)] [contain:layout_style]",
          "[box-shadow:var(--shadow-med)]",
          "transition-[opacity,transform,max-width] duration-[var(--duration-fast-max)] ease-[var(--ease-standard)] motion-reduce:duration-0",
          isVisible ? "pointer-events-auto opacity-100" : "pointer-events-none max-w-8 opacity-0",
          label ? "max-w-[200px]" : "max-w-8",
        )}
      >
        <ChatActionButton
          label={label ?? "Scroll to bottom"}
          aria-label={label ?? "Scroll to bottom"}
          icon={<ChatKitIcon name="chevronDown" size="md" />}
          variant="ghost"
          size="md"
          onClick={onClick}
          // Astryx sets --radius-element to full on the button itself, so the
          // pill's hover fill keeps the pill shape.
          className={cn("px-2 whitespace-nowrap [--radius-element:var(--radius-full)]", label ? "pe-3" : null)}
        >
          {label ?? undefined}
        </ChatActionButton>
      </div>
    </div>
  );
}

ChatLayoutScrollButton.displayName = "ChatLayoutScrollButton";
