// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatSystemMessage.tsx and the
// labelled form of src/Divider/Divider.tsx (MIT).

import { useId, type ReactNode, type Ref } from "react";
import { cn } from "cn";
import { themeProps, type BaseProps } from "./theme-props";

export type ChatSystemMessageVariant = "default" | "divider";

export interface ChatSystemMessageProps extends BaseProps<HTMLDivElement> {
  /** Ref forwarded to the root element */
  ref?: Ref<HTMLDivElement>;

  /**
   * System message content — text or any ReactNode.
   */
  children: ReactNode;

  /**
   * Visual variant.
   * - 'default': plain centered text
   * - 'divider': text with horizontal lines on each side (date separator style)
   * @default 'default'
   */
  variant?: ChatSystemMessageVariant;

  /**
   * Optional icon rendered before the text.
   * Accepts any ReactNode — typically an Icon.
   */
  icon?: ReactNode;
}

/** Astryx `<Divider label={…} />`: a hairline on each side of a supporting-size label. */
function LabelledDivider({ label }: { label: ReactNode }) {
  const labelId = useId();
  // A separator doesn't take its name from its content, so the label is
  // referenced explicitly.
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-labelledby={label ? labelId : undefined}
      className="flex w-full items-center"
      data-variant="subtle"
      data-orientation="horizontal"
    >
      <div className="h-px shrink grow bg-[var(--color-border)]" />
      {label && (
        <div
          id={labelId}
          className="shrink-0 px-3 text-[length:var(--font-size-sm)] leading-[1.6667] text-[var(--color-text-secondary)]"
        >
          {label}
        </div>
      )}
      {label && <div className="h-px shrink grow bg-[var(--color-border)]" />}
    </div>
  );
}

export function ChatSystemMessage({
  children,
  variant = "default",
  icon,
  className,
  style: styleProp,
  ref,
  ...rest
}: ChatSystemMessageProps) {
  const theme = themeProps("chat-system-message", { variant });

  if (variant === "divider") {
    return (
      <div
        ref={ref}
        {...theme}
        className={cn(theme.className, "w-full", className)}
        style={styleProp}
        {...rest}
        role="status"
      >
        <LabelledDivider label={children} />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      {...theme}
      className={cn(
        theme.className,
        "flex items-center justify-center gap-2 py-1 text-center font-sans text-[length:var(--font-size-sm)] font-normal text-[var(--color-text-secondary)]",
        className,
      )}
      style={styleProp}
      {...rest}
      role="status"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        {icon != null && <span className="inline-flex shrink-0 items-center">{icon}</span>}
        {children}
      </span>
    </div>
  );
}

ChatSystemMessage.displayName = "ChatSystemMessage";
