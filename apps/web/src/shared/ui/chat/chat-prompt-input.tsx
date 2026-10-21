// Simplified port of Pace's shared/ui/chat/chat-prompt-input.tsx (PiGUI
// commit 15b9084): tokens and leading-token rehydrate are dropped. Kept: the
// caller-owned submit contract (the composer must not force-clear a failed
// draft), focus/focusAtEnd handles, Pace's allowSubmitWhileRunning behavior
// (always on — we steer), status, startActions/footer/endActions
// slots, the attachments drawer, and trigger menus (callers pass Astryx
// ChatComposerTrigger[]; an open menu consumes Enter/Arrows/Escape before our
// submit path, so Enter selects rather than sends).
import { type ComponentProps, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerTrigger,
  ChatSendButton,
} from "@astryxdesign/core/Chat";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type ChatPromptInputHandle = {
  focus(): void;
  /** Focus and put the caret after the last character. */
  focusAtEnd(): void;
  /**
   * Re-dispatch an `input` event on the editable, but only while it holds
   * the focus. Async trigger-menu candidates push through this so Astryx
   * re-runs its search; scoping to this editable keeps a sibling composer's
   * landed listing from being dispatched into the wrong input.
   */
  emitInput(): void;
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
  onFiles,
  triggers,
}: {
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<ChatPromptInputHandle | null>;
  onSubmitRequest: () => void;
  value: string;
  onValueChange?: (value: string) => void;
  onFiles?: (files: File[]) => void;
  /** Trigger menus (e.g. @agent); undefined keeps the editable a plain textbox. */
  triggers?: readonly ChatComposerTrigger[];
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
      emitInput: () => {
        const editable = editableOf(rootRef.current);
        // Only this composer's editable may be re-activated — with the main
        // composer and a thread composer mounted together, an @ listing can
        // land while the user is typing in the other one.
        if (editable !== null && (document.activeElement === editable || editable.contains(document.activeElement))) {
          editable.dispatchEvent(new Event("input", { bubbles: true }));
        }
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
      {...(onFiles === undefined ? {} : { onFiles })}
      {...(triggers === undefined ? {} : { triggers: [...triggers] })}
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
  /** Block only submission (a named-agent problem the user must fix elsewhere) — typing and the slots stay live. */
  submitDisabled?: boolean;
  /** Staged content rendered above the input (attached images). */
  attachments?: ReactNode;
  /** Non-text content is staged, so an empty draft may still submit. */
  hasAttachments?: boolean;
  /** Pasted or dropped files, for the caller to stage as attachments. */
  onFiles?: (files: File[]) => void;
  /**
   * Trigger menus (e.g. @agent mentions). With triggers configured Astryx
   * gives the editable role="combobox" — pass nothing for a plain textbox.
   */
  triggers?: readonly ChatComposerTrigger[];
  startActions?: ReactNode;
  endActions?: ReactNode;
  /**
   * One row of chrome under the composer — where the conversation runs and
   * its branch. It keeps its height whatever it holds, so a draft and a live
   * composer are the same size (Pace docs/design/chat.md).
   */
  footer?: ReactNode;
  error?: string | null;
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
  submitDisabled = false,
  attachments,
  hasAttachments,
  onFiles,
  triggers,
  startActions,
  endActions,
  footer,
  error,
  onSubmit,
  onStop,
  onValueChange,
  ...rest
}: ChatPromptInputProps) {
  const isRunning = status === "streaming" || status === "submitted";
  const isStopShown = isRunning && !value.trim() && hasAttachments !== true && Boolean(onStop);
  // Pace's allowSubmitWhileRunning is always on here: typing mid-run steers
  // or queues, so a non-empty draft is always submittable — unless the caller
  // blocks it outright (a draft problem the user must resolve first).
  const canSubmit = !submitDisabled && (Boolean(value.trim()) || hasAttachments === true);

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    onSubmit?.();
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (onFiles === undefined || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    // A text drop belongs to the editable's own drag-and-drop; only file
    // drops are the composer's business.
    if (onFiles === undefined || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      className={`prompt-input ${className}`.trim()}
      data-slot="prompt-input"
      data-status={status}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      {...rest}
    >
      <ChatComposer
        elevation="low"
        {...(attachments === undefined ? {} : { drawer: <ChatComposerDrawer>{attachments}</ChatComposerDrawer> })}
        footerActions={startActions}
        input={
          <PromptComposerInput
            disabled={isDisabled}
            inputRef={inputRef}
            placeholder={placeholder}
            value={value}
            onValueChange={onValueChange}
            onSubmitRequest={handleSubmit}
            onFiles={onFiles}
            triggers={triggers}
          />
        }
        // ChatSendButton never disables in stop mode (`!isStopShown &&
        // isDisabled`), so while disabled the stop state is hidden entirely:
        // the send button renders in its place, disabled.
        isStopShown={isStopShown && !isDisabled}
        placeholder={placeholder}
        sendActions={endActions}
        sendButton={
          <ChatSendButton
            className="pigui-pressable"
            isDisabled={isDisabled || (!isStopShown && !canSubmit)}
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
