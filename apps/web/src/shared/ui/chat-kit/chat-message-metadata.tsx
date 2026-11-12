// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessageMetadata.tsx (MIT).

import type { ReactNode, Ref } from "react";
import { cn } from "cn";
import { useChatMessageContext } from "./chat-context";
import { ChatKitIcon, type ChatKitIconName } from "./chat-kit-icons";
import { themeProps, type BaseProps } from "./theme-props";

export type ChatMessageStatus = "sending" | "sent" | "delivered" | "read" | "error";

const STATUS_CONFIG: Record<ChatMessageStatus, { icon: ChatKitIconName; label: string }> = {
  sending: { icon: "clock", label: "Sending" },
  sent: { icon: "check", label: "Sent" },
  delivered: { icon: "checkDouble", label: "Delivered" },
  read: { icon: "checkDouble", label: "Read" },
  error: { icon: "error", label: "Failed" },
};

export interface ChatMessageMetadataProps extends BaseProps<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
  /** Timestamp content — ReactNode (e.g. Timestamp) or string. */
  timestamp?: ReactNode;
  /** Footer content — model info, ratings, reactions. */
  footer?: ReactNode;
  /** Message delivery status. */
  status?: ChatMessageStatus;
  /**
   * Replaces the visible status words ("Sending", "Sent"…). Astryx read
   * these from its i18n catalog, which callers relabelled through
   * `InternationalizationProvider` overrides.
   */
  statusLabels?: Partial<Record<ChatMessageStatus, string>>;
}

export function ChatMessageMetadata({
  ref,
  timestamp,
  footer,
  status,
  statusLabels,
  className,
  style,
  ...rest
}: ChatMessageMetadataProps) {
  const msgContext = useChatMessageContext();
  const sender = msgContext?.sender ?? "assistant";

  const statusConfig = status != null ? STATUS_CONFIG[status] : null;
  const statusLabel = status != null && statusConfig != null ? (statusLabels?.[status] ?? statusConfig.label) : "";

  const hasContent = timestamp != null || footer != null || statusConfig != null;
  if (!hasContent) {
    return null;
  }

  const theme = themeProps("chat-message-metadata");

  return (
    <div
      ref={ref}
      {...theme}
      className={cn(
        theme.className,
        "mt-1 flex items-center gap-1 text-[length:var(--font-size-sm)] leading-[1.6667] font-normal text-[var(--muted-foreground)]",
        sender === "user" ? "flex-row-reverse" : "flex-row",
        className,
      )}
      style={style}
      {...rest}
    >
      {timestamp != null && <span>{timestamp}</span>}
      {timestamp != null && (footer != null || statusConfig != null) && <span>·</span>}
      {footer != null && footer}
      {footer != null && statusConfig != null && <span>·</span>}
      {statusConfig != null && (
        <span
          title={statusLabel}
          aria-label={`Message ${statusLabel.toLowerCase()}`}
          className={cn(
            "inline-flex items-center gap-1",
            status === "error" && "text-[var(--destructive-strong)]",
            // Tailwind's pulse keyframes (opacity 1 → 0.5 → 1) at Astryx's timing.
            status === "sending" &&
              "animate-pulse [animation-duration:1.5s] [animation-timing-function:ease-in-out] motion-reduce:animate-none",
          )}
        >
          <ChatKitIcon name={statusConfig.icon} size="xsm" />
          <span>{statusLabel}</span>
        </span>
      )}
    </div>
  );
}

ChatMessageMetadata.displayName = "ChatMessageMetadata";
