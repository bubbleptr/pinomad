// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessage.tsx (MIT).

import { type ReactNode, type Ref, useMemo, useId } from "react";
import { cn } from "cn";
import { ChatMessageContext, useChatListContext, type ChatMessageSender, type ChatDensity } from "./chat-context";
import { themeProps, type BaseProps } from "./theme-props";

export interface ChatMessageProps extends BaseProps<HTMLElement> {
  ref?: Ref<HTMLElement>;
  sender: ChatMessageSender;
  children: ReactNode;
  avatar?: ReactNode;
  /**
   * Sender name rendered above the message body.
   * Use when the first child is raw content (not a bubble).
   * If the first child is a ChatMessageBubble, put the name on the
   * bubble's `name` prop instead — it aligns with the bubble's padding.
   */
  name?: ReactNode;
  /**
   * Metadata rendered below the message body.
   * Use when the last child is raw content (not a bubble).
   * If the last child is a ChatMessageBubble, put metadata on the
   * bubble's `metadata` prop instead — it aligns with the bubble's padding.
   */
  metadata?: ReactNode;
  density?: ChatDensity;
  "data-testid"?: string;
}

const rootGap = { compact: "gap-1.5", balanced: "gap-2", spacious: "gap-3" } as const;
const childrenGap = { compact: "gap-0.5", balanced: "gap-1", spacious: "gap-1.5" } as const;

const rootAlignment = {
  system: "flex-row justify-center",
  user: "flex-row-reverse justify-start",
  assistant: "flex-row justify-start",
} as const;

const columnAlignment = {
  system: "max-w-[90%] items-center",
  user: "items-end",
  assistant: "items-start",
} as const;

const childrenAlignment = {
  system: "items-center",
  user: "items-end",
  assistant: "items-start",
} as const;

export function ChatMessage({
  sender,
  children,
  avatar,
  name,
  metadata,
  density: densityProp,
  className,
  style: styleProp,
  "data-testid": testId,
  ref,
  ...rest
}: ChatMessageProps) {
  const listContext = useChatListContext();
  const density = densityProp ?? listContext?.density ?? "balanced";

  const contextValue = useMemo(() => ({ sender, density }), [sender, density]);

  const isSystem = sender === "system";
  const hasAvatar = avatar != null && !isSystem;
  const hasName = name != null && !isSystem;
  const nameId = useId();
  const theme = themeProps("chat-message", { sender, density });

  return (
    <ChatMessageContext value={contextValue}>
      <article
        {...theme}
        {...rest}
        data-chat-message=""
        ref={ref}
        data-testid={testId}
        aria-label={!hasName ? `Message from ${sender}` : undefined}
        aria-labelledby={hasName ? nameId : undefined}
        className={cn(
          theme.className,
          "flex max-w-full items-start",
          rootAlignment[sender],
          hasAvatar && rootGap[density],
          className,
        )}
        style={styleProp}
      >
        {hasAvatar && <div className="shrink-0 [&:has(~*_[data-chat-name])]:mt-5">{avatar}</div>}

        <div className={cn("flex min-w-0 flex-1 flex-col", columnAlignment[sender])}>
          {hasName && (
            <div
              id={nameId}
              className="mb-1 text-[length:var(--font-size-sm)] leading-[1.6667] font-semibold text-[var(--muted-foreground)]"
            >
              {name}
            </div>
          )}

          <div className={cn("flex w-full min-w-0 flex-col", childrenAlignment[sender], childrenGap[density])}>
            {children}
          </div>

          {metadata != null && !isSystem && <div>{metadata}</div>}
        </div>
      </article>
    </ChatMessageContext>
  );
}

ChatMessage.displayName = "ChatMessage";
