import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { fakeRemote, PINOMAD, TASK, WEBSITE, withInbox } from "../../test/story-fixtures.tsx";
import { InboxScreen } from "./inbox-screen.tsx";

const view = withInbox();

const meta = {
  title: "Widgets/Inbox/InboxScreen",
  component: InboxScreen,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col">
        <Story />
      </div>
    ),
  ],
  args: { view, remote: fakeRemote(view), target: { project: WEBSITE.path }, onOpened: fn(), onOpenTask: fn() },
} satisfies Meta<typeof InboxScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A project's intake before its first message: sending it opens the intake (ADR-0051 §6). */
export const IntakeDraft: Story = {};

/** A task the worker has not taken yet: its event, its place in the queue, and Skip. */
export const QueuedTask: Story = { args: { target: { project: PINOMAD.path, task: TASK.queuedSecond } } };

const asking = withInbox(undefined, {
  externalSources: true,
  inboxes: [
    {
      project: WEBSITE.path,
      tasks: [
        {
          id: "nightly",
          title: "Nightly dependency check",
          createdAt: Date.now(),
          conversationId: 77 as never,
          events: [],
          closed: false,
          waiting: true,
          questions: [
            {
              kind: "question.requests",
              request: {
                id: "allow-1",
                askedAt: Date.now(),
                questions: [
                  {
                    header: "Allow",
                    question: "Run `bun update --latest`? It reached the network while the run had outside content.",
                    options: [{ label: "Allow" }, { label: "Deny" }],
                  },
                ],
              },
            },
          ],
        },
      ],
      threads: {},
      rules: "",
      followUps: [],
      sources: [],
    },
  ],
});

/** A scheduled task asks before anyone wrote to the intake: its question is answered here (#846). */
export const IntakeDraftWithTaskQuestion: Story = { args: { view: asking, remote: fakeRemote(asking) } };
