import { ChatLayout } from "@astryxdesign/core/Chat";
import type { Meta, StoryObj } from "@storybook/react-vite";
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
import { AppFrame } from "./app-frame.tsx";

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
    narrow: false,
    drafting: false,
    draftingChat: false,
    draftLabel: "New conversation",
    conversation: view.conversation,
    shownId: PARSER_ID,
    summary: summaryOf(PARSER_ID),
    parentSummary: undefined,
    onDraft: fn(),
    onOpenChanges: fn(),
    overviewOpen: false,
    onOverviewChange: fn(),
    panelOpen: false,
    panelTab: "threads",
    onPanelOpen: fn(),
    onPanelTab: fn(),
    openInPanel: fn(),
    openInMain: fn(),
    onOpen: fn(),
    children: null,
  },
  render: (args) => (
    <AppFrame {...args}>
      <MainColumn
        view={args.view}
        remote={args.remote}
        narrow={args.narrow}
        loading={args.conversation === undefined && args.shownId !== undefined}
      />
    </AppFrame>
  ),
} satisfies Meta<typeof AppFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {};

export const WithOverviewAndPanel: Story = { args: { overviewOpen: true, panelOpen: true } };

const drafting = fakeView({ conversation: undefined, home: undefined, checkout: undefined, docs: [] });
export const Drafting: Story = {
  args: { view: drafting, remote: fakeRemote(drafting), drafting: true, conversation: undefined, shownId: undefined, summary: undefined },
};

/** A conversation opened from the sidebar, before its view lands: title and selection move at once. */
export const Opening: Story = { args: { conversation: undefined } };

/** Every notice also lands as a toast. */
const noticed = fakeView({ notices: [{ id: 1, level: "error", message: "Model anthropic/claude-opus-5-5 is overloaded; retrying in 8s" }] });
export const WithNotice: Story = { args: { view: noticed, remote: fakeRemote(noticed) } };

/** On a phone the sidebar becomes a drawer behind the header's menu button. */
export const Narrow: Story = {
  args: { narrow: true },
};
