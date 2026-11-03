// The Changes surface (ADR-0040): the shown conversation's checkout diff. It
// follows the main column's conversation, not the family — a pre-ADR-0019
// fork may own its worktree — and fetches only while shown: on show, on every
// conversation change, when the connection returns and once a run settles.
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import {
  branchOf,
  ChangeFigure,
  changeStatOf,
  type ChangeStat,
  type ChangesResult,
} from "../../entities/conversation/change-stat.tsx";
import { DiffView } from "../../presentation/diff.tsx";
import { GitBranch, RefreshCw } from "../../shared/ui/icons.tsx";
import { SurfaceBar } from "./surface-bar.tsx";

export function ChangesSurface({
  view,
  remote,
  busy,
  barStart,
  barEnd,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The shown conversation is running; its edits are still landing. */
  busy: boolean;
  barStart?: ReactNode;
  barEnd?: ReactNode;
}) {
  const conversationId = view.conversation?.conversation.id;
  const connected = view.connection === "connected";
  const [result, setResult] = useState<ChangesResult | "failed">();
  // A slow answer for the previous conversation must not paint over this one.
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const request = ++latest.current;
    remote.controller.changes().then(
      (answer) => {
        if (request === latest.current) setResult(answer);
      },
      () => {
        if (request === latest.current) setResult("failed");
      },
    );
  }, [remote]);
  useEffect(() => setResult(undefined), [conversationId]);
  useEffect(() => {
    if (conversationId !== undefined && connected) refresh();
  }, [conversationId, connected, refresh]);
  // A run that settles may have left new changes.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && connected) refresh();
    wasBusy.current = busy;
  }, [busy, connected, refresh]);

  const stat: ChangeStat =
    result === undefined ? { kind: "loading" } : result === "failed" ? { kind: "failed" } : changeStatOf(result);
  const branch = branchOf(view, stat);
  return (
    <VStack className="h-full min-h-0" gap={0}>
      <SurfaceBar
        start={barStart}
        end={
          <>
            <IconButton
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
              label="Refresh changes"
              size="sm"
              variant="ghost"
              isDisabled={!connected || conversationId === undefined}
              onClick={refresh}
            />
            {barEnd}
          </>
        }
      >
        {branch === undefined ? null : (
          <span className="flex min-w-0 items-center gap-1 text-sm">
            <GitBranch className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">{branch}</span>
          </span>
        )}
        {stat.kind === "unavailable" ? null : (
          <span className="shrink-0 text-sm">
            <ChangeFigure stat={stat} />
            {stat.kind === "ready" && stat.files > 0 && (stat.additions > 0 || stat.deletions > 0) ? (
              <span className="text-muted">
                {" "}
                · {stat.files} file{stat.files === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
        )}
      </SurfaceBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <VStack gap={2} padding={3}>
          {conversationId === undefined ? (
            <Text type="supporting">Open a conversation to see what it changed.</Text>
          ) : result === undefined ? (
            <Text type="supporting">Loading…</Text>
          ) : result === "failed" ? (
            <Text type="supporting">Couldn't load the changes. Refresh to try again.</Text>
          ) : !result.available ? (
            <Text type="supporting">{result.reason}</Text>
          ) : (
            <>
              {view.checkout === undefined ? (
                <Text type="supporting">
                  These are the project directory's uncommitted changes, shared with other conversations working there.
                </Text>
              ) : null}
              {result.truncated ? <Text type="supporting">The diff is truncated; the rest is not shown.</Text> : null}
              <DiffView patch={result.patch} collapsible />
            </>
          )}
        </VStack>
      </div>
    </VStack>
  );
}
