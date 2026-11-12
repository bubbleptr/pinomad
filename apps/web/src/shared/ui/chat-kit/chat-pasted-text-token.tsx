// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatPastedTextToken.tsx (MIT).
// Astryx's HoverCard becomes Base UI's PreviewCard, with the same delays,
// placement and surface.

import { PreviewCard } from "@base-ui/react/preview-card";
import { Button } from "@/shared/ui/button";
import { ChatBadge } from "./chat-badge";

// =============================================================================
// Types
// =============================================================================

export interface ChatPastedTextTokenProps {
  /** The full pasted text. */
  text: string;
  /** Called when the user clicks Expand — dissolves the token into editable text. */
  onExpand?: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

function formatLabel(text: string): string {
  const lines = text.split("\n").length;
  const chars = text.length;
  return lines > 1 ? `${lines} lines, ${chars} chars` : `${chars} chars`;
}

// =============================================================================
// Component
// =============================================================================

export function ChatPastedTextToken({ text, onExpand }: ChatPastedTextTokenProps) {
  const label = formatLabel(text);

  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={300}
        closeDelay={200}
        render={(props) => <ChatBadge {...props} label={label} variant="neutral" />}
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" align="start" sideOffset={4}>
          <PreviewCard.Popup className="rounded-[var(--radius-container)] bg-[var(--surface)] p-3 font-sans [box-shadow:var(--shadow-med)]">
            <div className="flex max-w-[480px] flex-col gap-2">
              <div className="max-h-60 overflow-y-auto font-mono text-[length:var(--font-size-sm)] leading-[1.6667] [word-break:break-word] whitespace-pre-wrap text-[var(--foreground)]">
                {text}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[length:var(--font-size-sm)] text-[var(--muted-foreground)]">{label}</span>
                {onExpand && (
                  <Button variant="ghost" size="sm" onClick={onExpand}>
                    Expand
                  </Button>
                )}
              </div>
            </div>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

ChatPastedTextToken.displayName = "ChatPastedTextToken";
