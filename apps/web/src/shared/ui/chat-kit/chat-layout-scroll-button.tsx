// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatLayoutScrollButton.tsx (MIT).

import type { Ref } from "react";
import { cn } from "cn";
import { Button } from "@/shared/ui/button";
import { ChatKitGlyph } from "./chat-kit-icons";
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
          "pointer-events-auto h-8 overflow-hidden rounded-[var(--radius-full)] bg-[var(--popover)] [contain:layout_style]",
          "[box-shadow:var(--shadow-med)]",
          "transition-[opacity,transform,max-width] duration-[var(--duration-fast-max)] ease-[var(--ease-standard)] motion-reduce:duration-0",
          isVisible ? "pointer-events-auto opacity-100" : "pointer-events-none max-w-8 opacity-0",
          label ? "max-w-[200px]" : "max-w-8",
        )}
      >
        {/* 7px and 11px: with the button's 1px border, 8px to the icon and 12px after the label. */}
        <Button
          aria-label={label ?? "Scroll to bottom"}
          variant="ghost"
          onClick={onClick}
          className={cn("rounded-full px-[7px]", label ? "pe-[11px]" : null)}
        >
          <ChatKitGlyph name="chevronDown" />
          {label}
        </Button>
      </div>
    </div>
  );
}

ChatLayoutScrollButton.displayName = "ChatLayoutScrollButton";
