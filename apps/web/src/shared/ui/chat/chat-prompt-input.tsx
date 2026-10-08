// Simplified port of Pace's shared/ui/chat/chat-prompt-input.tsx (PiGUI
// commit 15b9084): tokens, triggers, attachments and leading-token rehydrate
// are dropped. Kept: the caller-owned submit contract (the composer must not
// force-clear a failed draft), focus/focusAtEnd handles, Pace's
// allowSubmitWhileRunning behavior (always on — we steer), brand accent,
// status, startActions/footer/endActions slots.
import { type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  ChatSendButton,
} from "@astryxdesign/core/Chat";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type ChatPromptInputHandle = {
  focus(): void;
  /** Focus and put the caret after the last character. */
  focusAtEnd(): void;
};

function editableOf(root: HTMLDivElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[aria-multiline="true"]') ?? null;
}

/**
 * Astryx contentEditable composer input. Submit is intercepted in onKeyDown
 * (the built-in Enter path force-clears the value before the caller can
 * keep a failed draft), and the missing placeholder/disabled attributes are
 * patched locally — no swizzle.
 */
function PromptComposerInput({
  disabled = false,
  placeholder,
  inputRef,
  onSubmitRequest,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  onSubmitRequest: () => void;
  value: string;
  onValueChange?: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ChatComposerInputHandle | null>(null);

  useEffect(() => {
    if (!inputRef) {
      return;
    }
    inputRef.current = {
      focus: () => composerRef.current?.focus(),
      focusAtEnd: () => {
        const editable = editableOf(rootRef.current);
        if (!editable) {
          return;
        }
        editable.focus();
        const selection = window.getSelection();
        if (!selection) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      },
    };
    return () => {
      inputRef.current = null;
    };
  }, [inputRef]);

  useEffect(() => {
    // Astryx 0.3.0 sets aria-multiline/aria-label (and the role) on the
    // editable, but the placeholder lives on a separate aria-hidden div and
    // disabled state only flips contentEditable. E2E and assistive tech look
    // for aria-placeholder and aria-disabled on the editable.
    const editable = editableOf(rootRef.current);
    if (!editable) {
      return;
    }
    if (placeholder) {
      editable.setAttribute("aria-placeholder", placeholder);
    } else {
      editable.removeAttribute("aria-placeholder");
    }
    if (disabled) {
      editable.setAttribute("aria-disabled", "true");
    } else {
      editable.removeAttribute("aria-disabled");
    }
  }, [placeholder, disabled]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME confirmation belongs to text entry; 229 covers composition ending before keydown.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    // Shift+Enter inserts a newline; Enter and Cmd/Ctrl+Enter submit.
    if (event.shiftKey) {
      return;
    }
    event.preventDefault();
    // Submit through our own path: the composer's built-in Enter handler
    // clears the editable itself, but the caller owns clearing (a failed
    // submit must keep the draft). defaultPrevented keeps the built-in
    // path from running.
    onSubmitRequest();
  };

  return (
    <ChatComposerInput
      ref={rootRef}
      className="prompt-input__input"
      handleRef={composerRef}
      hasHistory={false}
      isDisabled={disabled}
      label="Prompt"
      pasteAsToken={false}
      placeholder={placeholder}
      value={value}
      onChange={(next) => onValueChange?.(next)}
      onKeyDown={handleKeyDown}
    />
  );
}

type ChatPromptInputOwnProps = {
  value: string;
  status?: PromptInputStatus;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  /** Disable the editable; controls inside the slots take their own flags. */
  isDisabled?: boolean;
  startActions?: ReactNode;
  endActions?: ReactNode;
  /**
   * One row of chrome under the composer — where the conversation runs and
   * its branch. It keeps its height whatever it holds, so a draft and a live
   * composer are the same size (Pace docs/design/chat.md).
   */
  footer?: ReactNode;
  error?: string | null;
  /**
   * Opt-in Pi-mark border (Pace docs/design/brand.md): a 1px coral/yellow/blue
   * gradient ring that appears on focus and animates while `status` is
   * submitted/streaming.
   */
  accent?: "brand";
  /**
   * Show the static ring on focus as well. Reserved for the draft home,
   * where the composer is the page; inside a conversation the ring only
   * marks a run in flight, so focus leaves it transparent.
   */
  accentFocusRing?: boolean;
  onSubmit?: () => void;
  onStop?: () => void;
  onValueChange?: (value: string) => void;
};

export type ChatPromptInputProps = Omit<
  ComponentProps<"div">,
  keyof ChatPromptInputOwnProps | "children"
> &
  ChatPromptInputOwnProps;

export function ChatPromptInput({
  value,
  status = "ready",
  className = "",
  placeholder,
  inputRef,
  isDisabled = false,
  startActions,
  endActions,
  footer,
  error,
  accent,
  accentFocusRing = false,
  onSubmit,
  onStop,
  onValueChange,
  ...rest
}: ChatPromptInputProps) {
  const isRunning = status === "streaming" || status === "submitted";
  const isStopShown = isRunning && !value.trim() && Boolean(onStop);
  // Pace's allowSubmitWhileRunning is always on here: typing mid-run steers
  // or queues, so a non-empty draft is always submittable.
  const canSubmit = Boolean(value.trim());

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    onSubmit?.();
  };

  return (
    <div
      className={`prompt-input ${className}`.trim()}
      data-accent={accent}
      data-accent-focus={accent && accentFocusRing ? "" : undefined}
      data-slot="prompt-input"
      data-status={status}
      {...rest}
    >
      <ChatComposer
        elevation="low"
        footerActions={startActions}
        input={
          <PromptComposerInput
            disabled={isDisabled}
            inputRef={inputRef}
            placeholder={placeholder}
            value={value}
            onValueChange={onValueChange}
            onSubmitRequest={handleSubmit}
          />
        }
        isStopShown={isStopShown}
        placeholder={placeholder}
        sendActions={endActions}
        sendButton={
          <ChatSendButton
            className="pigui-pressable"
            isDisabled={!isStopShown && (!canSubmit || isDisabled)}
            // Bypass the composer's submit path, which force-clears the value.
            onSend={handleSubmit}
          />
        }
        status={error ? { type: "error", message: error } : undefined}
        value={value}
        onChange={(next) => onValueChange?.(next)}
        onStop={onStop}
        onSubmit={handleSubmit}
      />
      {footer ? (
        <div className="prompt-input__footer" data-slot="prompt-input-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
