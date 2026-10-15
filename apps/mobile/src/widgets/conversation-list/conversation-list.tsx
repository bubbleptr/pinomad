// The host's top-level conversations: chats, then one section per project —
// forks and subagents are nested inside their owner and get no row of their
// own (a later PR). Rows show the summary name, the family's most urgent
// status, and its freshest update; tapping one opens the conversation.
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Chip, Menu } from "heroui-native";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import { displayName, familyStatus, familyUpdatedAt, relativeTime, type FamilyStatus } from "@pinomad/client/family.ts";
import { useNow } from "../../shared/lib/use-now.ts";
import { useCSSVariable } from "uniwind";
import { ChevronRight, FolderClosed, MoreHorizontal } from "../../shared/ui/icons.tsx";
import { RenameConversationSheet } from "../../features/rename-conversation/rename-sheet.tsx";

const STATUS_CHIP: Record<FamilyStatus, { color: "warning" | "danger" | "accent"; label: string }> = {
  "needs-answer": { color: "warning", label: "Waiting" },
  failed: { color: "danger", label: "Failed" },
  running: { color: "accent", label: "Running" },
};

function ConversationRow({
  node,
  now,
  connected,
  canRename,
  onRename,
}: {
  node: ConversationNode;
  now: number;
  connected: boolean;
  canRename: boolean;
  onRename(node: ConversationNode): void;
}) {
  const router = useRouter();
  const muted = useCSSVariable("--muted") as string | undefined;
  const status = familyStatus(node);
  const updatedAt = familyUpdatedAt(node);
  // Menu items record what to run; the sheet opens once the menu reports
  // closed — presenting it while the menu's overlay is still dismissing can
  // drop the presentation (see the composer's PlusMenu).
  const afterClose = useRef<(() => void) | null>(null);
  const onMenuOpenChange = (open: boolean): void => {
    if (open) return;
    const action = afterClose.current;
    afterClose.current = null;
    if (action !== null) requestAnimationFrame(action);
  };
  return (
    <Pressable
      onPress={() => router.push(`/conversation/${node.summary.id}`)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 10,
        paddingHorizontal: 4,
        borderRadius: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text className="text-foreground" style={{ flex: 1, fontSize: 16 }} numberOfLines={1}>
        {displayName(node.summary)}
      </Text>
      {status === undefined ? null : (
        <Chip size="sm" color={STATUS_CHIP[status].color} variant="soft">
          {STATUS_CHIP[status].label}
        </Chip>
      )}
      {updatedAt === undefined ? null : (
        <Text className="text-muted" style={{ fontSize: 13 }}>
          {relativeTime(updatedAt, now)}
        </Text>
      )}
      {canRename ? (
        <Menu onOpenChange={onMenuOpenChange}>
          <Menu.Trigger
            accessibilityRole="button"
            accessibilityLabel="Conversation actions"
            hitSlop={4}
            isDisabled={!connected}
            style={{ padding: 4, opacity: connected ? 1 : 0.4 }}
          >
            <MoreHorizontal size={16} color={muted} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Overlay />
            <Menu.Content presentation="popover" placement="bottom" align="end" width={180}>
              <Menu.Item onPress={() => (afterClose.current = () => onRename(node))}>
                <Menu.ItemTitle>Rename</Menu.ItemTitle>
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      ) : null}
    </Pressable>
  );
}

function Section({
  title,
  nodes,
  now,
  connected,
  canRename,
  onRename,
}: {
  title: string;
  nodes: readonly ConversationNode[];
  now: number;
  connected: boolean;
  canRename: boolean;
  onRename(node: ConversationNode): void;
}) {
  if (nodes.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text className="text-muted" style={{ fontSize: 13, fontWeight: "600", paddingHorizontal: 4, paddingBottom: 4 }}>
        {title}
      </Text>
      {nodes.map((node) => (
        <ConversationRow
          key={node.summary.id}
          node={node}
          now={now}
          connected={connected}
          canRename={canRename}
          onRename={onRename}
        />
      ))}
    </View>
  );
}

export function ConversationList({
  view,
  remote,
  onAddProject,
}: {
  view: DurableView;
  remote: RemoteDurable;
  onAddProject?(): void;
}) {
  const now = useNow();
  const muted = useCSSVariable("--muted") as string | undefined;
  const connected = view.connection === "connected";
  // Pre-5.4 hosts never heard of renameConversation; hide the affordance
  // instead of offering an action that can only fail.
  const canRename = hostSupportsCall(view.host?.protocol.minor ?? 0, "renameConversation");
  // One sheet for all rows, mounted once at list level: gorhom's sheet only
  // expands on an isOpen false→true edge, so the BottomSheet must not mount
  // already-open. The form inside remounts per open for a fresh draft.
  const [renameTarget, setRenameTarget] = useState<ConversationNode | undefined>(undefined);
  const [renameOpen, setRenameOpen] = useState(false);
  const onRename = (node: ConversationNode): void => {
    setRenameTarget(node);
    setRenameOpen(true);
  };
  const empty = view.organized.chats.length === 0 && view.organized.projects.every((entry) => entry.conversations.length === 0);
  return (
    <View style={{ gap: 16 }}>
      <Section
        title="Chats"
        nodes={view.organized.chats}
        now={now}
        connected={connected}
        canRename={canRename}
        onRename={onRename}
      />
      {view.organized.projects.map((entry) => (
        <Section
          key={entry.project.path}
          title={entry.project.name || entry.project.path.split("/").filter(Boolean).pop() || entry.project.path}
          nodes={entry.conversations}
          now={now}
          connected={connected}
          canRename={canRename}
          onRename={onRename}
        />
      ))}
      {view.organized.projects.length === 0 && onAddProject !== undefined ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAddProject}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 10,
            paddingHorizontal: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <FolderClosed size={16} color={muted} />
          <Text className="text-foreground" style={{ flex: 1, fontSize: 16 }}>
            Add project
          </Text>
          <ChevronRight size={14} color={muted} />
        </Pressable>
      ) : null}
      {empty ? (
        <Text className="text-muted" style={{ textAlign: "center", paddingVertical: 24 }}>
          No conversations on this host yet.{"\n"}Tap New to start one.
        </Text>
      ) : null}
      {canRename ? (
        <RenameConversationSheet
          summary={renameTarget?.summary}
          remote={remote}
          connected={connected}
          isOpen={renameOpen}
          onOpenChange={setRenameOpen}
        />
      ) : null}
    </View>
  );
}
