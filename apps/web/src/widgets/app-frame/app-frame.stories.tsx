import { ChatLayout } from "@/shared/ui/chat-kit";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { useState, type ComponentProps } from "react";
import { fn } from "storybook/test";
import type { DurableView } from "@pinomad/protocol/view.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import {
  fakeRemote,
  fakeView,
  fakeMachines,
  HOME_HOST,
  PARSER_ID,
  PINOMAD,
  signedIn,
  summaryOf,
  withAccount,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";
import { ComposerSkeleton, ConversationSkeleton } from "../chat/conversation-skeleton.tsx";
import { ConversationComposer } from "../composer/conversation-composer.tsx";
import { DraftHome } from "../draft-home/draft-home.tsx";
import { SidePanel, SurfaceButtons, type PanelSurface } from "../side-panel/side-panel.tsx";
import { AppFrame, FrameHeader } from "./app-frame.tsx";

/**
 * The main column App puts inside the frame: the transcript over its
 * composer, the skeleton while an opened conversation loads, or the draft screen.
 */
function MainColumn({
  view,
  remote,
  narrow,
  loading,
}: {
  view: DurableView;
  remote: RemoteDurable;
  narrow: boolean;
  loading: boolean;
}) {
  const conversation = view.conversation;
  if (loading) {
    return (
      <ChatLayout
        style={{ flex: 1, minHeight: 0 }}
        composer={
          <div className="mx-auto w-full max-w-[44rem]">
            <ComposerSkeleton />
          </div>
        }
      >
        <ConversationSkeleton />
      </ChatLayout>
    );
  }
  if (conversation === undefined) {
    return (
      <DraftHome view={view} remote={remote} hostKey={HOME_HOST.hostKey} draft={{ kind: "project", path: PINOMAD.path }} onDraft={fn()} onCreated={fn()} connected />
    );
  }
  return (
    <ChatLayout
      style={{ flex: 1, minHeight: 0 }}
      composer={
        <div className="mx-auto w-full max-w-[44rem]">
          <ConversationComposer view={view} remote={remote} conversation={conversation} busy={false} narrow={narrow} />
        </div>
      }
    >
      <ConversationTranscript
        conversation={conversation}
        docs={view.docs}
        toolPresentations={view.toolPresentations}
        connected={view.connection === "connected"}
        canFork
        openInPanel={fn()}
        onOpenFork={fn()}
        onFork={fn()}
        summaryOf={summaryOf}
      />
    </ChatLayout>
  );
}

/**
 * Mimics Workbench: the frame owns the shell, this owns the header over the
 * chat column and the full-height side panel beside it.
 */
function Body({
  view,
  remote,
  narrow,
  shownId,
  loading,
  initialPanelOpen = false,
}: {
  view: DurableView;
  remote: RemoteDurable;
  narrow: boolean;
  shownId: ConversationId | undefined;
  loading: boolean;
  initialPanelOpen?: boolean;
}) {
  const [panelOpen, setPanelOpen] = useState(initialPanelOpen);
  const [surface, setSurface] = useState<PanelSurface>("tasks");
  const select = (next: PanelSurface): void => {
    setSurface(next);
    setPanelOpen(!(panelOpen && next === surface));
  };
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="flex min-h-0 min-w-[20rem] flex-1 flex-col">
      <FrameHeader
        narrow={narrow}
        title={loading ? "A conversation that is opening" : "Fix the parser's trailing-comma bug"}
        parentSummary={undefined}
        onBackToParent={fn()}
        showOverview={shownId !== undefined}
        overviewOpen={false}
        onOverviewChange={fn()}
        panelControls={
          <SurfaceButtons narrow={narrow} open={panelOpen} surface={surface} liveActivity onSelect={select} />
        }
      />
        <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MainColumn view={view} remote={remote} narrow={narrow} loading={loading} />
        </div>
      </div>
      <SidePanel
        view={view}
        remote={remote}
        shownId={shownId}
        narrow={narrow}
        open={panelOpen}
        surface={surface}
        busy={false}
        liveActivity
        onOpenChange={setPanelOpen}
        onSelectSurface={select}
        openInPanel={fn()}
        onOpenInMain={fn()}
      />
    </div>
  );
}

const view = fakeView();

function renderFrame(args: ComponentProps<typeof AppFrame>, initialPanelOpen = false) {
  const storyView = args.machines.find((machine) => machine.key === args.focusKey)?.view ?? view;
  const storyRemote = fakeRemote(storyView);
  return (
    <AppFrame {...args}>
      <Body
        view={storyView}
        remote={storyRemote}
        narrow={args.narrow}
        shownId={args.shownId}
        loading={args.shownId !== undefined && storyView.conversation === undefined}
        initialPanelOpen={initialPanelOpen}
      />
    </AppFrame>
  );
}

const meta = {
  title: "Widgets/AppFrame/AppFrame",
  component: AppFrame,
  decorators: [
    withHosts(),
    withAccount(signedIn()),
    // The shell is viewport-sized, so it bleeds over the canvas padding.
    (Story) => (
      <div className="-m-6 h-screen">
        <Story />
      </div>
    ),
  ],
  parameters: { canvasWidth: "full" },
  args: {
    machines: fakeMachines(),
    focusKey: HOME_HOST.hostKey,
    draftingChat: false,
    shownId: PARSER_ID,
    onDraft: fn(),
    onOpen: fn(),
    onNewChat: fn(),
    onShowMachine: fn(),
    narrow: false,
    children: null,
  },
  render: (args) => renderFrame(args),
} satisfies Meta<typeof AppFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {};

/** The side panel runs full height beside the chat column; its first row meets the header's border. */
export const WithSidePanel: Story = { render: (args) => renderFrame(args, true) };

const drafting = fakeView({ conversation: undefined, home: undefined, checkout: undefined, docs: [] });
export const Drafting: Story = {
  args: {
    machines: fakeMachines({ home: drafting }),
    draftingChat: true,
    shownId: undefined,
  },
};

/** A conversation opened from the sidebar, before its view lands: title and selection move at once. */
const opening = fakeView({ conversation: undefined });
export const Opening: Story = {
  args: { machines: fakeMachines({ home: opening }), shownId: PARSER_ID },
};

/** Every notice also lands as a toast. */
const noticed = fakeView({ notices: [{ id: 1, level: "error", message: "Model anthropic/claude-opus-5-5 is overloaded; retrying in 8s" }] });
export const WithNotice: Story = { args: { machines: fakeMachines({ home: noticed }) } };

/** On a phone the sidebar becomes a drawer behind the header's menu button. */
export const Narrow: Story = {
  args: { narrow: true },
};
