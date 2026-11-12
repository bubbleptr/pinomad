// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatComposer.tsx (MIT).

import { useState, useCallback, useRef, useMemo, type MouseEvent, type ReactNode, type Ref } from "react";
import { cn } from "cn";
import { ChatKitIcon } from "./chat-kit-icons";
import { ChatComposerInput } from "./chat-composer-input";
import { ChatComposerContext } from "./chat-context";
import type { ChatComposerInputControl } from "./chat-context";
import { ChatSendButton } from "./chat-send-button";
import { themeProps, type BaseProps } from "./theme-props";

// =============================================================================
// Types
// =============================================================================

export type ChatComposerStatus = {
  type: "error" | "warning";
  message?: string;
};

export type ChatComposerDensity = "compact" | "balanced" | "spacious";

export interface ChatComposerProps extends Omit<BaseProps<HTMLDivElement>, "onChange" | "onSubmit"> {
  ref?: Ref<HTMLDivElement>;
  /** Called when the user submits the message */
  onSubmit: (value: string) => void;
  /** Called when the user clicks the stop button */
  onStop?: () => void;
  /** Whether the stop button is shown instead of the send button. @default false */
  isStopShown?: boolean;
  /** Controlled value of the input */
  value?: string;
  /** Called when the input value changes */
  onChange?: (value: string) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Whether the composer is disabled */
  isDisabled?: boolean;
  /** Density variant */
  density?: ChatComposerDensity;
  // --- Slot props ---

  /** A row inside the shell, above the input: staged attachments, context chips. */
  header?: ReactNode;
  /** Custom input element — replaces the default textarea */
  input?: ReactNode;
  /** Actions rendered on the left side of the footer. Use `size="md"` buttons to match the send button height. */
  footerActions?: ReactNode;
  /** Actions rendered to the left of the send button. Use `size="md"` buttons to match the send button height. */
  sendActions?: ReactNode;
  /** Custom send button — replaces the default */
  sendButton?: ReactNode;
  /** Status message rendered below (or above) the composer body */
  status?: ChatComposerStatus;
  /** Where to render the status. @default 'bottom' */
  statusPosition?: "top" | "bottom";
}

// =============================================================================
// Styles
// =============================================================================

// The shell follows shadcn's prompt input: a filled box with no edge or lift
// at rest. The editor is focused most of the time, so its focus (not that of
// the buttons inside, which draw their own ring) is a gray edge rather than a
// text field's blue ring; forced colors get an outline.
const rootClass =
  "relative z-0 isolate flex flex-col [--_chat-composer-radius:18px] [--_chat-composer-padding:var(--spacing-2)]";

const bodyClass = cn(
  "relative z-[2] flex cursor-text flex-col gap-3 rounded-[var(--_chat-composer-radius)] border border-transparent bg-[var(--surface-field)] p-[calc(var(--_chat-composer-padding)_-_1px)] transition-[border-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
  "has-[[aria-multiline=true]:focus]:border-[var(--border-strong)]",
  "forced-colors:border-[CanvasText] forced-colors:has-[[aria-multiline=true]:focus]:outline-2 forced-colors:has-[[aria-multiline=true]:focus]:outline-offset-2 forced-colors:has-[[aria-multiline=true]:focus]:outline-[Highlight]",
);

const statusClass =
  "relative z-0 flex items-center gap-2 px-4 font-sans text-[length:var(--font-size-sm)] leading-[1.6667]";

const statusPositionClasses = {
  top: "pt-[var(--_chat-composer-padding)] pb-[calc(var(--_chat-composer-padding)_+_var(--_chat-composer-radius))] mb-[calc(-1_*_var(--_chat-composer-radius))] rounded-t-[var(--_chat-composer-radius)]",
  bottom:
    "pt-[calc(var(--_chat-composer-padding)_+_var(--_chat-composer-radius))] pb-[var(--_chat-composer-padding)] mt-[calc(-1_*_var(--_chat-composer-radius))] rounded-b-[var(--_chat-composer-radius)]",
} as const;

const statusTypeClasses = {
  error: "bg-[var(--destructive-muted)] text-[light-dark(#89001a,#ffc6c1)]",
  warning: "bg-[light-dark(#f8da9d,#deb4333D)] text-[light-dark(#584400,#fdcf4f)]",
} as const;

// =============================================================================
// Component
// =============================================================================

/**
 * Layout shell for a chat composer with slots for a header row, input,
 * actions, and a send button.
 *
 * @example
 * ```
 * <ChatComposer
 *   onSubmit={(value) => console.log(value)}
 *   placeholder="Type a message..."
 * />
 * ```
 */
export function ChatComposer(props: ChatComposerProps) {
  const {
    ref,
    onSubmit,
    onStop,
    isStopShown = false,
    value: controlledValue,
    onChange,
    placeholder: placeholderFromProps,
    isDisabled = false,
    density = "balanced",
    header,
    input,
    footerActions,
    sendActions,
    sendButton,
    status,
    statusPosition = "bottom",
    className,
    style,
    ...rest
  } = props;
  const placeholder = placeholderFromProps ?? "Type a message…";

  const [internalValue, setInternalValue] = useState("");

  const isControlled = controlledValue !== undefined;
  const currentValue = isControlled ? controlledValue : internalValue;

  const updateValue = useCallback(
    (newValue: string) => {
      if (!isControlled) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);
    },
    [isControlled, onChange],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = currentValue.trim();
    if (!trimmed || isDisabled) {
      return;
    }
    onSubmit(trimmed);
    updateValue("");
  }, [currentValue, isDisabled, onSubmit, updateValue]);

  const canSend = currentValue.trim().length > 0 && !isDisabled;

  const bodyRef = useRef<HTMLDivElement>(null);

  // Input slot registers its focus (and future) control here so the shell can
  // drive it without knowing its DOM shape. Stable ref — safe in the memoized
  // context value.
  const inputControlRef = useRef<ChatComposerInputControl | null>(null);

  const handleBodyClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    // Focus the input when clicking empty space in the body.
    // Skip if the click target is a button, link, or interactive element.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, [role="button"], [contenteditable="true"], [data-chat-token]')) {
      return;
    }
    // Prefer the input's registered control (works for any input shape,
    // including editors whose focusable node isn't a bare
    // contenteditable/textarea). Fall back to a DOM query so uninstrumented
    // custom inputs still get click-to-focus.
    if (inputControlRef.current) {
      inputControlRef.current.focus();
      return;
    }
    const editable = bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
    editable?.focus();
  }, []);

  const statusEl = status ? (
    <div
      role={status.type === "error" ? "alert" : "status"}
      className={cn(statusClass, statusPositionClasses[statusPosition], statusTypeClasses[status.type])}
    >
      <ChatKitIcon
        name={status.type === "error" ? "error" : "warning"}
        size="md"
        className={status.type === "error" ? "text-[var(--destructive-strong)]" : "text-[var(--warning)]"}
      />
      {status.message}
    </div>
  ) : null;

  const composerContext = useMemo(
    () => ({
      value: currentValue,
      onChange: updateValue,
      onSubmit: handleSubmit,
      placeholder,
      isDisabled,
      isStopShown,
      canSend,
      onStop,
      inputControlRef,
    }),
    [currentValue, updateValue, handleSubmit, placeholder, isDisabled, isStopShown, canSend, onStop],
  );

  const theme = themeProps("chat-composer", { density });

  return (
    <ChatComposerContext value={composerContext}>
      <div
        ref={ref}
        {...theme}
        className={cn(theme.className, rootClass, isDisabled && "pointer-events-none opacity-60", className)}
        style={style}
        {...rest}
      >
        {statusPosition === "top" && statusEl}
        <div
          ref={bodyRef}
          onClick={handleBodyClick}
          className={cn(
            bodyClass,
            density === "compact" && "gap-1",
          )}
        >
          {header ? <div className="cursor-default px-1 pt-1">{header}</div> : null}

          <div className="flex flex-col">{input ?? <ChatComposerInput />}</div>

          <div className="flex min-h-8 items-center justify-between gap-2">
            <div className="flex items-center gap-1">{footerActions}</div>
            <div className="flex items-center gap-1">
              {sendActions}
              {sendButton ?? <ChatSendButton />}
            </div>
          </div>
        </div>

        {statusPosition === "bottom" && statusEl}
      </div>
    </ChatComposerContext>
  );
}

ChatComposer.displayName = "ChatComposer";
