import { Redirect, Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Menu, Separator } from "heroui-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { useActiveRemote } from "../shared/lib/active-remote.ts";
import { useDurableView } from "../shared/lib/use-remote.ts";
import { createAndShow } from "../shared/lib/conversation-commands.ts";
import { useKeyboardVisible } from "../shared/lib/use-keyboard-visible.ts";
import { takeAddedProject } from "../shared/lib/pending-project.ts";
import { ComposeBar, PlusMenu } from "../features/compose/composer.tsx";
import { LocationChip, LocationRow } from "../entities/checkout/location-row.tsx";
import { useImageAttachments } from "../entities/image/use-image-attachments.ts";
import { summaryOf } from "@pinomad/client/model.ts";
import { ModelSheet } from "../entities/model/model-sheet.tsx";
import { useDraftModelPick } from "../entities/model/use-draft-model-pick.ts";
import { ChatAdd, Computer, FolderClosed, FolderLibrary } from "../shared/ui/icons.tsx";

const CHAT: Home = { kind: "chat" };
type CheckoutMode = "worktree" | "local";

export default function NewConversationScreen() {
  const remote = useActiveRemote();
  if (remote === undefined) return <Redirect href="/" />;
  return <NewConversationBody remote={remote} />;
}

/** Draft-home's project picker as a location chip + popover menu. */
function ProjectMenu({
  home,
  onChange,
  disabled,
  projects,
}: {
  home: Home;
  onChange: (home: Home) => void;
  disabled: boolean;
  projects: readonly { path: string; name: string }[];
}) {
  const router = useRouter();
  const label =
    home.kind === "chat" ? "Chat" : (projects.find((project) => project.path === home.path)?.name || home.path);
  return (
    <Menu>
      <Menu.Trigger asChild isDisabled={disabled}>
        <LocationChip
          icon={home.kind === "chat" ? ChatAdd : FolderClosed}
          label={label}
          onPress={() => {}}
          testID="draft-project"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Overlay />
        <Menu.Content presentation="popover" placement="top" align="start" width={220}>
          <Menu.Item onPress={() => onChange(CHAT)}>
            <Menu.ItemTitle>No project</Menu.ItemTitle>
          </Menu.Item>
          {projects.map((project) => (
            <Menu.Item key={project.path} onPress={() => onChange({ kind: "project", path: project.path })}>
              <Menu.ItemTitle>{project.name || project.path}</Menu.ItemTitle>
            </Menu.Item>
          ))}
          <Separator style={{ marginVertical: 4 }} />
          <Menu.Item onPress={() => router.push("/add-project")}>
            <Menu.ItemTitle>Add project…</Menu.ItemTitle>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  );
}

/** Draft-home's CheckoutStrategyPicker: worktree (ADR-0010 default) vs project dir. */
function CheckoutMenu({
  mode,
  onChange,
  disabled,
}: {
  mode: CheckoutMode;
  onChange: (mode: CheckoutMode) => void;
  disabled: boolean;
}) {
  return (
    <Menu>
      <Menu.Trigger asChild isDisabled={disabled}>
        <LocationChip
          icon={mode === "worktree" ? FolderLibrary : Computer}
          label={mode === "worktree" ? "Git worktree" : "Project folder"}
          onPress={() => {}}
          testID="draft-checkout"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Overlay />
        <Menu.Content presentation="popover" placement="top" align="start" width={220}>
          <Menu.Item onPress={() => onChange("worktree")}>
            <Menu.ItemTitle>Git worktree</Menu.ItemTitle>
          </Menu.Item>
          <Menu.Item onPress={() => onChange("local")}>
            <Menu.ItemTitle>Project folder</Menu.ItemTitle>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  );
}

function NewConversationBody({ remote }: { remote: RemoteDurable }) {
  const router = useRouter();
  const view = useDurableView(remote);
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [home, setHome] = useState<Home>(CHAT);
  // The picker hands its added project here in memory; landing back on /new
  // with it selects that project for the draft.
  useFocusEffect(
    useCallback(() => {
      const added = takeAddedProject();
      if (added !== undefined) setHome({ kind: "project", path: added });
    }, []),
  );
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("worktree");
  const [sending, setSending] = useState(false);
  const { pick, setModel, setLevel } = useDraftModelPick(view);

  const projects = view.organized.projects.map((entry) => entry.project);
  const connected = view.connection === "connected";
  const model = summaryOf(view.models, pick.model);
  const accepts = model?.images === true;
  const { images, pending, error, freeSlots, add, remove, report } = useImageAttachments(accepts);

  // Failure rejects so ComposeBar keeps the draft; the notice toast carries
  // the host's reason.
  const send = async (text: string, sendImages: readonly MessageImage[]): Promise<void> => {
    setSending(true);
    try {
      const id = await createAndShow(remote, home, text, {
        ...(home.kind === "project" && checkoutMode === "local" ? { checkout: "project" as const } : {}),
        ...(pick.model === undefined ? {} : { model: pick.model }),
        thinkingLevel: pick.level,
        ...(sendImages.length === 0 ? {} : { images: sendImages }),
      });
      router.replace(`/conversation/${id}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "New conversation" }} />
      <KeyboardAvoidingView
        className="bg-background"
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <View style={{ flex: 1, padding: 16, gap: 16, paddingBottom: keyboardVisible ? 16 : insets.bottom + 16 }}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
            <Text className="text-foreground" style={{ fontSize: 24, textAlign: "center" }}>
              Build something useful with PiNomad
            </Text>
          </View>
          <ComposeBar
            disabled={!connected || sending}
            expanded
            autoFocus
            placeholder="Do anything with Pi"
            onSubmit={(text, _whenBusy, sendImages) => send(text, sendImages)}
            attachments={{ images, pending, error, onRemove: remove }}
            startAction={
              <PlusMenu
                connected={connected}
                attach={{
                  accepts,
                  reason: model?.name ?? pick.model?.modelId ?? "This model",
                  freeSlots,
                  add,
                  report,
                }}
              />
            }
            modelAction={
              <ModelSheet
                models={view.models}
                selected={{ model: pick.model, level: pick.level }}
                isDisabled={!connected}
                onModelChange={setModel}
                onLevelChange={setLevel}
              />
            }
            footer={
              <LocationRow>
                <ProjectMenu home={home} onChange={setHome} disabled={!connected} projects={projects} />
                {home.kind === "project" ? (
                  <CheckoutMenu mode={checkoutMode} onChange={setCheckoutMode} disabled={!connected} />
                ) : null}
              </LocationRow>
            }
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
