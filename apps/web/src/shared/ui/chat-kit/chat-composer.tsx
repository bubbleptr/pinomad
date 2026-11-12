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
  /**
   * Resting elevation of the composer body. `low` (the default) keeps today's
   * raised look — low at rest, bumping to med on hover / focus. `none` flattens
   * it and draws a border with the same rest / hover / focus treatment as a
   * text input (emphasized border → accent on focus, with matching inset rings).
   * @default 'low'
   */
  elevation?: "none" | "low";

  // --- Slot props ---

  /** Collapsible drawer rendered above the input — attachments, context chips, etc. Use ChatComposerDrawer. */
  drawer?: ReactNode;
  /** Actions rendered on the left side of the header (e.g. attach, mention buttons). Use icon-only `size="sm"` buttons. */
  headerActions?: ReactNode;
  /** Contextual info rendered on the right side of the header (e.g. context window usage, ProgressBar). */
  headerContext?: ReactNode;
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

// Component CSS vars, overridable from outside (chat.css does):
// --_chat-composer-radius (28px, the chat radius) and --_chat-composer-padding
// (--spacing-3). Buttons follow the shell's curvature through --_button-radius:
// 28px − 12px = 16px fully rounds a 32px button.
const rootClass =
  "relative z-0 isolate flex flex-col [--_chat-composer-radius:28px] [--_chat-composer-padding:var(--spacing-3)] [--_button-radius:max(var(--radius-element),calc(var(--_chat-composer-radius)_-_var(--_chat-composer-padding)))]";

const bodyClass =
  "relative z-[2] flex cursor-text flex-col gap-2 rounded-[var(--_chat-composer-radius)] bg-[var(--popover)] p-[var(--_chat-composer-padding)] transition-[box-shadow,border-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]";

// --shadow-low / --shadow-med come from tokens.css; chat.css redefines
// --shadow-low on the composer root.
const elevationClasses = {
  low: "[box-shadow:var(--shadow-low)] hover:[box-shadow:var(--shadow-med)] focus-within:[box-shadow:var(--shadow-med)]",
  // The border is drawn inside the padding, so content geometry matches the
  // elevated case.
  none: "border border-solid border-[var(--border-strong)] p-[calc(var(--_chat-composer-padding)_-_1px)] [box-shadow:none] focus-within:border-[var(--primary)] hover:not-focus-within:[box-shadow:inset_0_0_0_2px_color-mix(in_srgb,var(--border-strong)_30%,transparent)] focus-within:[box-shadow:inset_0_0_0_2px_light-dark(#f1f1f1,#262626)]",
} as const;

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
 * Layout shell for a chat composer with slots for drawer, input,
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
    elevation = "low",
    drawer,
    headerActions,
    headerContext,
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
        {drawer}

        <div
          ref={bodyRef}
          onClick={handleBodyClick}
          className={cn(
            bodyClass,
            elevationClasses[elevation],
            density === "compact" && "gap-1 [--_chat-composer-padding:var(--spacing-2)]",
          )}
        >
          {(headerActions || headerContext) && (
            <div className="flex min-h-7 items-center justify-between gap-2">
              <div className="flex items-center gap-1">{headerActions}</div>
              <div className="ms-auto flex items-center gap-2 text-[length:var(--font-size-sm)] leading-[1.6667] text-[var(--muted-foreground)]">
                {headerContext}
              </div>
            </div>
          )}

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
