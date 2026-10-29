import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Skeleton } from "@astryxdesign/core/Skeleton";

/**
 * A conversation while its first view is on its way: a sent message and the
 * run's reply in the transcript's column and spacing, settled at the bottom
 * where the transcript opens — the same shapes as iOS's ConversationSkeleton.
 * Hidden for its first moment (`.chat-skeleton`), so a fast load goes
 * straight to the content instead of flashing bones.
 */
export function ConversationSkeleton() {
  return (
    <div role="status" className="chat-skeleton mx-auto mt-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
      <span className="sr-only">Loading conversation…</span>
      <Bubble width={200} index={0} />
      <Reply lines={["100%", "100%", 220]} index={1} />
      <Bubble width={150} index={5} />
      <Reply lines={["100%", "100%", "100%", 160]} index={6} />
    </div>
  );
}

function Bubble({ width, index }: { width: number; index: number }) {
  return (
    <div aria-hidden="true" className="flex justify-end">
      <Skeleton width={width} height={40} radius={4} index={index} />
    </div>
  );
}

/** The trace capsule, then the answer's lines. */
function Reply({ lines, index }: { lines: (number | string)[]; index: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      <div className="pb-1">
        <Skeleton width={128} height={28} radius="rounded" index={index} />
      </div>
      {lines.map((width, line) => (
        <Skeleton key={line} width={width} height={12} radius="rounded" index={index + line + 1} />
      ))}
    </div>
  );
}

/** The composer's outline while the conversation it would send to loads. */
export function ComposerSkeleton() {
  return (
    <div aria-hidden="true" className="chat-skeleton">
      <Skeleton height={92} radius={4} />
    </div>
  );
}

/**
 * The opened conversation could not be shown: the host ended its stream
 * (archived, deleted) or the connection dropped before it arrived. `missing`
 * means the host's list no longer has it, so retrying cannot help.
 */
export function ConversationUnavailable({
  missing,
  connected,
  onRetry,
}: {
  missing: boolean;
  connected: boolean;
  onRetry: () => void;
}) {
  return missing ? (
    <EmptyState title="Conversation not found" description="It was archived or deleted on another device." />
  ) : (
    <EmptyState
      title="Couldn't open this conversation"
      description={connected ? "The host didn't send it." : "The connection dropped before it arrived."}
      actions={<Button label="Try again" variant="secondary" onClick={onRetry} isDisabled={!connected} />}
    />
  );
}
