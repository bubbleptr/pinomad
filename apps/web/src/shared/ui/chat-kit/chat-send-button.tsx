// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatSendButton.tsx (MIT).

import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "cn";
import { ChatActionButton } from "./chat-action-button";
import { ChatKitGlyph } from "./chat-kit-icons";
import { useChatComposerContext } from "./chat-context";
import { themeProps } from "./theme-props";

// =============================================================================
// Types
// =============================================================================

export interface ChatSendButtonProps extends Omit<ComponentProps<"button">, "children" | "disabled" | "onClick"> {
  ref?: Ref<HTMLButtonElement>;
  /** Whether the stop button is shown instead of the send button. @default false */
  isStopShown?: boolean;
  /** Whether the send button is disabled. Defaults to `!canSend` from context. */
  isDisabled?: boolean;
  /** Called when the user clicks the send button. Defaults to context onSubmit. */
  onSend?: () => void;
  /** Called when the user clicks the stop button. */
  onStop?: () => void;
  /** Icon for the send state. */
  sendIcon?: ReactNode;
  /** Icon for the stop state. */
  stopIcon?: ReactNode;
  /** Button size. @default 'md' */
  size?: "sm" | "md";
}

// =============================================================================
// Component
// =============================================================================

/**
 * Circular send/stop toggle button for the chat composer.
 *
 * Reads state from ChatComposerContext by default. Override any value
 * via props for standalone usage.
 *
 * @example
 * ```
 * <ChatComposer onSubmit={handleSubmit} sendButton={<ChatSendButton />} />
 * ```
 */
export function ChatSendButton(props: ChatSendButtonProps): ReactNode {
  const context = useChatComposerContext();

  const {
    isStopShown = context?.isStopShown ?? false,
    isDisabled = !(context?.canSend ?? false),
    onSend,
    onStop = context?.onStop,
    sendIcon,
    stopIcon,
    size = "md",
    className,
    style,
    ref,
    ...rest
  } = props;

  const handleSend = onSend ?? (() => context?.onSubmit(""));
  const theme = themeProps("chat-send-button");

  return (
    <ChatActionButton
      ref={ref}
      label={isStopShown ? "Stop" : "Send"}
      variant={isStopShown ? "secondary" : "primary"}
      size={size}
      icon={isStopShown ? (stopIcon ?? <ChatKitGlyph name="stop" />) : (sendIcon ?? <ChatKitGlyph name="arrowUp" />)}
      isIconOnly
      isDisabled={!isStopShown && isDisabled}
      onClick={isStopShown ? onStop : handleSend}
      {...rest}
      className={cn(theme.className, "shrink-0 rounded-[var(--_button-radius,var(--radius-full))]", className)}
      style={style}
    />
  );
}

ChatSendButton.displayName = "ChatSendButton";
