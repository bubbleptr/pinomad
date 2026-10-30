import { ChatLayout } from "@astryxdesign/core/Chat";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fn } from "storybook/test";
import type { DurableView } from "@pinomad/protocol/view.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import {
  fakeRemote,
  fakeView,
  HOME_HOST,
  PARSER_ID,
  PINOMAD,
  SELF,
  signedIn,
  summaryOf,
  withAccount,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";
import { ComposerSkeleton, ConversationSkeleton } from "../chat/conversation-skeleton.tsx";
import { ConversationComposer } from "../composer/conversation-composer.tsx";
import { DraftHome } from "../draft-home/draft-home.tsx";
import { AppFrame, FrameHeader, NoticeToasts } from "./app-frame.tsx";

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
        onFork={fn()}
        summaryOf={summaryOf}
      />
    </ChatLayout>
  );
}

/** Mimics Workbench: the frame owns the shell, this owns the header and column. */
function Body({
  view,
  remote,
  narrow,
  shownId,
  loading,
}: {
  view: DurableView;
  remote: RemoteDurable;
  narrow: boolean;
  shownId: ConversationId | undefined;
  loading: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <FrameHeader
        narrow={narrow}
        title={loading ? "A conversation that is opening" : "Fix the parser's trailing-comma bug"}
        parentSummary={undefined}
        onBackToParent={fn()}
        showOverview={shownId !== undefined}
        overviewOpen={false}
        onOverviewChange={fn()}
        panelOpen={false}
        onPanelChange={fn()}
        liveActivity={false}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MainColumn view={view} remote={remote} narrow={narrow} loading={loading} />
        </div>
      </div>
      <NoticeToasts notices={view.notices} />
    </div>
  );
}

const view = fakeView();

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
    view,
    remote: fakeRemote(view),
    device: SELF,
    hostKey: HOME_HOST.hostKey,
    draftingChat: false,
    shownId: PARSER_ID,
    onDraft: fn(),
    onOpen: fn(),
    onNewChat: fn(),
    narrow: false,
    children: null,
  },
  render: (args) => {
    const storyView = args.view ?? view;
    const storyRemote = args.remote ?? fakeRemote(storyView);
    return (
      <AppFrame {...args}>
        <Body
          view={storyView}
          remote={storyRemote}
          narrow={args.narrow}
          shownId={args.shownId}
          loading={args.shownId !== undefined && storyView.conversation === undefined}
        />
      </AppFrame>
    );
  },
} satisfies Meta<typeof AppFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {};

const drafting = fakeView({ conversation: undefined, home: undefined, checkout: undefined, docs: [] });
export const Drafting: Story = {
  args: {
    view: drafting,
    remote: fakeRemote(drafting),
    draftingChat: true,
    shownId: undefined,
  },
};

/** A conversation opened from the sidebar, before its view lands: title and selection move at once. */
const opening = fakeView({ conversation: undefined });
export const Opening: Story = {
  args: { view: opening, remote: fakeRemote(opening), shownId: PARSER_ID },
};

/** Every notice also lands as a toast. */
const noticed = fakeView({ notices: [{ id: 1, level: "error", message: "Model anthropic/claude-opus-5-5 is overloaded; retrying in 8s" }] });
export const WithNotice: Story = { args: { view: noticed, remote: fakeRemote(noticed) } };

/** On a phone the sidebar becomes a drawer behind the header's menu button. */
export const Narrow: Story = {
  args: { narrow: true },
};
