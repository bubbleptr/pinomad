// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/Code/Code.tsx), MIT.

import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * Inline code: monospace on the inset fill, sized like code blocks and
 * taking the line height of the text around it. For fenced code with
 * highlighting, use CodeBlock.
 */
function Code({ className, ...props }: ComponentProps<"code">) {
  return (
    <code
      data-slot="code"
      className={cn(
        "rounded-[var(--radius-inner)] bg-surface-muted px-1 py-0 font-mono text-[0.875rem] leading-[inherit] text-foreground [overflow-wrap:break-word] [word-break:break-word]",
        className,
      )}
      {...props}
    />
  );
}

export { Code };
