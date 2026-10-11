// The host's top-level conversations: chats, then one section per project —
// forks and subagents are nested inside their owner and get no row of their
// own (a later PR). Rows show the summary name, the family's most urgent
// status, and its freshest update; tapping one opens the conversation.
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Chip } from "heroui-native";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { displayName, familyStatus, familyUpdatedAt, relativeTime, type FamilyStatus } from "@pinomad/client/family.ts";
import { useNow } from "../../shared/lib/use-now.ts";

const STATUS_CHIP: Record<FamilyStatus, { color: "warning" | "danger" | "accent"; label: string }> = {
  "needs-answer": { color: "warning", label: "Waiting" },
  failed: { color: "danger", label: "Failed" },
  running: { color: "accent", label: "Running" },
};

function ConversationRow({ node, now }: { node: ConversationNode; now: number }) {
  const router = useRouter();
  const status = familyStatus(node);
  const updatedAt = familyUpdatedAt(node);
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
    </Pressable>
  );
}

function Section({ title, nodes, now }: { title: string; nodes: readonly ConversationNode[]; now: number }) {
  if (nodes.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text className="text-muted" style={{ fontSize: 13, fontWeight: "600", paddingHorizontal: 4, paddingBottom: 4 }}>
        {title}
      </Text>
      {nodes.map((node) => (
        <ConversationRow key={node.summary.id} node={node} now={now} />
      ))}
    </View>
  );
}

export function ConversationList({ view }: { view: DurableView }) {
  const now = useNow();
  const empty = view.organized.chats.length === 0 && view.organized.projects.every((entry) => entry.conversations.length === 0);
  return (
    <View style={{ gap: 16 }}>
      <Section title="Chats" nodes={view.organized.chats} now={now} />
      {view.organized.projects.map((entry) => (
        <Section
          key={entry.project.path}
          title={entry.project.name || entry.project.path.split("/").filter(Boolean).pop() || entry.project.path}
          nodes={entry.conversations}
          now={now}
        />
      ))}
      {empty ? (
        <Text className="text-muted" style={{ textAlign: "center", paddingVertical: 24 }}>
          No conversations on this host yet.{"\n"}Tap New to start one.
        </Text>
      ) : null}
    </View>
  );
}
