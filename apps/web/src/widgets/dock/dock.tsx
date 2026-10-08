import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { AgentState } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { queueItems, taskRows, usageRows } from "../../presentation/chat.ts";
import { DocumentView } from "../../presentation/documents.tsx";

/** Desktop dock: the live-state panel docked to the right of the chat column. */
export function DockPanel({
  view,
  remote,
  conversation,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: DurableView["conversation"];
}) {
  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l border-border p-3" aria-label="Live state">
      <LiveState view={view} remote={remote} conversation={conversation} />
    </div>
  );
}

/** Narrow dock: the same live state in a dialog. */
export function DockDialog({
  open,
  onOpenChange,
  view,
  remote,
  conversation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: DurableView;
  remote: RemoteDurable;
  conversation: DurableView["conversation"];
}) {
  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange} width={360}>
      <Layout
        header={<DialogHeader title="Live state" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <LiveState view={view} remote={remote} conversation={conversation} />
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

const agentOf = (conversation: NonNullable<DurableView["conversation"]>): AgentState =>
  (conversation.docs["pi.agent"] ?? {}) as AgentState;

export function LiveState({
  view,
  remote,
  conversation,
}: {
  view: DurableView;
  remote: RemoteDurable;
  conversation: DurableView["conversation"];
}) {
  const rows = view.tasks === undefined ? [] : taskRows(view.tasks);
  const queue = view.conversation === undefined ? [] : queueItems(view.conversation);
  const notices = [...view.notices].reverse().slice(0, 5);
  const usage = view.conversation === undefined ? [] : usageRows(view.conversation);
  const branch = conversation === undefined ? undefined : view.checkout?.branch;
  const cwd = conversation === undefined ? undefined : agentOf(conversation).cwd;
  return (
    <VStack gap={4}>
      {conversation === undefined || (branch === undefined && cwd === undefined) ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Workspace</Text>}>
          {branch === undefined ? null : <ListItem label="Branch" description={branch} />}
          {cwd === undefined ? null : <ListItem label="Path" description={cwd} />}
        </List>
      )}
      {view.docs.map((doc) => (
        <DocumentView key={doc.kind} doc={doc} remote={remote} connected={view.connection === "connected"} />
      ))}
      <List density="compact" header={<Text type="label" weight="semibold">Tasks</Text>}>
        {rows.length === 0 ? (
          <ListItem label="No live tasks" />
        ) : (
          rows.map((row) => <ListItem key={row.id} label={`${"  ".repeat(row.depth)}${row.depth > 0 ? "└ " : ""}${row.label}`} />)
        )}
      </List>
      <List density="compact" header={<Text type="label" weight="semibold">Queue</Text>}>
        {queue.length === 0 ? (
          <ListItem label="Empty" />
        ) : (
          queue.map((item) => <ListItem key={item.id} label={item.text} startContent={<Token label={item.mode} size="sm" />} />)
        )}
      </List>
      {notices.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Notices</Text>}>
          {notices.map((notice) => (
            <ListItem
              key={notice.id}
              label={notice.message}
              startContent={
                <StatusDot variant={notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "neutral"} label={notice.level} />
              }
            />
          ))}
        </List>
      )}
      {usage.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Usage</Text>}>
          {usage.map((row) => (
            <ListItem key={row.key} label={row.key} description={`↑${row.input} ↓${row.output} · $${row.cost.toFixed(4)}`} />
          ))}
        </List>
      )}
      <McpSection view={view} />
    </VStack>
  );
}

const MCP_VARIANT = { connecting: "warning", connected: "success", failed: "error", disabled: "neutral" } as const;

/** The host's MCP servers (ADR-0012): per-server state and config errors; hidden when MCP is off. */
function McpSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  if (mcp === null || (mcp.servers.length === 0 && mcp.errors.length === 0)) return null;
  return (
    <List density="compact" header={<Text type="label" weight="semibold">MCP</Text>}>
      {mcp.servers.map((server) => (
        <ListItem
          key={server.name}
          label={server.name}
          description={
            server.state === "connected"
              ? `${server.tools} tool${server.tools === 1 ? "" : "s"}${server.error === undefined ? "" : ` · ${server.error}`}`
              : (server.error ?? server.state)
          }
          startContent={<StatusDot variant={MCP_VARIANT[server.state]} label={server.state} isPulsing={server.state === "connecting"} />}
        />
      ))}
      {mcp.errors.map((error, index) => (
        <ListItem key={index} label={error} startContent={<StatusDot variant="error" label="config error" />} />
      ))}
    </List>
  );
}
