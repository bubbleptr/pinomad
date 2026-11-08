// One family root's background processes (ADR-0045). Tasks and the header's
// activity dot both read the root's document, so moving between a root and
// its forks never shows the fork's (nonexistent) copy.
import { useEffect, useState } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ProcessListState, RemoteProcesses } from "@pinomad/protocol/remote-durable.ts";

/** The root's list, or undefined until it is the current root's (or while drafting). */
export function useProcessList(
  processes: RemoteProcesses,
  rootId: ConversationId | undefined,
): ProcessListState | undefined {
  const [shown, setShown] = useState<{ rootId: ConversationId; state: ProcessListState }>();
  useEffect(() => {
    if (rootId === undefined) return;
    return processes.watch(rootId, (state) => setShown({ rootId, state }));
  }, [processes, rootId]);
  if (rootId === undefined) return undefined;
  return shown?.rootId === rootId ? shown.state : undefined;
}
