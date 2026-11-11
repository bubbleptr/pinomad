// The Astryx Chat components the app uses, ported to Tailwind (ADR-0048,
// docs/licenses/astryx.md). Export names and props match the originals.

export { ChatComposer } from "./chat-composer";
export type { ChatComposerProps, ChatComposerStatus, ChatComposerDensity } from "./chat-composer";

export { ChatSendButton } from "./chat-send-button";
export type { ChatSendButtonProps } from "./chat-send-button";

export { ChatComposerDrawer } from "./chat-composer-drawer";
export type { ChatComposerDrawerProps } from "./chat-composer-drawer";

export { ChatComposerInput, ChatComposerTokenElement } from "./chat-composer-input";
export type {
  ChatComposerInputProps,
  ChatComposerInputHandle,
  ChatComposerToken,
  ChatComposerTrigger,
  ChatComposerTriggerItem,
} from "./chat-composer-input";

export { ChatMessageList } from "./chat-message-list";
export type { ChatMessageListProps } from "./chat-message-list";

export { ChatMessage } from "./chat-message";
export type { ChatMessageProps } from "./chat-message";

export { ChatMessageBubble } from "./chat-message-bubble";
export type { ChatMessageBubbleProps, ChatMessageBubbleVariant } from "./chat-message-bubble";

export { ChatMessageMetadata } from "./chat-message-metadata";
export type { ChatMessageMetadataProps, ChatMessageStatus } from "./chat-message-metadata";

export { ChatSystemMessage } from "./chat-system-message";
export type { ChatSystemMessageProps, ChatSystemMessageVariant } from "./chat-system-message";

export { ChatToolCalls } from "./chat-tool-calls";
export type { ChatToolCallsProps, ChatToolCallItem, ChatToolCallStatus } from "./chat-tool-calls";

export { useChatStreamScroll } from "./use-chat-stream-scroll";
export type {
  ChatScrollToBottomOptions,
  UseChatStreamScrollOptions,
  UseChatStreamScrollReturn,
} from "./use-chat-stream-scroll";
export { useChatNewMessages } from "./use-chat-new-messages";
export type { UseChatNewMessagesOptions, UseChatNewMessagesReturn } from "./use-chat-new-messages";

export { useChatPasteAsToken } from "./use-chat-paste-as-token";
export type { UseChatPasteAsTokenOptions, UseChatPasteAsTokenReturn } from "./use-chat-paste-as-token";
export { useChatComposerTokens } from "./use-chat-composer-tokens";
export type { UseChatComposerTokensOptions, UseChatComposerTokensReturn, TokenPortal } from "./use-chat-composer-tokens";

export type { ChatMessageSender, ChatDensity } from "./chat-context";
export { useChatLayoutContext, useChatComposerContext } from "./chat-context";
export type { ChatComposerContextValue, ChatComposerInputControl } from "./chat-context";

export { ChatLayout } from "./chat-layout";
export type { ChatLayoutProps } from "./chat-layout";
export { ChatLayoutScrollButton } from "./chat-layout-scroll-button";
export type { ChatLayoutScrollButtonProps } from "./chat-layout-scroll-button";
