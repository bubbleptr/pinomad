import type { ComponentProps, ReactNode } from "react";
import {
  ChatMessage as KitChatMessage,
  ChatMessageBubble as KitChatMessageBubble,
} from "@/shared/ui/chat-kit";
import { cn } from "cn";
import { IconButton, type IconButtonProps } from "@/shared/ui/icon-button";
import { Copy, ThumbsDown, ThumbsUp } from "@/shared/ui/icons";

type MessageSectionProps = ComponentProps<"div">;

/* Sender wrappers delegate alignment and density to the chat kit's ChatMessage;
   a caller's data-slot replaces the kit root's (rest props pass through). */
function ChatMessageUser({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <KitChatMessage
      className={`chat-message ${className}`.trim()}
      data-slot="chat-message-user"
      sender="user"
      {...rest}
    >
      {children}
    </KitChatMessage>
  );
}

function ChatMessageAssistant({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <KitChatMessage
      className={`chat-message ${className}`.trim()}
      data-slot="chat-message-assistant"
      sender="assistant"
      {...rest}
    >
      {children}
    </KitChatMessage>
  );
}

/* Filled bubble; the sender-colored background comes from ChatMessage context. */
function ChatMessageBubble({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <KitChatMessageBubble
      className={className || undefined}
      data-slot="chat-message-bubble"
      {...rest}
    >
      {children}
    </KitChatMessageBubble>
  );
}

function ChatMessageBody({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <div
      className={`chat-message__body ${className}`.trim()}
      data-slot="chat-message-body"
      {...rest}
    >
      {children}
    </div>
  );
}

function ChatMessageContent({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <div
      className={`chat-message__content ${className}`.trim()}
      data-slot="chat-message-content"
      {...rest}
    >
      {children}
    </div>
  );
}

type ChatMessageActionOwnProps = {
  "aria-label": string;
  tooltip?: string;
  onPress?: () => void;
  children?: ReactNode;
};

type ChatMessageActionProps = Omit<IconButtonProps, "label" | "icon" | "title" | "onClick" | "type" | "variant" | "size"> &
  ChatMessageActionOwnProps;

function ChatMessageAction({
  "aria-label": ariaLabel,
  tooltip,
  onPress,
  children,
  className,
  ...rest
}: ChatMessageActionProps) {
  return (
    <IconButton
      label={ariaLabel}
      icon={children}
      size="sm"
      // Quieter than the answer above it until hovered.
      className={cn("text-muted-foreground hover:text-foreground", className)}
      tooltip={tooltip}
      onClick={onPress}
      {...rest}
    />
  );
}

export function ChatMessageActions({ children, className = "", ...rest }: MessageSectionProps) {
  return (
    <div
      className={`chat-message__actions ${className}`.trim()}
      data-slot="chat-message-actions"
      {...rest}
    >
      {children}
    </div>
  );
}

function ChatMessageActionsCopy(props: Omit<ChatMessageActionProps, "children">) {
  return (
    <ChatMessageAction {...props}>
      <Copy aria-hidden="true" size={16} />
    </ChatMessageAction>
  );
}

function ChatMessageActionsThumbsUp(props: Omit<ChatMessageActionProps, "children">) {
  return (
    <ChatMessageAction {...props}>
      <ThumbsUp aria-hidden="true" size={16} />
    </ChatMessageAction>
  );
}

function ChatMessageActionsThumbsDown(props: Omit<ChatMessageActionProps, "children">) {
  return (
    <ChatMessageAction {...props}>
      <ThumbsDown aria-hidden="true" size={16} />
    </ChatMessageAction>
  );
}

ChatMessageActions.Copy = ChatMessageActionsCopy;
ChatMessageActions.ThumbsUp = ChatMessageActionsThumbsUp;
ChatMessageActions.ThumbsDown = ChatMessageActionsThumbsDown;

export const ChatMessage = {
  User: ChatMessageUser,
  Assistant: ChatMessageAssistant,
  Bubble: ChatMessageBubble,
  Body: ChatMessageBody,
  Content: ChatMessageContent,
  Action: ChatMessageAction,
};
